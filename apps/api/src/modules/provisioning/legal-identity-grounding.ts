// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * LEGAL IDENTIFIERS COME FROM THE PERSON, NEVER FROM THE MODEL.
 *
 * Measured failure: with no issuer profile, an agent proposed one with a
 * SIREN, an address and a legal form nobody gave it. The checksum refused the
 * first number, so it picked another that passes the checksum: the validation
 * only made the invented value look real. A SIREN, SIRET, VAT number or IBAN
 * names one real company or account, so a made-up one is never harmless.
 *
 * On an agent's call (in-app or an MCP client), every legal identifier a tool
 * sets must appear in what a person gave in this conversation: a message they
 * wrote, or a file they attached (its text, or the analysis the agent ran on
 * it). An identifier the org already stores is not new, and a French VAT number
 * computed from a given SIREN is that SIREN. Anything else is refused with what
 * to ask. Which tools and which of their params hold legal identifiers is this
 * file's own list (`LEGAL_IDENTIFIER_TOOLS`): a manifest can neither claim nor
 * drop an entry, and the check runs in executeTool before any gate.
 *
 * Presence, not role: a value grounds wherever it appears (a customer's VAT
 * number in an uploaded CSV grounds it too). The approval card lists every
 * identity field the call sets, and that is the backstop.
 *
 * Matching folds case and drops every character that is not a letter or a
 * digit on both sides, so "552 032 534" and "FR 12 552032534" both match.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { connectedAccounts } from "~/db/schema/kernel/connected-accounts"
import { files } from "~/db/schema/kernel/files"
import { messages } from "~/db/schema/kernel/threads"
import { users } from "~/db/schema/kernel/users"
import { schemaRef } from "~/db/schema-ref"
import { getObjectBuffer } from "~/infra/storage/object-storage"
import { rootLogger } from "~/lib/logger"
import {
  bufferRangeSource,
  readZipDirectory,
  readZipEntry,
  ZipBudget,
} from "~/modules/imports/parsers/zip"

const log = rootLogger.child({ module: "legal-identity-grounding" })

/** One identifier a change sets: which field, and the value. */
export interface LegalIdentifier {
  field: string
  label: string
  value: string
}

/** Upper-cased letters and digits only. */
export function foldIdentifier(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "")
}

/** The French VAT key of a SIREN: FR + key + SIREN, key = (12 + 3 * (SIREN mod 97)) mod 97. */
export function frenchVatOf(siren: string): string {
  const key = (12 + 3 * (Number(siren) % 97)) % 97
  return `FR${String(key).padStart(2, "0")}${siren}`
}

/** The identifiers no source text carries, after folding. */
export function ungroundedIdentifiers(
  identifiers: readonly LegalIdentifier[],
  sources: readonly string[],
): LegalIdentifier[] {
  const haystack = sources.map(foldIdentifier).join("\u0000")
  const given = (needle: string) => needle.length > 0 && haystack.includes(needle)
  return identifiers.filter((id) => {
    const needle = foldIdentifier(id.value)
    if (given(needle)) return false
    // A French VAT number is computed from the SIREN: one derived from a given
    // SIREN (key checked) is that SIREN, not a new fact.
    const fr = /^FR\d{2}(\d{9})$/.exec(needle)
    if (fr?.[1] && frenchVatOf(fr[1]) === needle && given(fr[1])) return false
    return needle.length > 0
  })
}

/** The refusal the agent gets: final, and naming what to ask the person. */
export function ungroundedRefusal(
  missing: readonly LegalIdentifier[],
  unreadable: readonly string[] = [],
): {
  error: { code: string; message: string; status: 400; retryable: false }
} {
  const named = missing.map((m) => `${m.label} ${m.value}`).join(", ")
  const one = missing.length === 1
  const files =
    unreadable.length > 0
      ? ` This conversation holds attached files Liaison cannot read here (${unreadable.slice(0, 5).join(", ")}): if the value is in one of them, have the person confirm it by typing it in a message; a typed confirmation is enough.`
      : ""
  return {
    error: {
      code: "legal_identifier_not_given",
      message:
        `Nothing was saved. ${named}: the person never gave ${one ? "this value" : "these values"} in this conversation (no message they wrote and no file they attached carries ${one ? "it" : "them"}). ` +
        "A company's legal identifiers (SIREN, SIRET, VAT number, IBAN, BIC, tax id) are facts only the person knows: ask them to type each one in a message, or to enter them themselves in Settings › Invoicing." +
        files +
        " Never make one up and never try another number: call this tool again only with the values the person gives you.",
      status: 400,
      retryable: false,
    },
  }
}

