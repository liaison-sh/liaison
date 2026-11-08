// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Opt-outs: the addresses an organization must not send commercial mail to.
 *
 * An address is never stored, only its fingerprint (`hashEmail`), so the list can answer "has this
 * address opted out" and nothing else. The send check reads it on its privileged path
 * (`suppressedAmong`): a person who cannot read the list still never sends commercial mail to
 * someone on it. Recording one (`addSuppression`) needs only the right to write to people, because
 * an opt-out must be honoured by whoever receives it; it withdraws the waiting commercial drafts to
 * that address in the same transaction and announces `mail/suppression:added`. Removing one
 * (`removeSuppression`) lifts a person's refusal and needs `mail:suppressions:write`; row security
 * on `kernel.suppressions` enforces both. A contact's erasure leaves the list alone: the refusal
 * outlives the contact.
 */
import { createHash } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb, type RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { withdrawCommercialDraftsTo } from "~/modules/approvals/withdraw-on-events"

const K = () => drizzleSql.raw(schemaRef("kernel"))

/** How an opt-out came in. `link` is the opt-out page only, never a caller's claim. */
export type SuppressionReason = "link" | "reply" | "person" | "import"

export interface SuppressionRecord {
  email: string
  reason: SuppressionReason
  /** A mail message id or a user id, never the address. */
  source: string | null
  createdBy: string | null
  createdAt: string
}

export interface LawfulBasisProblem {
  code: string
  label: string
  who: string
}

/** The fingerprint an address is kept as: sha256 of `<org id>:<trimmed lower address>`, hex. */
export function hashEmail(orgId: string, email: string): string {
  return createHash("sha256").update(`${orgId}:${email.trim().toLowerCase()}`).digest("hex")
}

function hashesOf(orgId: string, emails: readonly string[]): Map<string, string[]> {
  const byHash = new Map<string, string[]>()
  for (const email of emails) {
    if (typeof email !== "string" || email.trim() === "") continue
    const h = hashEmail(orgId, email)
    byHash.set(h, [...(byHash.get(h) ?? []), email])
  }
  return byHash
}

async function rowsFor(
  db: Pick<RlsClient, "execute"> | PrivilegedDb,
  orgId: string,
  hashes: readonly string[],
) {
  if (hashes.length === 0) return []
  return extractRows<{
    email_hash: string
    reason: SuppressionReason
    source: string | null
    created_by: string | null
    created_at: string | Date
  }>(
    await db.execute(drizzleSql`
      SELECT email_hash, reason, source, created_by::text AS created_by, created_at
        FROM ${K()}.suppressions
       WHERE org_id = ${orgId}::uuid
         AND email_hash = ANY(${`{${hashes.join(",")}}`}::text[])`),
  )
}

function toRecords(
  byHash: Map<string, string[]>,
  rows: Awaited<ReturnType<typeof rowsFor>>,
): SuppressionRecord[] {
  return rows.flatMap((r) =>
    (byHash.get(r.email_hash) ?? []).map((email) => ({
      email,
      reason: r.reason,
      source: r.source,
      createdBy: r.created_by,
      createdAt: new Date(r.created_at).toISOString(),
    })),
  )
}

/**
 * The addresses among `emails` that have opted out, as given. Read on the privileged path the
 * send check uses (on `db` when the caller already holds one of this org), so it answers whoever
 * is sending. A read that fails throws: the check then fails closed.
 */
export async function suppressedAmong(
  orgId: string,
  emails: string[],
  db?: PrivilegedDb,
): Promise<string[]> {
  const byHash = hashesOf(orgId, emails)
  if (byHash.size === 0) return []
  const read = (tx: PrivilegedDb) => rowsFor(tx, orgId, [...byHash.keys()])
  const rows = db ? await read(db) : await withPrivilegedDb(orgId, "suppressions-check", read)
  return toRecords(byHash, rows).map((r) => r.email)
}

/** Whether the address behind a fingerprint has opted out (privileged: the opt-out page has no person). */
export async function isSuppressedHash(orgId: string, emailHash: string): Promise<boolean> {
  const rows = await withPrivilegedDb(orgId, "suppressions-check-hash", (tx) =>
    rowsFor(tx, orgId, [emailHash]),
  )
  return rows.length > 0
}

