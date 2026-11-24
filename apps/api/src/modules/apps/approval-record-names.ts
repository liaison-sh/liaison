// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE NAMES OF THE RECORDS A CALL NAMES BY ID.
//
// A person deciding an approval recognises a deal by its title and an agreement by its name, never
// by a uuid. The params of a call say which kind of record an id is (`taskId`, `project_id`,
// `assigneeId`, or `id` for the record the tool acts on), and the app's manifest says where that
// kind keeps its name. Names are read with the REQUESTER's own access, as every summarizer reads.
//
// What is never named here: a record closed to the organization (a restricted document, a
// company or a contact shared by name), and what may be one person's own (mail, calendar, conversations, files): the
// card is read by every decider, and whoever asked may see more than they do.
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { companies, contacts, users } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { isRecord } from "~/lib/guards"
import { isUuid } from "~/lib/uuid"
import { splitToolName } from "~/modules/approvals/tool-name"
import { entityRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { RESTRICTED_ENTITY_KINDS } from "~/modules/permissions/restricted-scope"

/** A record a call names by id, and the name a person knows it by. */
export interface NamedRecord {
  app: string
  entityType: string
  /** Null for a record that exists and is not named on a card (closed to the organization). */
  name: string | null
}

export type RecordNames = ReadonlyMap<string, NamedRecord>

export const NO_NAMES: RecordNames = new Map()

/** Records looked up for one card, and the kinds tried for one id. */
const MAX_IDS = 12
const MAX_KINDS = 6
const MAX_NAME_CHARS = 120

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

/** The kernel's own answer, which the requester's role may not ask for. */
async function isRestricted(orgId: string, k: Kind, id: string): Promise<boolean> {
  const kind = `${k.app}.${k.entityType}`
  if (!RESTRICTED_ENTITY_KINDS.includes(kind)) return false
  return withPrivilegedDb(orgId, "approval-card-restricted", async (tx) => {
    const [row] = extractRows<{ ids: string[] | null }>(
      await tx.execute(
        drizzleSql`SELECT ${drizzleSql.raw(schemaRef("kernel"))}.restricted_among(${orgId}::uuid, ${kind}, ARRAY[${id}]::text[]) AS ids`,
      ),
    )
    return (row?.ids ?? []).map(String).includes(id)
  })
}

async function nameOf(
  tx: RlsClient,
  orgId: string,
  k: Kind,
  id: string,
): Promise<NamedRecord | null> {
  if (k.app === "kernel" && k.entityType === "user") {
    const [row] = await tx
      .select({ name: users.name })
      .from(users)
      .where(and(eq(users.id, id), eq(users.orgId, orgId)))
      .limit(1)
    return row ? { ...k, name: row.name ?? null } : null
  }
  if (k.app === "kernel" && (k.entityType === "company" || k.entityType === "contact")) {
    const table = k.entityType === "company" ? companies : contacts
    const [row] = await tx
      .select({ name: table.name, access: table.orgAccess })
      .from(table)
      .where(and(eq(table.id, id), eq(table.orgId, orgId)))
      .limit(1)
    return row ? { ...k, name: row.access === "none" ? null : row.name } : null
  }
  const { resolveEntityLabel } = await import("~/modules/threads/reference-display")
  const label = await resolveEntityLabel(tx, { orgId, ...k, entityId: id })
  if (label === null) return null
  if (await isRestricted(orgId, k, id)) return { ...k, name: null }
  const name = label.replace(/\s+/g, " ").trim()
  // A record with no name of its own is labelled by a piece of its id.
  if (!name || name === `#${id.slice(0, 8)}`) return { ...k, name: null }
  return {
    ...k,
    name: name.length > MAX_NAME_CHARS ? `${name.slice(0, MAX_NAME_CHARS - 1)}…` : name,
  }
}

/**
 * The names of the records `params` names by id. Each lookup is its own savepoint, so a kind that
 * cannot be read never costs the caller its transaction; an id nothing names is absent.
 */
export async function resolveRecordNames(
  ctx: { tx?: RlsClient; orgId?: string } | undefined,
  toolName: string,
  params: unknown,
): Promise<RecordNames> {
  const { tx, orgId } = ctx ?? {}
  if (!tx || !orgId || typeof tx.transaction !== "function") return NO_NAMES
  const out = new Map<string, NamedRecord>()
  const seen = new Set<string>()
  for (const { key, id } of idsOf(params)) {
    if (seen.has(id) || seen.size >= MAX_IDS) continue
    seen.add(id)
    for (const kind of kindsOf(orgId, toolName, key)) {
      const found = await tx
        .transaction((sp) => nameOf(sp as unknown as RlsClient, orgId, kind, id))
        .catch(() => null)
      if (!found) continue
      out.set(id, found)
      break
    }
  }
  return out
}