/** Mime types and extensions read as text. */
const TEXT_MIME = /^(?:text\/|application\/(?:json|xml|csv|x-ndjson))/
const TEXT_EXT = /\.(?:csv|tsv|txt|md|json|jsonl|ndjson|xml|ics|vcf|html?)$/i
const ZIP = /(?:^application\/(?:zip|x-zip-compressed)$)|\.zip$/i

/** Bytes read per file and per zip entry, and text kept per conversation. */
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_ENTRY_BYTES = 2 * 1024 * 1024
const MAX_TEXT_CHARS = 8 * 1024 * 1024

async function zipText(bytes: Uint8Array): Promise<string[]> {
  const src = bufferRangeSource(bytes)
  const entries = await readZipDirectory(src)
  const budget = new ZipBudget(bytes.length)
  const out: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory || !TEXT_EXT.test(entry.name)) continue
    if (entry.uncompressedSize > MAX_ENTRY_BYTES) continue
    const chunks: Uint8Array[] = []
    for await (const chunk of readZipEntry(src, entry, budget)) chunks.push(chunk)
    out.push(Buffer.concat(chunks).toString("utf8"))
  }
  return out
}

/** The readable text of one attached file, or nothing when its kind is not read. */
async function fileText(f: {
  filename: string
  mimeType: string
  sizeBytes: number
  storageKey: string
}): Promise<string[]> {
  if (f.sizeBytes > MAX_FILE_BYTES) return []
  const isZip = ZIP.test(f.mimeType) || ZIP.test(f.filename)
  const isText = TEXT_MIME.test(f.mimeType) || TEXT_EXT.test(f.filename)
  if (!isZip && !isText) return []
  const bytes = await getObjectBuffer(f.storageKey, undefined, { maxBytes: MAX_FILE_BYTES })
  return isZip ? zipText(bytes) : [bytes.toString("utf8")]
}

/**
 * What the people in this conversation gave: the text of their messages, the
 * text of the files they attached (plain text, CSV, JSON, XML and those inside a
 * zip; sealed files are skipped), and the analysis the agent ran on an attached
 * file (a PDF or a scan read by the media analysis).
 */
export async function loadPersonProvidedText(
  orgId: string,
  threadId: string,
): Promise<{ texts: string[]; unreadable: string[] }> {
  const { texts, attached } = await withPrivilegedDb(
    orgId,
    "legal-identity-grounding",
    async (tx) => {
      const rows = await tx
        .select({ id: messages.id, content: messages.content })
        .from(messages)
        .where(
          and(
            eq(messages.orgId, orgId),
            eq(messages.threadId, threadId),
            eq(messages.authorType, "user"),
            isNull(messages.deletedAt),
          ),
        )
      const ids = rows.map((r) => r.id)
      const attachedRows =
        ids.length === 0
          ? []
          : await tx
              .select({
                filename: files.filename,
                mimeType: files.mimeType,
                sizeBytes: files.sizeBytes,
                storageKey: files.storageKey,
                encVersion: files.encVersion,
                analysisSummary: files.analysisSummary,
              })
              .from(files)
              .where(
                and(
                  eq(files.orgId, orgId),
                  eq(files.entityType, "message"),
                  inArray(files.entityId, ids),
                ),
              )
      return { texts: rows.map((r) => r.content), attached: attachedRows }
    },
  )
  let size = texts.reduce((n, t) => n + t.length, 0)
  // Files whose content this check cannot see (a PDF or a scan with no media
  // analysis, a sealed file, one too large): the refusal names them, so the
  // agent has the person confirm a value in a message instead.
  const unreadable: string[] = []
  for (const f of attached) {
    if (f.analysisSummary) texts.push(f.analysisSummary)
    if (f.encVersion > 0 || size > MAX_TEXT_CHARS) {
      if (!f.analysisSummary) unreadable.push(f.filename)
      continue
    }
    try {
      const read = await fileText(f)
      if (read.length === 0 && !f.analysisSummary) unreadable.push(f.filename)
      for (const t of read) {
        texts.push(t)
        size += t.length
      }
    } catch (err) {
      // An unreadable file grounds nothing; the refusal then asks the person.
      log.warn({ err, orgId, threadId, filename: f.filename }, "attached file not readable")
      if (!f.analysisSummary) unreadable.push(f.filename)
    }
  }
  return { texts, unreadable }
}