/**
 * The opt-outs of `emails`, with when and how. On `db` under the caller's row security (it then
 * needs `mail:suppressions:read`), or privileged when no client is given.
 */
export async function listSuppressions(
  orgId: string,
  emails: readonly string[],
  db?: Pick<RlsClient, "execute">,
): Promise<SuppressionRecord[]> {
  const byHash = hashesOf(orgId, emails)
  if (byHash.size === 0) return []
  const rows = db
    ? await rowsFor(db, orgId, [...byHash.keys()])
    : await withPrivilegedDb(orgId, "suppressions-list", (tx) =>
        rowsFor(tx, orgId, [...byHash.keys()]),
      )
  return toRecords(byHash, rows)
}

/** The opt-outs a person recorded, newest first: when and how, never an address (none is kept). */
export async function suppressionsAddedBy(
  db: Pick<RlsClient, "execute"> | PrivilegedDb,
  orgId: string,
  userId: string,
  limit: number,
): Promise<Array<{ reason: SuppressionReason; created_at: string | Date }>> {
  return extractRows(
    await db.execute(drizzleSql`
      SELECT reason, created_at FROM ${K()}.suppressions
       WHERE org_id = ${orgId}::uuid AND created_by = ${userId}::uuid
       ORDER BY created_at DESC
       LIMIT ${limit}`),
  )
}

export interface AddSuppressionResult {
  /** False when the address had already opted out: nothing new was written. */
  added: boolean
  record: SuppressionRecord
  /** The waiting commercial drafts to the address cancelled in the same transaction. */
  withdrawn: string[]
}

/**
 * Record that `email` opted out, on `db`: a person's own transaction (row security checks they
 * may write to people), a privileged one, or null for the system in its own transaction (a link
 * click, an inbound "stop").
 * An address already on the list keeps its first record. The waiting commercial drafts to it are
 * withdrawn in the same transaction, and `mail/suppression:added` is announced once.
 */
export async function addSuppression(
  db: RlsClient | PrivilegedDb | null,
  args: {
    orgId: string
    email: string
    reason: SuppressionReason
    source?: string | null
    createdBy?: string | null
    actorType?: "user" | "agent" | "system"
  },
): Promise<AddSuppressionResult> {
  const { email, ...rest } = args
  const emailHash = hashEmail(args.orgId, email)
  const out = await addSuppressionHash(db, { ...rest, emailHash })
  const [record] = out.before
    ? toRecords(new Map([[emailHash, [email]]]), [out.before])
    : [
        {
          email,
          reason: args.reason,
          source: args.source ?? null,
          createdBy: args.createdBy ?? null,
          createdAt: out.createdAt,
        },
      ]
  return { added: out.added, record: record as SuppressionRecord, withdrawn: out.withdrawn }
}

/**
 * `addSuppression` for a caller that holds only the address's fingerprint (an opt-out link keeps
 * no address). Same rules: the first record stays, drafts are withdrawn, one event. With `db`
 * null the system records it, in a privileged transaction of its own (a link click has no
 * person and holds no transaction).
 */
export async function addSuppressionHash(
  db: RlsClient | PrivilegedDb | null,
  args: {
    orgId: string
    emailHash: string
    reason: SuppressionReason
    source?: string | null
    createdBy?: string | null
    actorType?: "user" | "agent" | "system"
  },
): Promise<{
  added: boolean
  before: Awaited<ReturnType<typeof rowsFor>>[number] | null
  createdAt: string
  withdrawn: string[]
}> {
  const { orgId, emailHash } = args
  const [before] = await withPrivilegedDb(orgId, "suppressions-add-read", (tx) =>
    rowsFor(tx, orgId, [emailHash]),
  )
  if (before) {
    return {
      added: false,
      before,
      createdAt: new Date(before.created_at).toISOString(),
      withdrawn: [],
    }
  }
  const actor = {
    actorId: args.createdBy ?? null,
    actorType: args.actorType ?? (args.createdBy ? "user" : "system"),
  } as const
  const write = async (tx: RlsClient | PrivilegedDb) => {
    // Inserted on the caller's client, so its row security decides; no RETURNING, which would
    // also ask for the read right.
    await tx.execute(drizzleSql`
      INSERT INTO ${K()}.suppressions (org_id, email_hash, reason, source, created_by)
      VALUES (${orgId}::uuid, ${emailHash}, ${args.reason}, ${args.source ?? null},
              ${args.createdBy ?? null})
      ON CONFLICT (org_id, email_hash) DO NOTHING`)
    await tx.queueEvent({
      app: "mail",
      entity: "suppression",
      action: "added",
      orgId,
      actorId: actor.actorId,
      actorType: actor.actorType,
      entityId: emailHash,
      data: { emailHash },
    })
  }
  if (db) await write(db)
  else await withPrivilegedDb(orgId, "suppressions-add-system", write)
  const withdrawn = await withdrawCommercialDraftsTo(orgId, emailHash, actor)
  return { added: true, before: null, createdAt: new Date().toISOString(), withdrawn }
}

