// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE NAMES OF THE RECORDS A CALL NAMES BY ID.
//
// A person deciding an approval recognises a deal by its title and an agreement by its name, never
// by a uuid. The params of a call say which kind of record an id is (`taskId`, `project_id`,
// `assigneeId`, or `id` for the record the tool acts on), and the app's manifest says where that
// kind keeps its name.
//
// A CARD IS READ BY PEOPLE WHO DO NOT READ THE SAME RECORDS, so no name is stored on it. What is
// stored says what kind of record it is ("a task"), and beside it the form that names it, by id
// (`summary.names`). The name is read when the card is served, with the READER's own access
// (`withViewerNames`): row level security, the kind's read scope, and the app being theirs. A
// reminder, a push, a digest or a mail goes to whom it goes with nobody reading: it keeps the
// stored words.
//
// What is never named, whoever reads: a record closed to the organization (a restricted document, a
// company or a contact shared by name), and what may be one person's own (mail, calendar, Drive).
import type { ApprovalSummary } from "@liaison/shared"
import { approvalSummaryLineMax } from "@liaison/shared"
import { and, sql as drizzleSql, eq, inArray } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { companies, contacts, users } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { isRecord } from "~/lib/guards"
import { appsLogger as log } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { isUuid } from "~/lib/uuid"
import { currentRunContext } from "~/modules/agent/runtime/run-context"
import { splitToolName } from "~/modules/approvals/tool-name"
import { entityRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { RECORD_TOKEN, type RecordRef } from "~/modules/apps/approval-record-token"
import { isAppUnavailableFor } from "~/modules/apps/org-apps"
import { hasScope } from "~/modules/permissions/permissions"
import { RESTRICTED_ENTITY_KINDS } from "~/modules/permissions/restricted-scope"

export type RecordRefs = ReadonlyMap<string, RecordRef>

export const NO_REFS: RecordRefs = new Map()

/** Records looked up for one card, and the kinds tried for one id. */
const MAX_IDS = 12
const MAX_KINDS = 6
const MAX_NAME_CHARS = 120
/** The texts of one card that may hold a record. */
const MAX_TEXTS = 60

/** The kernel's own records a card names; the apps' kinds come from their manifests. */
const KERNEL_KINDS: ReadonlySet<string> = new Set(["user", "company", "contact"])

/** Apps whose records may be one person's own: a decider may not see what the requester can. */
const PERSONAL_APPS: ReadonlySet<string> = new Set(["mail", "calendar", "google-drive"])

/** Param words that name a person of the organization, whatever the app. */
const PERSON_WORDS: ReadonlySet<string> = new Set([
  "user",
  "assignee",
  "owner",
  "person",
  "member",
  "manager",
  "biller",
  "approver",
  "reviewer",
])

/** A parameter name as words, its id suffix dropped: "parentTaskIds" -> ["parent", "task"]. */
export function recordWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\-.\s]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
    .filter((w, i, all) => !(i === all.length - 1 && (w === "id" || w === "ids")))
}

interface Kind {
  app: string
  entityType: string
}

/** The entity kinds registered for the org and everywhere, the tool's own app first. */
function knownKinds(orgId: string, app: string): Kind[] {
  const all: Kind[] = []
  for (const scope of [orgId, "*"]) {
    for (const [[, entryApp, entityType]] of entityRegistry.entriesOf(scope)) {
      if (PERSONAL_APPS.has(entryApp)) continue
      // A part of a record that can be closed (a version of an agreement) says nothing of its own.
      const closable = RESTRICTED_ENTITY_KINDS.some((k) => k.startsWith(`${entryApp}.`))
      if (closable && !RESTRICTED_ENTITY_KINDS.includes(`${entryApp}.${entityType}`)) continue
      if (all.some((k) => k.app === entryApp && k.entityType === entityType)) continue
      all.push({ app: entryApp, entityType })
    }
  }
  return [...all.filter((k) => k.app === app), ...all.filter((k) => k.app !== app)]
}