/** The identifiers the org's issuer profiles already store (an update repeats them). */
export async function storedIssuerIdentifiers(orgId: string): Promise<string[]> {
  return withPrivilegedDb(orgId, "legal-identity-grounding-stored", async (tx) => {
    const exists = extractRows<{ present: boolean }>(
      await tx.execute(
        sql`SELECT to_regclass(${`${schemaRef("app_invoicing")}.issuer_profiles`}) IS NOT NULL AS present`,
      ),
    )[0]?.present
    if (!exists) return []
    const rows = extractRows<Record<string, string | null>>(
      await tx.execute(
        sql`SELECT siren, siret, vat_id, iban, swift_bic, tax_registration_id
            FROM ${sql.raw(`${schemaRef("app_invoicing")}.issuer_profiles`)}
            WHERE org_id = ${orgId}::uuid`,
      ),
    )
    return rows.flatMap((r) => Object.values(r).filter((v): v is string => typeof v === "string"))
  })
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}

function pick(
  entry: Record<string, unknown>,
  fields: ReadonlyArray<readonly [string, string]>,
): LegalIdentifier[] {
  const out: LegalIdentifier[] = []
  for (const [field, label] of fields) {
    const value = entry[field]
    if (typeof value === "string" && value.trim() !== "") out.push({ field, label, value })
  }
  return out
}

const CONFIG_ISSUER_FIELDS = [
  ["siren", "SIREN"],
  ["siret", "SIRET"],
  ["vatId", "VAT number"],
  ["iban", "IBAN"],
  ["swiftBic", "BIC"],
  ["taxRegistrationId", "tax id"],
] as const

const APP_ISSUER_FIELDS = [
  ["vat_id", "VAT number"],
  ["iban", "IBAN"],
  ["swift_bic", "BIC"],
  ["tax_registration_id", "tax id"],
] as const

/**
 * The tools whose params hold a company's legal identifiers, and where. Host
 * owned: an app's manifest cannot add, rename or remove an entry, so a tool
 * here is checked whatever the app declares.
 */
export const LEGAL_IDENTIFIER_TOOLS: ReadonlyMap<string, (params: unknown) => LegalIdentifier[]> =
  new Map([
    [
      "kernel:config_invoicing",
      (params: unknown) => {
        const profiles = rec(rec(params).invoicing).issuerProfiles
        return (Array.isArray(profiles) ? profiles : []).flatMap((p) =>
          pick(rec(p), CONFIG_ISSUER_FIELDS),
        )
      },
    ],
    [
      "invoicing:settings_issuer_profile_create",
      (params: unknown) => pick(rec(params), APP_ISSUER_FIELDS),
    ],
    [
      "invoicing:settings_issuer_profile_update",
      (params: unknown) => pick(rec(params), APP_ISSUER_FIELDS),
    ],
  ])

/**
 * The refusal for an agent's call that sets a legal identifier the person never
 * gave in this conversation, or null. `tool` is `app:tool`.
 */
export async function legalIdentityRefusal(args: {
  orgId: string
  tool: string
  params: unknown
  threadId?: string
}): Promise<ReturnType<typeof ungroundedRefusal> | null> {
  const extract = LEGAL_IDENTIFIER_TOOLS.get(args.tool)
  if (!extract) return null
  const identifiers = extract(args.params)
  if (identifiers.length === 0) return null
  const person = args.threadId
    ? await loadPersonProvidedText(args.orgId, args.threadId)
    : { texts: [], unreadable: [] }
  const sources = [...(await storedIssuerIdentifiers(args.orgId)), ...person.texts]
  const missing = ungroundedIdentifiers(identifiers, sources)
  return missing.length > 0 ? ungroundedRefusal(missing, person.unreadable) : null
}

// ─── Mailbox and inbox addresses ────────────────────────────────────────────
//
// THE SAME RULE FOR AN ADDRESS A CONFIG TOOL CONNECTS. Measured failure: asked
// to connect the team mailbox, an agent also staged a ticket inbox nobody asked
// for, on an address it made up from the org's domain (`support@...`). An
// address names one real mailbox, so it comes from the person (a message they
// wrote, a file they attached) or from what the workspace already knows (its
// members' addresses, its connected accounts). Host-owned list, checked in
// executeTool before any gate, like the legal identifiers above.

/** An email address, compared case-insensitively. */
function foldAddress(text: string): string {
  return text.trim().toLowerCase()
}