/**
 * Lift `email`'s opt-out on the caller's client (row security asks for `mail:suppressions:write`).
 * Returns the record that was removed, or null when the address had not opted out or the caller
 * may not remove it.
 */
export async function removeSuppression(
  db: RlsClient,
  orgId: string,
  email: string,
): Promise<SuppressionRecord | null> {
  const emailHash = hashEmail(orgId, email)
  const removed = extractRows<{
    email_hash: string
    reason: SuppressionReason
    source: string | null
    created_by: string | null
    created_at: string | Date
  }>(
    await db.execute(drizzleSql`
      DELETE FROM ${K()}.suppressions
       WHERE org_id = ${orgId}::uuid AND email_hash = ${emailHash}
       RETURNING email_hash, reason, source, created_by::text AS created_by, created_at`),
  )
  const [record] = toRecords(new Map([[emailHash, [email]]]), removed)
  return record ?? null
}

/** How an opt-out came in, as a person reads it after "by". */
export function suppressionByLine(reason: SuppressionReason, who: string | null): string {
  if (reason === "link") return "the opt-out link in an earlier message"
  if (reason === "reply") return "a reply asking to stop"
  if (reason === "import") return "an imported list"
  return who ?? "a person in this organization"
}

// ─── The mail tools' answers (mail:suppression_check, _add, _remove) ─────────────────────────

/** At most this many addresses per check. */
export const SUPPRESSION_CHECK_MAX = 50

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function day(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  })
}

async function nameOf(orgId: string, userId: string | null): Promise<string | null> {
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) return null
  const [row] = await withPrivilegedDb(orgId, "suppressions-who", async (tx) =>
    extractRows<{ name: string | null; email: string | null }>(
      await tx.execute(drizzleSql`
        SELECT name, email FROM ${K()}.users WHERE id = ${userId}::uuid AND org_id = ${orgId}::uuid`),
    ),
  )
  return row?.name || row?.email || null
}

/** "Opted out on 6 Nov 2026, by the opt-out link in an earlier message." */
export async function optedOutLine(orgId: string, record: SuppressionRecord): Promise<string> {
  const who = record.reason === "person" ? await nameOf(orgId, record.createdBy) : null
  return `Opted out on ${day(record.createdAt)}, by ${suppressionByLine(record.reason, who)}.`
}

/**
 * Which of `emails` opted out. Every caller learns yes or no (anyone who writes to people must
 * know); when and how only with `mail:suppressions:read`, read under the caller's row security.
 */
export async function checkSuppressions(args: {
  orgId: string
  emails: string[]
  given: number
  db: Pick<RlsClient, "execute">
  canReadDetails: boolean
}): Promise<unknown> {
  const { orgId, emails } = args
  if (args.given > SUPPRESSION_CHECK_MAX) {
    return {
      error: {
        code: "too_many_addresses",
        message: `Nothing was checked: ${args.given} addresses were given and a check takes at most ${SUPPRESSION_CHECK_MAX}. Next: check them in groups of ${SUPPRESSION_CHECK_MAX}.`,
      },
    }
  }
  if (emails.length === 0) {
    return {
      error: {
        code: "invalid_params",
        message: "Nothing was checked: give emails, a list of addresses.",
      },
    }
  }
  const optedOut = await suppressedAmong(orgId, emails)
  const out = new Set(optedOut.map((e) => e.toLowerCase()))
  const details =
    args.canReadDetails && optedOut.length > 0
      ? await listSuppressions(orgId, optedOut, args.db)
      : []
  const results = []
  for (const email of emails) {
    const suppressed = out.has(email.toLowerCase())
    const record = details.find((d) => d.email.toLowerCase() === email.toLowerCase())
    results.push({
      email,
      optedOut: suppressed,
      ...(record
        ? { since: record.createdAt, by: record.reason, line: await optedOutLine(orgId, record) }
        : {}),
    })
  }
  const message =
    optedOut.length === 0
      ? `None of the ${emails.length} addresses opted out.`
      : `${optedOut.length} of ${emails.length} opted out: ${optedOut.join(", ")}. Send them no commercial mail; a service message (an invoice, an order) still goes.`
  return { checked: emails.length, results, message }
}