/** The kinds an id under `key` can be, likeliest first. */
function kindsOf(orgId: string, toolName: string, key: string): Kind[] {
  const { appName, toolShortName } = splitToolName(toolName)
  const words = recordWords(key)
  const kinds = knownKinds(orgId, appName)
  if (words.length === 0) {
    // The record the tool acts on: the kind it declares, else one of its app's kinds.
    const declared = toolRegistry.get([orgId, appName, toolShortName])?.restrictedRows?.kind
    const [app, entityType] = declared?.split(".") ?? []
    return [
      ...(app && entityType ? [{ app, entityType }] : []),
      ...kinds.filter((k) => k.app === appName && k.entityType !== entityType),
    ].slice(0, MAX_KINDS)
  }
  const last = words[words.length - 1] as string
  const out: Kind[] = []
  if (PERSON_WORDS.has(last)) out.push({ app: "kernel", entityType: "user" })
  // "sourceTicket" is a ticket: the last words of the param are the kind's own words.
  const tail = words.join("_")
  for (const k of kinds) {
    const name = recordWords(k.entityType).join("_")
    if (tail === name || tail.endsWith(`_${name}`)) out.push(k)
  }
  if (last === "contact" || last === "company") out.unshift({ app: "kernel", entityType: last })
  return out.slice(0, MAX_KINDS)
}

/** Every id of the params, with the key it stands under. */
function idsOf(params: unknown, key = ""): Array<{ key: string; id: string }> {
  if (isUuid(params)) return [{ key, id: params }]
  if (Array.isArray(params)) return params.flatMap((v) => idsOf(v, key))
  if (!isRecord(params)) return []
  return Object.entries(params).flatMap(([k, v]) => idsOf(v, k))
}

/** Whether the kind has this record, read with `tx`'s own access. */
async function isOfKind(tx: RlsClient, orgId: string, k: Kind, id: string): Promise<boolean> {
  if (k.app === "kernel" && KERNEL_KINDS.has(k.entityType)) {
    const table =
      k.entityType === "user" ? users : k.entityType === "company" ? companies : contacts
    const [row] = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, id), eq(table.orgId, orgId)))
      .limit(1)
    return row !== undefined
  }
  const { resolveEntityLabel } = await import("~/modules/threads/reference-display")
  return (
    (await resolveEntityLabel(tx, {
      orgId,
      app: k.app,
      entityType: k.entityType,
      entityId: id,
    })) !== null
  )
}

/**
 * The records `params` names by id, found with the access of whoever asked. Each lookup is its own
 * savepoint, so a kind that cannot be read never costs the caller its transaction; an id nothing
 * names is absent.
 */