/**
 * Every email address a text carries, whole and lower-cased. An address is
 * matched as a whole token, never as part of another (`support@acme.com` is
 * not given by `it-support@acme.com` nor by `support@acme.com.au`).
 */
export function emailTokens(text: string): string[] {
  return (text.match(/[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) ?? []).map((t) =>
    t.toLowerCase().replace(/\.+$/, ""),
  )
}

/** The addresses a change connects that no source text carries. */
export function ungroundedAddresses(
  addresses: readonly LegalIdentifier[],
  sources: readonly string[],
): LegalIdentifier[] {
  const given = new Set(sources.flatMap(emailTokens))
  return addresses.filter((a) => {
    const needle = foldAddress(a.value)
    return needle.length > 0 && !given.has(needle)
  })
}

/** The refusal the agent gets for an address nobody gave: final, and naming what to ask. */
export function ungroundedAddressRefusal(missing: readonly LegalIdentifier[]): {
  error: { code: string; message: string; status: 400; retryable: false }
} {
  const named = missing.map((m) => `${m.label} ${m.value}`).join(", ")
  const one = missing.length === 1
  return {
    error: {
      code: "address_not_given",
      message:
        `Nothing was saved. ${named}: the person never gave ${one ? "this address" : "these addresses"} in this conversation, and no member or connected account of this workspace has ${one ? "it" : "them"}. ` +
        "An address names one real mailbox: never make one up from the company's name or domain. Set up only the mailbox or inbox the person asked for, and ask them for its exact address; a ticket inbox or another mailbox they did not ask for is not proposed at all.",
      status: 400,
      retryable: false,
    },
  }
}

/** The addresses the workspace already knows: its members' and its connected accounts'. */
export async function storedAddresses(orgId: string): Promise<string[]> {
  return withPrivilegedDb(orgId, "address-grounding-stored", async (tx) => {
    const people = await tx.select({ email: users.email }).from(users).where(eq(users.orgId, orgId))
    const accounts = await tx
      .select({ identifier: connectedAccounts.identifier })
      .from(connectedAccounts)
      .where(eq(connectedAccounts.orgId, orgId))
    return [...people.map((p) => p.email), ...accounts.map((a) => a.identifier)]
  })
}

function entries(section: unknown, list: string): Record<string, unknown>[] {
  const value = rec(section)[list]
  return Array.isArray(value) ? value.map(rec) : []
}

function mailboxAddresses(entry: Record<string, unknown>, label: string): LegalIdentifier[] {
  const out = pick(entry, [["address", label]])
  const imapEmail = rec(entry.imap).email
  if (typeof imapEmail === "string" && imapEmail.trim() !== "") {
    out.push({ field: "imap.email", label: `${label} IMAP login`, value: imapEmail })
  }
  return out
}

/**
 * The tools whose params hold a mailbox or inbox address, and where. Host
 * owned, like `LEGAL_IDENTIFIER_TOOLS`.
 */
export const GROUNDED_ADDRESS_TOOLS: ReadonlyMap<string, (params: unknown) => LegalIdentifier[]> =
  new Map([
    [
      "kernel:config_mail",
      (params: unknown) =>
        entries(rec(params).mail, "mailboxes").flatMap((m) => [
          ...mailboxAddresses(m, "mailbox address"),
          ...pick(m, [["owner", "mailbox owner"]]),
        ]),
    ],
    [
      "kernel:config_tickets",
      (params: unknown) =>
        entries(rec(params).tickets, "inboxes").flatMap((i) =>
          mailboxAddresses(i, "ticket inbox address"),
        ),
    ],
  ])

/**
 * The refusal for an agent's call that connects a mailbox or inbox address the
 * person never gave and the workspace does not know, or null. `tool` is `app:tool`.
 */
export async function addressGroundingRefusal(args: {
  orgId: string
  tool: string
  params: unknown
  threadId?: string
}): Promise<ReturnType<typeof ungroundedAddressRefusal> | null> {
  const extract = GROUNDED_ADDRESS_TOOLS.get(args.tool)
  if (!extract) return null
  const addresses = extract(args.params)
  if (addresses.length === 0) return null
  const stored = await storedAddresses(args.orgId)
  if (ungroundedAddresses(addresses, stored).length === 0) return null
  const person = args.threadId
    ? await loadPersonProvidedText(args.orgId, args.threadId)
    : { texts: [], unreadable: [] }
  const missing = ungroundedAddresses(addresses, [...stored, ...person.texts])
  return missing.length > 0 ? ungroundedAddressRefusal(missing) : null
}