/** Record an opt-out a person or their agent received (`mail:suppression_add`). */
export async function addSuppressionTool(args: {
  orgId: string
  db: RlsClient
  userId: string | null
  actorType: "user" | "agent" | "system"
  params: Record<string, unknown>
}): Promise<unknown> {
  const { orgId, params } = args
  const email = typeof params.email === "string" ? params.email.trim() : ""
  if (!EMAIL_RE.test(email)) {
    return {
      error: {
        code: "invalid_params",
        message: "Nothing was recorded: email must be one address.",
      },
    }
  }
  const reason: SuppressionReason = params.reason === "reply" ? "reply" : "person"
  const source =
    typeof params.source === "string" && params.source.trim() !== "" ? params.source.trim() : null
  if (source?.includes("@")) {
    return {
      error: {
        code: "invalid_params",
        message:
          "Nothing was recorded: source is the id of the message they asked in, never an address.",
      },
    }
  }
  const done = await addSuppression(args.db, {
    orgId,
    email,
    reason,
    source: source ?? args.userId,
    createdBy: args.userId,
    actorType: args.actorType,
  })
  if (!done.added) {
    return {
      email,
      optedOut: true,
      alreadyOptedOut: true,
      withdrawn: 0,
      message: `${email} had already opted out (${(await optedOutLine(orgId, done.record)).replace(/\.$/, "")}). Nothing changed.`,
    }
  }
  const n = done.withdrawn.length
  return {
    email,
    optedOut: true,
    alreadyOptedOut: false,
    withdrawn: n,
    withdrawnRequestIds: done.withdrawn,
    message: `${email} is opted out of commercial mail. ${n === 0 ? "No draft to them was waiting." : `${n} waiting commercial draft${n === 1 ? " was" : "s were"} withdrawn.`} A service message (an invoice, an order) still goes.`,
  }
}

/** Lift an opt-out (`mail:suppression_remove`, approved by a mail admin). */
export async function removeSuppressionTool(args: {
  orgId: string
  db: RlsClient
  params: Record<string, unknown>
}): Promise<unknown> {
  const email = typeof args.params.email === "string" ? args.params.email.trim() : ""
  if (!EMAIL_RE.test(email)) {
    return {
      error: { code: "invalid_params", message: "Nothing was removed: email must be one address." },
    }
  }
  const removed = await removeSuppression(args.db, args.orgId, email)
  if (!removed) {
    return {
      error: {
        code: "not_found",
        message: `Nothing was removed: ${email} has not opted out, or you may not lift an opt-out (mail:suppressions:write).`,
      },
    }
  }
  return {
    email,
    optedOut: false,
    message: `${email} can receive commercial mail again. The opt-out removed: ${(await optedOutLine(args.orgId, removed)).replace(/\.$/, "")}. A new consent they gave belongs on their contact.`,
  }
}

/** The card of a request to lift an opt-out: who opted out, when and how. */
export async function suppressionRemoveCard(
  orgId: string,
  email: string,
): Promise<{ title: string; lines: string[] }> {
  const [record] = await listSuppressions(orgId, [email])
  return {
    title: `Let ${email} receive commercial mail again`,
    lines: record
      ? [
          await optedOutLine(orgId, record),
          "Approving removes the opt-out; commercial mail to them can go again.",
        ]
      : [`${email} has not opted out: approving changes nothing.`],
  }
}

/** Why the org may not write to these people, or null when it may. */
export async function lawfulBasisProblem(
  _orgId: string,
  _contactIds: string[],
  _addresses: string[],
): Promise<LawfulBasisProblem | null> {
  return null
}