export async function resolveRecordRefs(
  ctx: { tx?: RlsClient; orgId?: string },
  toolName: string,
  params: unknown,
): Promise<RecordRefs> {
  const { tx, orgId } = ctx
  if (!tx || !orgId || typeof tx.transaction !== "function") return NO_REFS
  const out = new Map<string, RecordRef>()
  const seen = new Set<string>()
  for (const { key, id } of idsOf(params)) {
    if (seen.has(id) || seen.size >= MAX_IDS) continue
    seen.add(id)
    for (const kind of kindsOf(orgId, toolName, key)) {
      const found = await tx
        .transaction((sp) => isOfKind(sp as unknown as RlsClient, orgId, kind, id))
        .catch(() => false)
      if (!found) continue
      out.set(id, { ...kind, id })
      break
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// A record in a card's text
// ---------------------------------------------------------------------------

/** `text` with what stands outside its records rewritten. */
export function outsideTokens(text: string, rewrite: (part: string) => string): string {
  let out = ""
  let at = 0
  for (const m of text.matchAll(RECORD_TOKEN)) {
    out += rewrite(text.slice(at, m.index)) + m[0]
    at = m.index + m[0].length
  }
  return out + rewrite(text.slice(at))
}

const words = (entityType: string): string =>
  recordWords(entityType)
    .join(" ")
    .replace(/^user$/, "person") || "record"

const withArticle = (noun: string): string => `${/^[aeiou]/.test(noun) ? "an" : "a"} ${noun}`

/** What a record is called for a reader who may not read it: its kind. */
export function kindName(entityType: string): string {
  return withArticle(words(entityType))
}

function replaceTokens(text: string, say: (ref: RecordRef) => string): string {
  return text.replace(RECORD_TOKEN, (_m, app: string, entityType: string, id: string) =>
    say({ app, entityType, id }),
  )
}

const say = (ref: RecordRef): string => kindName(ref.entityType)

/** A title as everyone may read it: the record it is about is left out when it only adds its name. */
function plainTitle(title: string): string {
  return replaceTokens(title.replace(new RegExp(`:\\s*${RECORD_TOKEN.source}\\s*$`), ""), say)
}

function plainSubtitle(subtitle: string): string {
  const bare = subtitle.replace(RECORD_TOKEN, "").replace(/[,\s]/g, "")
  return bare === "" && subtitle.match(RECORD_TOKEN)
    ? "Pending approval"
    : replaceTokens(subtitle, say)
}

/**
 * The card as it is stored: each text in the words everyone may read, and beside them, for the
 * texts that hold a record, the form that names it. `bound` cuts the texts to the card's limits.
 */
export function asStoredSummary(
  made: ApprovalSummary,
  bound: (summary: ApprovalSummary) => ApprovalSummary,
): ApprovalSummary {
  const stored = bound({
    ...made,
    title: plainTitle(made.title),
    ...(made.subtitle !== undefined ? { subtitle: plainSubtitle(made.subtitle) } : {}),
    lines: made.lines.map((line) => replaceTokens(line, say)),
  })
  const names = [
    { named: made.title, shown: stored.title },
    { named: made.subtitle ?? "", shown: stored.subtitle ?? "" },
    ...stored.lines.map((shown, i) => ({ named: made.lines[i] ?? "", shown })),
  ].filter(({ named }) => named.match(RECORD_TOKEN))
  return names.length > 0 ? { ...stored, names: names.slice(0, MAX_TEXTS) } : stored
}

/** The card's stored words alone, as they go to many readers at once: not the form that names. */
export function withoutNames<T>(summary: T): T {
  if (!isRecord(summary) || !("names" in summary)) return summary
  const { names: _names, ...rest } = summary
  return rest as T
}

// ---------------------------------------------------------------------------
// The reader's own names
// ---------------------------------------------------------------------------

type Say = (ref: RecordRef) => string

const refKey = (ref: RecordRef): string => `${ref.app}:${ref.entityType}:${ref.id.toLowerCase()}`

function refsIn(text: string, into: Map<string, RecordRef>): void {
  replaceTokens(text, (ref) => {
    into.set(refKey(ref), ref)
    return ""
  })
}

interface NamedText {
  shown: string
  named: string
}

function namedTexts(summary: unknown): NamedText[] {
  const names = isRecord(summary) ? summary.names : undefined
  return Array.isArray(names)
    ? names.filter(
        (n): n is NamedText =>
          isRecord(n) && typeof n.shown === "string" && typeof n.named === "string",
      )
    : []
}

interface Reader {
  userId: string | null
  scopes: string[]
}

/** Who reads through `tx`, or null when nobody's access stands behind it (a privileged read). */
async function readerOf(tx: RlsClient): Promise<Reader | null> {
  const approvals = `${schemaRef("kernel")}.approval_requests`
  const [row] = extractRows<{ scopes: string | null; user_id: string | null; rls: boolean }>(
    await tx.execute(drizzleSql`
      SELECT rls_ctx.scopes() AS scopes, rls_ctx.user_id()::text AS user_id,
             row_security_active(${approvals}::regclass) AS rls`),
  )
  if (!row?.rls) return null
  const scopes = (row.scopes ?? "").split(",").flatMap((s) => s.trim() || [])
  return { userId: row.user_id, scopes }
}

interface LabelRow {
  id: string
  label: string | null
  handle?: string | null
  closed?: boolean
}

/** What reading the kernel's own records takes; a colleague's name is everyone's. */
const KERNEL_READ_SCOPE: Readonly<Record<string, string>> = {
  company: "kernel:companies:read",
  contact: "kernel:contacts:read",
}

/** The rows of one kind the reader may read, one query for all of them. */
async function rowsOfKind(
  tx: RlsClient,
  orgId: string,
  reader: Reader,
  k: Kind,
  ids: string[],
): Promise<LabelRow[]> {
  if (k.app === "kernel") {
    const scope = KERNEL_READ_SCOPE[k.entityType]
    if (scope && !hasScope(scope, reader.scopes)) return []
    if (k.entityType === "user") {
      return tx
        .select({ id: users.id, label: users.name })
        .from(users)
        .where(and(inArray(users.id, ids), eq(users.orgId, orgId)))
    }
    if (k.entityType !== "company" && k.entityType !== "contact") return []
    const table = k.entityType === "company" ? companies : contacts
    const rows = await tx
      .select({ id: table.id, label: table.name, access: table.orgAccess })
      .from(table)
      .where(and(inArray(table.id, ids), eq(table.orgId, orgId)))
    return rows.map(({ access, ...row }) => ({ ...row, closed: access === "none" }))
  }
  if (PERSONAL_APPS.has(k.app) || isAppUnavailableFor(orgId, k.app, reader.userId)) return []
  const { lookupEntityDecl } = await import("~/modules/threads/reference-display")
  const decl = lookupEntityDecl(orgId, k.app, k.entityType)
  // A kind that says nothing of who reads it is named to nobody.
  if (!decl?.tableName || !decl.readScope || !hasScope(decl.readScope, reader.scopes)) return []
  const closable = RESTRICTED_ENTITY_KINDS.includes(`${k.app}.${k.entityType}`)
  const col = (name: string) => drizzleSql.raw(quoteIdent(name))
  const handle = decl.indexFields?.handle
  return extractRows<LabelRow>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, ${col(decl.labelField)}::text AS label,
             ${handle ? drizzleSql`${col(handle)}::text` : drizzleSql`NULL`} AS handle,
             ${closable ? drizzleSql`org_access IS NOT DISTINCT FROM 'none'` : drizzleSql`false`} AS closed
        FROM ${col(schemaRef(`app_${k.app}`))}.${col(decl.tableName)}
       WHERE org_id = ${orgId}::uuid
         AND id IN (${drizzleSql.join(
           ids.map((id) => drizzleSql`${id}::uuid`),
           drizzleSql`, `,
         )})`),
  )
}

function nameOfRow(row: LabelRow, entityType: string): string {
  const label = row.label?.replace(/\s+/g, " ").trim() || (row.handle ? `#${row.handle}` : "")
  if (!label) return `${kindName(entityType)} with no name`
  return label.length > MAX_NAME_CHARS ? `${label.slice(0, MAX_NAME_CHARS - 1)}…` : label
}

/** What the reader calls each record: its name when they may read it, else its kind. */
async function readerNames(
  tx: RlsClient,
  orgId: string,
  refs: ReadonlyMap<string, RecordRef>,
): Promise<Say> {
  const names = new Map<string, string>()
  const reader = await readerOf(tx)
  if (reader) {
    const kinds = new Map<string, { kind: Kind; ids: string[] }>()
    for (const ref of refs.values()) {
      const at = `${ref.app}:${ref.entityType}`
      const of = kinds.get(at) ?? { kind: { app: ref.app, entityType: ref.entityType }, ids: [] }
      if (isUuid(ref.id)) of.ids.push(ref.id)
      kinds.set(at, of)
    }
    for (const { kind, ids } of kinds.values()) {
      if (ids.length === 0) continue
      const rows = await tx
        .transaction((sp) => rowsOfKind(sp as unknown as RlsClient, orgId, reader, kind, ids))
        .catch(() => [])
      for (const row of rows) {
        if (!row.closed) names.set(refKey({ ...kind, id: row.id }), nameOfRow(row, kind.entityType))
      }
    }
  }
  return (ref) => names.get(refKey(ref)) ?? say(ref)
}

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** One card in its reader's words. A text changed since it was made keeps its stored words. */
function inReadersWords(summary: unknown, read: Say | null): unknown {
  if (!isRecord(summary) || !("names" in summary)) return summary
  const { names: _names, ...rest } = summary
  if (!read) return rest
  const left = [...namedTexts(summary)]
  const say = (text: unknown, max: number): unknown => {
    const i = left.findIndex((n) => n.shown === text)
    if (i === -1) return text
    const [found] = left.splice(i, 1)
    const said = found ? replaceTokens(found.named, read) : ""
    // Nobody's name in it: the stored words say it better.
    return !found || said === replaceTokens(found.named, (ref) => kindName(ref.entityType))
      ? text
      : clip(said, max)
  }
  const kind = typeof rest.kind === "string" ? rest.kind : ""
  return {
    ...rest,
    title: say(rest.title, 200),
    ...(rest.subtitle !== undefined ? { subtitle: say(rest.subtitle, 200) } : {}),
    ...(Array.isArray(rest.lines)
      ? { lines: rest.lines.map((line) => say(line, approvalSummaryLineMax(kind))) }
      : {}),
  }
}

/**
 * Cards as their reader may read them: each record by its name when the reader may read it, else by
 * its kind. One query per kind of record, however many cards. An agent's run is nobody's own
 * reading (what it reads here may be posted to people who read less): it gets the stored words.
 */
export async function withViewerNames<T extends { summary: unknown }>(
  tx: RlsClient,
  orgId: string,
  rows: T[],
): Promise<T[]> {
  if (!rows.some((row) => isRecord(row.summary) && "names" in row.summary)) return rows
  const refs = new Map<string, RecordRef>()
  for (const row of rows) for (const { named } of namedTexts(row.summary)) refsIn(named, refs)
  let read: Say | null = null
  if (refs.size > 0 && typeof tx.transaction === "function" && !currentRunContext()) {
    try {
      read = await tx.transaction((sp) => readerNames(sp as unknown as RlsClient, orgId, refs))
    } catch (err) {
      log.warn({ err, orgId }, "Record names for approval cards could not be read")
    }
  }
  return rows.map((row) => ({ ...row, summary: inReadersWords(row.summary, read) }))
}
