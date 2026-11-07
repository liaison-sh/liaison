// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison contacts apply-provenance --org <uuid> --delete-unused-created-by <user uuid>
//     --orphans-to <user uuid> [--actor <user uuid>]
//     [--execute --plan <dry-run output> --backup <new file>]`
// `liaison contacts restore-provenance --org <uuid> --backup <path>`
//
// Applies the owner's decisions on a contacts provenance report (the
// classification of privatize-mailbox-senders.ts), in one transaction:
//   - DELETE the contacts classified "created by a person, not used by any
//     team object" whose creator is --delete-unused-created-by (the
//     notification senders a sync recorded under that person);
//   - make the contacts classified "creator no longer exists, not used by any
//     team object" PRIVATE, owned by --orphans-to;
//   - PRIVATIZE every personal-source contact to its mailbox's owner.
// Targets are selected by the classification itself at run time, never by
// hard-coded ids, and every write goes through the contact services
// (deleteContact, assignContactSharingAsKernel): outbox events, the search
// ACL and index, and the audit trail follow as for any other change.
//
// SAFETY. A dry run unless --execute: a READ ONLY transaction printing the
// plan (ids and counts, no names, no addresses) as JSON on stdout, and with
// --plan-out <new file> into that file. Review it, and pass it back with --plan: --execute recomputes the plan
// under row locks and refuses unless it is IDENTICAL, so a contact that
// gained a reference since (and so left its class) or any other drift stops
// the run with nothing written. --backup <new file> (0600, never overwritten)
// is written before anything changes: full rows, conversation links and
// timeline entries of the deleted contacts, previous sharing of the others.
// restore-provenance puts it all back.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { sql as drizzleSql } from "drizzle-orm"
import { classify, inspect } from "~/cli/contacts/privatize-mailbox-senders"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { rel } from "~/modules/contacts/references"
import { deleteContact } from "~/modules/contacts/service"
import { assignContactSharingAsKernel } from "~/modules/contacts/sharing"
import { recomputeSearchAcl } from "~/modules/sharing/service"

const log = rootLogger.child({ module: "contacts-apply-provenance" })

export const PROVENANCE_USAGE =
  "usage: liaison contacts apply-provenance --org <uuid> --delete-unused-created-by <user uuid> --orphans-to <user uuid> [--actor <user uuid>] [--plan-out <new file> | --execute --plan <dry-run json> --backup <new file path>]\n" +
  "       liaison contacts restore-provenance --org <uuid> --backup <path>"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REASON_PERSON_UNUSED = "created by a person, not used by any team object"
const REASON_CREATOR_GONE = "creator no longer exists, not used by any team object"

export interface ProvenanceDecisions {
  orgId: string
  deleteUnusedCreatedBy: string
  orphansTo: string
}

export interface ProvenancePlan {
  orgId: string
  deleteUnusedCreatedBy: string
  orphansTo: string
  delete: string[]
  orphans: string[]
  privatize: Array<{ id: string; ownerUserId: string }>
  counts: { delete: number; orphans: number; privatize: number }
  /** Personal-source contacts left alone: their owner already has a private copy. */
  skippedPrivateCopies: number
}

async function computePlan(
  tx: Pick<PrivilegedDb, "execute">,
  d: ProvenanceDecisions,
): Promise<ProvenancePlan> {
  const rows = await classify(tx, d.orgId)
  const { inspection } = await inspect(tx, d.orgId)
  const ownerOf = new Map(rows.map((r) => [r.id, r.owner_id]))
  const unusedByPerson = rows.filter(
    (r) => r.class === "unclear" && r.reason === REASON_PERSON_UNUSED,
  )
  const creators = new Map(
    unusedByPerson.length === 0
      ? []
      : extractRows<{ id: string; created_by: string | null }>(
          await tx.execute(drizzleSql`
            SELECT id::text AS id, created_by::text AS created_by
              FROM ${drizzleSql.raw(rel("kernel", "contacts"))}
             WHERE org_id = ${d.orgId}::uuid AND id IN (${drizzleSql.join(
               unusedByPerson.map((r) => drizzleSql`${r.id}::uuid`),
               drizzleSql`, `,
             )})`),
        ).map((r) => [r.id, r.created_by]),
  )
  const del = unusedByPerson
    .filter((r) => creators.get(r.id) === d.deleteUnusedCreatedBy)
    .map((r) => r.id)
    .sort()
  const orphans = rows
    .filter((r) => r.class === "unclear" && r.reason === REASON_CREATOR_GONE)
    .map((r) => r.id)
    .sort()
  const privatize = [...inspection.ids]
    .sort()
    .map((id) => ({ id, ownerUserId: ownerOf.get(id) as string }))
  return {
    orgId: d.orgId,
    deleteUnusedCreatedBy: d.deleteUnusedCreatedBy,
    orphansTo: d.orphansTo,
    delete: del,
    orphans,
    privatize,
    counts: { delete: del.length, orphans: orphans.length, privatize: privatize.length },
    skippedPrivateCopies: inspection.alreadyPrivateCopy,
  }
}

/** The dry run, in a READ ONLY transaction. */
export async function planProvenance(d: ProvenanceDecisions): Promise<ProvenancePlan> {
  return withPrivilegedDb(d.orgId, "contacts-provenance:dry-run", async (tx) => {
    await tx.execute(drizzleSql`SET LOCAL transaction_read_only = on`)
    return computePlan(tx, d)
  })
}

function samePlan(a: ProvenancePlan, b: ProvenancePlan): boolean {
  const key = (p: ProvenancePlan) =>
    JSON.stringify([
      p.orgId,
      p.deleteUnusedCreatedBy,
      p.orphansTo,
      p.delete,
      p.orphans,
      p.privatize,
    ])
  return key(a) === key(b)
}

interface Backup {
  version: 3
  orgId: string
  createdAt: string
  deleted: Array<{
    row: Record<string, unknown>
    conversationLinks: Array<{ id: string; account_id: string }>
    timeline: Array<Record<string, unknown>>
  }>
  reassigned: Array<{
    id: string
    ownerUserId: string | null
    orgAccess: string
    newOwnerUserId: string
  }>
}

export interface ApplyResult {
  deleted: number
  orphansMadePrivate: number
  privatized: number
  backup: string
}

export async function applyProvenance(
  d: ProvenanceDecisions & {
    actorId: string | null
    reviewedPlan: ProvenancePlan
    backupPath: string
  },
): Promise<ApplyResult> {
  if (existsSync(d.backupPath)) throw new Error(`backup file already exists: ${d.backupPath}`)
  return withPrivilegedDb(d.orgId, "contacts-provenance:execute", async (tx) => {
    const contactsRel = drizzleSql.raw(rel("kernel", "contacts"))
    // Lock every organisation-visible contact first: the plan computed next
    // cannot change underneath the writes.
    await tx.execute(drizzleSql`
      SELECT id FROM ${contactsRel} WHERE org_id = ${d.orgId}::uuid AND org_access <> 'none' FOR UPDATE`)
    const plan = await computePlan(tx, d)
    if (!samePlan(plan, d.reviewedPlan)) {
      throw new Error(
        `the plan changed since it was reviewed (now ${JSON.stringify(plan.counts)}, reviewed ${JSON.stringify(d.reviewedPlan.counts)}): nothing was written; run the dry run again`,
      )
    }
    // The orphans' new owner must not already hold a private contact for the
    // same address (one per owner and address).
    if (plan.orphans.length > 0) {
      const clash = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          SELECT c.id::text AS id FROM ${contactsRel} c
           WHERE c.id IN (${drizzleSql.join(
             plan.orphans.map((id) => drizzleSql`${id}::uuid`),
             drizzleSql`, `,
           )})
             AND EXISTS (SELECT 1 FROM ${contactsRel} p
                          WHERE p.org_id = c.org_id AND p.owner_user_id = ${d.orphansTo}::uuid
                            AND p.org_access = 'none' AND p.audience_key IS NULL
                            AND p.email = c.email)`),
      )
      if (clash.length > 0) {
        throw new Error(
          `--orphans-to already has a private contact for the address of ${clash.map((c) => c.id).join(", ")}: merge them first; nothing was written`,
        )
      }
    }

    const conversations = rel("app_mail", "conversations")
    const [mail] = extractRows<{ t: string | null }>(
      await tx.execute(drizzleSql`SELECT to_regclass(${conversations})::text AS t`),
    )
    const backup: Backup = {
      version: 3,
      orgId: d.orgId,
      createdAt: new Date().toISOString(),
      deleted: [],
      reassigned: [],
    }
    for (const id of plan.delete) {
      const [row] = extractRows<{ row: Record<string, unknown> }>(
        await tx.execute(
          drizzleSql`SELECT to_jsonb(c) AS row FROM ${contactsRel} c WHERE c.id = ${id}::uuid`,
        ),
      )
      const conversationLinks = mail?.t
        ? extractRows<{ id: string; account_id: string }>(
            await tx.execute(drizzleSql`
              SELECT id::text AS id, account_id::text AS account_id FROM ${drizzleSql.raw(conversations)}
               WHERE org_id = ${d.orgId}::uuid AND contact_id = ${id}::uuid FOR UPDATE`),
          )
        : []
      const timeline = extractRows<{ row: Record<string, unknown> }>(
        await tx.execute(drizzleSql`
          SELECT to_jsonb(t) AS row FROM ${drizzleSql.raw(rel("kernel", "timeline_entries"))} t
           WHERE t.org_id = ${d.orgId}::uuid AND t.entity_type = 'contact' AND t.entity_id = ${id}`),
      ).map((r) => r.row)
      backup.deleted.push({ row: row.row, conversationLinks, timeline })
    }
    const current = async (id: string) =>
      extractRows<{ owner: string | null; access: string }>(
        await tx.execute(drizzleSql`
          SELECT owner_user_id::text AS owner, org_access AS access FROM ${contactsRel} WHERE id = ${id}::uuid`),
      )[0]
    for (const id of plan.orphans) {
      const c = await current(id)
      backup.reassigned.push({
        id,
        ownerUserId: c.owner,
        orgAccess: c.access,
        newOwnerUserId: d.orphansTo,
      })
    }
    for (const p of plan.privatize) {
      const c = await current(p.id)
      backup.reassigned.push({
        id: p.id,
        ownerUserId: c.owner,
        orgAccess: c.access,
        newOwnerUserId: p.ownerUserId,
      })
    }
    // The backup exists, complete, before a single row changes.
    writeFileSync(d.backupPath, `${JSON.stringify(backup)}\n`, { flag: "wx", mode: 0o600 })

    for (const item of backup.deleted) {
      const id = String(item.row.id)
      for (const link of item.conversationLinks) {
        await tx.execute(drizzleSql`
          UPDATE ${drizzleSql.raw(conversations)} SET contact_id = NULL, updated_at = now()
           WHERE id = ${link.id}::uuid AND org_id = ${d.orgId}::uuid`)
        await tx.queueEvent({
          app: "mail",
          entity: "conversation",
          action: "update",
          entityId: link.id,
          orgId: d.orgId,
          actorId: d.actorId,
          actorType: d.actorId ? "user" : "system",
          data: { id: link.id, accountId: link.account_id, contactId: null },
        })
      }
      await deleteContact(
        tx as never,
        {
          orgId: d.orgId,
          userId: d.actorId as string,
          contactId: id,
        },
        tx,
      )
    }
    for (const r of backup.reassigned) {
      await assignContactSharingAsKernel(tx as never, {
        orgId: d.orgId,
        contactId: r.id,
        ownerUserId: r.newOwnerUserId,
        orgAccess: "none",
        actorId: d.actorId,
        reason: plan.orphans.includes(r.id)
          ? "provenance decision: orphan contact made private"
          : "provenance decision: personal-mailbox sender made private",
      })
    }
    return {
      deleted: backup.deleted.length,
      orphansMadePrivate: plan.orphans.length,
      privatized: plan.privatize.length,
      backup: d.backupPath,
    }
  })
}

export async function restoreProvenance(
  orgId: string,
  backupPath: string,
): Promise<{ restored: number; reverted: number; skipped: number }> {
  const backup = JSON.parse(readFileSync(backupPath, "utf8")) as Backup
  if (backup.version !== 3) throw new Error(`unknown backup version ${String(backup.version)}`)
  if (backup.orgId !== orgId) throw new Error(`backup belongs to org ${backup.orgId}, not ${orgId}`)
  return withPrivilegedDb(orgId, "contacts-provenance:restore", async (tx) => {
    const contactsRel = drizzleSql.raw(rel("kernel", "contacts"))
    let restored = 0
    let skipped = 0
    // Every stored column (a generated one, such as org_wide, is not written).
    const columns = extractRows<{ name: string }>(
      await tx.execute(drizzleSql`
        SELECT column_name AS name FROM information_schema.columns
         WHERE table_schema = ${schemaRef("kernel")} AND table_name = 'contacts'
           AND is_generated = 'NEVER'
         ORDER BY ordinal_position`),
    ).map((c) => quoteIdent(c.name))
    const columnList = drizzleSql.raw(columns.join(", "))
    for (const item of backup.deleted) {
      // Same id, same handle. An address taken again since wins: skipped.
      const back = extractRows<{
        id: string
        email: string | null
        name: string | null
        handle: string
      }>(
        await tx.execute(drizzleSql`
          INSERT INTO ${contactsRel} (${columnList})
          SELECT ${columnList} FROM jsonb_populate_record(NULL::${contactsRel}, ${JSON.stringify(item.row)}::jsonb)
          ON CONFLICT DO NOTHING
          RETURNING id::text AS id, email, name, handle`),
      )
      if (back.length === 0) {
        skipped++
        continue
      }
      restored++
      const id = back[0].id
      if (item.timeline.length > 0) {
        await tx.execute(drizzleSql`
          INSERT INTO ${drizzleSql.raw(rel("kernel", "timeline_entries"))}
          SELECT * FROM jsonb_populate_recordset(NULL::${drizzleSql.raw(rel("kernel", "timeline_entries"))}, ${JSON.stringify(item.timeline)}::jsonb)
          ON CONFLICT DO NOTHING`)
      }
      for (const link of item.conversationLinks) {
        const relinked = extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
            UPDATE ${drizzleSql.raw(rel("app_mail", "conversations"))} SET contact_id = ${id}::uuid, updated_at = now()
             WHERE org_id = ${orgId}::uuid AND id = ${link.id}::uuid AND contact_id IS NULL
            RETURNING id::text AS id`),
        )
        if (relinked.length === 0) continue
        await tx.queueEvent({
          app: "mail",
          entity: "conversation",
          action: "update",
          entityId: link.id,
          orgId,
          actorId: null,
          actorType: "system",
          data: { id: link.id, accountId: link.account_id, contactId: id },
        })
      }
      await recomputeSearchAcl(tx, "kernel.contact", id)
      await tx.queueEvent({
        app: "kernel",
        entity: "contact",
        action: "create",
        entityId: id,
        orgId,
        actorId: null,
        actorType: "system",
        data: { email: back[0].email, name: back[0].name, handle: back[0].handle },
      })
    }
    let reverted = 0
    for (const r of backup.reassigned) {
      // Only a contact still as the decision left it.
      const [still] = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          SELECT id::text AS id FROM ${contactsRel}
           WHERE org_id = ${orgId}::uuid AND id = ${r.id}::uuid
             AND org_access = 'none' AND owner_user_id = ${r.newOwnerUserId}::uuid
           FOR UPDATE`),
      )
      if (!still) {
        skipped++
        continue
      }
      await assignContactSharingAsKernel(tx as never, {
        orgId,
        contactId: r.id,
        ownerUserId: r.ownerUserId,
        orgAccess: r.orgAccess as "none" | "viewer" | "editor",
        actorId: null,
        reason: "restore-provenance",
      })
      reverted++
    }
    return { restored, reverted, skipped }
  })
}

interface Args {
  mode: "apply" | "restore"
  orgId: string
  deleteUnusedCreatedBy: string | null
  orphansTo: string | null
  actorId: string | null
  execute: boolean
  plan: string | null
  planOut: string | null
  backup: string | null
}

export function parseProvenanceArgv(
  mode: "apply" | "restore",
  argv: string[],
): { ok: true; args: Args } | { ok: false; error: string } {
  const args: Args = {
    mode,
    orgId: "",
    deleteUnusedCreatedBy: null,
    orphansTo: null,
    actorId: null,
    execute: false,
    plan: null,
    planOut: null,
    backup: null,
  }
  const valued: Record<string, keyof Args> = {
    "--org": "orgId",
    "--delete-unused-created-by": "deleteUnusedCreatedBy",
    "--orphans-to": "orphansTo",
    "--actor": "actorId",
    "--plan": "plan",
    "--plan-out": "planOut",
    "--backup": "backup",
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === "--execute" && mode === "apply") {
      args.execute = true
      continue
    }
    const key = valued[flag]
    if (!key) return { ok: false, error: `unknown option ${flag}` }
    const value = argv[i + 1]
    if (!value || value.startsWith("--")) return { ok: false, error: `${flag} requires a value` }
    ;(args as unknown as Record<string, unknown>)[key] = value
    i++
  }
  if (!UUID.test(args.orgId)) return { ok: false, error: "--org <uuid> is required" }
  if (mode === "restore") {
    return args.backup ? { ok: true, args } : { ok: false, error: "--backup <path> is required" }
  }
  for (const [flag, v] of [
    ["--delete-unused-created-by", args.deleteUnusedCreatedBy],
    ["--orphans-to", args.orphansTo],
  ] as const) {
    if (!v || !UUID.test(v)) return { ok: false, error: `${flag} <user uuid> is required` }
  }
  if (args.actorId && !UUID.test(args.actorId))
    return { ok: false, error: "--actor must be a uuid" }
  if (args.execute && (!args.plan || !args.backup)) {
    return {
      ok: false,
      error: "--execute requires --plan <reviewed dry-run json> and --backup <new file>",
    }
  }
  return { ok: true, args }
}

export async function runProvenanceCli(
  mode: "apply" | "restore",
  argv: string[],
  deps: { write?: (line: string) => void; writeErr?: (line: string) => void } = {},
): Promise<number> {
  const write = deps.write ?? ((line: string) => process.stdout.write(line))
  const writeErr = deps.writeErr ?? ((line: string) => process.stderr.write(line))
  const parsed = parseProvenanceArgv(mode, argv)
  if (!parsed.ok) {
    writeErr(`${parsed.error}\n${PROVENANCE_USAGE}\n`)
    return 2
  }
  const a = parsed.args
  try {
    if (mode === "restore") {
      const result = await restoreProvenance(a.orgId, a.backup as string)
      write(`${JSON.stringify({ orgId: a.orgId, ...result }, null, 2)}\n`)
      log.warn({ orgId: a.orgId, ...result }, "restored contacts provenance decisions")
      return 0
    }
    const decisions = {
      orgId: a.orgId,
      deleteUnusedCreatedBy: a.deleteUnusedCreatedBy as string,
      orphansTo: a.orphansTo as string,
    }
    if (!a.execute) {
      writeErr(`DRY RUN for org ${a.orgId} (read-only transaction). Nothing will be written.\n`)
      const plan = await planProvenance(decisions)
      write(`${JSON.stringify(plan, null, 2)}\n`)
      if (a.planOut) {
        // The file --execute --plan reads back (stdout also carries log lines).
        writeFileSync(a.planOut, `${JSON.stringify(plan)}\n`, { flag: "wx", mode: 0o600 })
        writeErr(`Plan written to ${a.planOut}.\n`)
      }
      writeErr(
        "Review the plan, then re-run with --execute --plan <this json> --backup <new file>.\n",
      )
      return 0
    }
    const reviewedPlan = JSON.parse(readFileSync(a.plan as string, "utf8")) as ProvenancePlan
    const result = await applyProvenance({
      ...decisions,
      actorId: a.actorId,
      reviewedPlan,
      backupPath: a.backup as string,
    })
    write(`${JSON.stringify({ orgId: a.orgId, ...result }, null, 2)}\n`)
    writeErr(
      `Backup written to ${result.backup} (mode 0600, holds names and addresses). Keep it until the change is accepted; restore with restore-provenance.\n`,
    )
    log.warn({ orgId: a.orgId, ...result }, "applied contacts provenance decisions")
    return 0
  } catch (error) {
    writeErr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
