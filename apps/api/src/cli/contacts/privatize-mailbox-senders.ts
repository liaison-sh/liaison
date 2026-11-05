// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison contacts privatize-mailbox-senders --org <uuid> [--print-sql | --execute --backup <path>]`
// `liaison contacts restore-privatized-senders --org <uuid> --backup <path>`
//
// The one-time cleanup for design audit 2026-09-30 #6, in the sharing model
// (modules/sharing, migration 0117). Until then every inbound sender of EVERY
// mailbox became an organisation contact, personal mailboxes included: a
// person's correspondents became readable by every member. Mail sync now keeps
// such a sender private to the mailbox's owner (modules/mail/sender-contacts.ts);
// this does the same for what it already created, without deleting anything:
// each such contact becomes its owner's alone (org_access 'none', owner = the
// personal mailbox's owner), who can share it again in one click.
//
// PROVENANCE. Every org-visible contact is classified (`classificationSql`):
//   (a) org-intended: a team object uses it (a ticket, a CSAT answer, an
//       invoicing document, relationship or thread, a file, a thread
//       reference, a knowledge collection or tag), an app created it
//       (external ids), or it wrote to a shared mailbox;
//   (b) personal source: a system actor created it (mail sync), it carries
//       only a name and an address, nobody changed it since, and its only
//       mail is to ONE person's personal mailbox(es), received after that
//       mailbox was connected. Only these are privatized, to that person;
//   (c) unclear, with the reason: created by a person but used by nothing,
//       creator gone, several people's personal mail, extra fields, edited,
//       or no mailbox evidence. Left as they are for a human to decide.
//
// SAFETY. A dry run unless `--execute`: its transaction is READ ONLY, and it
// prints counts per class, per reason and per owner (a staff member's name),
// never a contact's name or address.
// `--print-sql` prints the classification statement for a read-only run
// elsewhere. `--execute` requires `--backup <path>` to a file that does not
// exist yet; each changed row's previous sharing is written there (mode 0600)
// BEFORE anything changes, in the same transaction. `restore-privatized-senders`
// puts it back, skipping a contact whose address has an org contact again.
// Changes are announced as `contact:share` events: audited, and search
// reindexes each contact under its new ACL. Not for production without the
// owner's decision: run the dry run there, never `--execute` by default.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { rootLogger } from "~/lib/logger"
import {
  type ContactReference,
  ORG_USE_REFERENCES,
  predicateSql,
  presentReferences,
  rel,
} from "~/modules/contacts/references"
import { assignContactSharingAsKernel } from "~/modules/contacts/sharing"

const log = rootLogger.child({ module: "contacts-privatize-mailbox-senders" })

export const PRIVATIZE_USAGE =
  "usage: liaison contacts privatize-mailbox-senders --org <uuid> [--print-sql | --execute --backup <new file path>]\n" +
  "       liaison contacts restore-privatized-senders --org <uuid> --backup <path>"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ProvenanceClass = "org_intended" | "personal_source" | "unclear"

/**
 * One row per org-visible contact: `id`, `class`, `reason`, `owner_id` (the
 * would-be owner, personal_source only). Text, with the org id validated and
 * inlined, so the dry run and an operator's read-only run execute the same
 * statement. Restricted contacts (already someone's) are not listed.
 */
export function classificationSql(
  orgId: string,
  references: ReadonlyArray<ContactReference>,
): string {
  if (!UUID.test(orgId)) throw new Error(`not a uuid: ${orgId}`)
  const contacts = rel("kernel", "contacts")
  const users = rel("kernel", "users")
  const accounts = rel("app_mail", "accounts")
  const conversations = rel("app_mail", "conversations")
  const messages = rel("app_mail", "messages")
  const audit = rel("kernel", "audit_log")
  const used =
    references.length === 0
      ? "false"
      : references
          .map(
            (ref) =>
              `EXISTS (SELECT 1 FROM ${rel(ref.schema, ref.table)} r WHERE ${predicateSql(ref)})`,
          )
          .join("\n        OR ")
  return `WITH c AS (
  SELECT * FROM ${contacts} WHERE org_id = '${orgId}'::uuid AND org_access <> 'none'
),
personal AS (
  -- Owners of the personal mailboxes that received mail from the address
  -- after they were connected.
  SELECT c.id, array_agg(DISTINCT a.owner_id::text ORDER BY a.owner_id::text) AS owners
    FROM c
    JOIN ${messages} m ON m.org_id = c.org_id AND m.direction = 'inbound'
                      AND LOWER(m.from_address ->> 'email') = LOWER(c.email)
    JOIN ${accounts} a ON a.id = m.account_id AND a.owner_type = 'user'
                      AND a.owner_id IS NOT NULL AND c.created_at >= a.created_at
   GROUP BY c.id
),
facts AS (
  SELECT c.id, c.email, c.created_by,
         (${used}) AS used,
         COALESCE(c.external_ids, '{}'::jsonb) <> '{}'::jsonb AS from_app,
         EXISTS (
           SELECT 1 FROM ${messages} m JOIN ${accounts} a ON a.id = m.account_id
            WHERE m.org_id = c.org_id AND a.owner_type <> 'user'
              AND LOWER(m.from_address ->> 'email') = LOWER(c.email))
         OR EXISTS (
           SELECT 1 FROM ${conversations} v JOIN ${accounts} a ON a.id = v.account_id
            WHERE v.org_id = c.org_id AND a.owner_type <> 'user' AND v.contact_id = c.id)
           AS shared_mailbox,
         EXISTS (SELECT 1 FROM ${users} u WHERE u.id = c.created_by) AS creator_exists,
         (c.phone IS NOT NULL OR c.company IS NOT NULL OR COALESCE(cardinality(c.tags), 0) > 0
          OR (c.metadata IS NOT NULL AND c.metadata <> '{}'::jsonb)) AS extra_fields,
         (c.updated_at > c.created_at + interval '1 minute' OR EXISTS (
            SELECT 1 FROM ${audit} l
             WHERE l.org_id = c.org_id AND l.entity_type = 'contact' AND l.entity_id = c.id::text
               AND (l.action <> 'contact.create' OR l.actor_id IS NOT NULL))) AS edited,
         p.owners,
         -- A link from a conversation in a mailbox other than the owner's.
         EXISTS (
           SELECT 1 FROM ${conversations} v JOIN ${accounts} a ON a.id = v.account_id
            WHERE v.org_id = c.org_id AND v.contact_id = c.id
              AND (a.owner_type <> 'user' OR p.owners IS NULL
                   OR a.owner_id::text <> ALL (p.owners))) AS foreign_links
    FROM c LEFT JOIN personal p ON p.id = c.id
)
SELECT id::text AS id,
       CASE
         WHEN used OR from_app OR shared_mailbox THEN 'org_intended'
         WHEN created_by IS NULL AND email IS NOT NULL AND owners IS NOT NULL
              AND cardinality(owners) = 1 AND NOT extra_fields AND NOT edited
              AND NOT foreign_links THEN 'personal_source'
         ELSE 'unclear'
       END AS class,
       CASE
         WHEN used THEN 'used by a team object'
         WHEN from_app THEN 'created by an app'
         WHEN shared_mailbox THEN 'wrote to a shared mailbox'
         WHEN created_by IS NOT NULL AND creator_exists
           THEN 'created by a person, not used by any team object'
         WHEN created_by IS NOT NULL THEN 'creator no longer exists, not used by any team object'
         WHEN email IS NULL OR owners IS NULL THEN 'created by the system, no personal mailbox mail from it'
         WHEN cardinality(owners) > 1 THEN 'wrote to several people''s personal mailboxes'
         WHEN extra_fields THEN 'personal mailbox sender, but carries fields mail sync never sets'
         WHEN edited THEN 'personal mailbox sender, but edited since it was created'
         WHEN foreign_links THEN 'personal mailbox sender, but linked from another mailbox'
         ELSE 'personal mailbox sender'
       END AS reason,
       CASE WHEN owners IS NOT NULL AND cardinality(owners) = 1 THEN owners[1] END AS owner_id
  FROM facts
 ORDER BY 2, 3, 1`
}

export interface ClassifiedRow {
  id: string
  class: ProvenanceClass
  reason: string
  owner_id: string | null
}

export async function classify(
  tx: Pick<PrivilegedDb, "execute">,
  orgId: string,
): Promise<ClassifiedRow[]> {
  const references = await presentReferences(tx, ORG_USE_REFERENCES)
  return extractRows<ClassifiedRow>(
    await tx.execute(drizzleSql.raw(classificationSql(orgId, references))),
  )
}

export interface PrivatizeInspection {
  byClass: Record<ProvenanceClass, number>
  byReason: Record<string, number>
  /** Personal-source contacts per would-be owner (user id and name). */
  byOwner: Array<{ ownerId: string; name: string | null; contacts: number }>
  /** Personal-source contacts the owner already has a private copy of: skipped. */
  alreadyPrivateCopy: number
  ids: string[]
}

export async function inspect(
  tx: Pick<PrivilegedDb, "execute">,
  orgId: string,
): Promise<{ inspection: PrivatizeInspection; rows: ClassifiedRow[] }> {
  const rows = await classify(tx, orgId)
  const byClass: Record<ProvenanceClass, number> = {
    org_intended: 0,
    personal_source: 0,
    unclear: 0,
  }
  const byReason: Record<string, number> = {}
  const owners = new Map<string, number>()
  for (const row of rows) {
    byClass[row.class]++
    byReason[row.reason] = (byReason[row.reason] ?? 0) + 1
    if (row.class === "personal_source" && row.owner_id) {
      owners.set(row.owner_id, (owners.get(row.owner_id) ?? 0) + 1)
    }
  }
  const personal = rows.filter((r) => r.class === "personal_source")
  const ownerIds = [...owners.keys()]
  const names = new Map(
    ownerIds.length === 0
      ? []
      : extractRows<{ id: string; name: string | null }>(
          await tx.execute(drizzleSql`
            SELECT id::text AS id, name FROM ${drizzleSql.raw(rel("kernel", "users"))}
             WHERE id IN (${drizzleSql.join(
               ownerIds.map((id) => drizzleSql`${id}::uuid`),
               drizzleSql`, `,
             )})`),
        ).map((u) => [u.id, u.name]),
  )
  // An owner who already holds a private contact for the address keeps that
  // one; the org copy stays for a human to merge.
  const dup = new Set(
    personal.length === 0
      ? []
      : extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
            SELECT c.id::text AS id FROM ${drizzleSql.raw(rel("kernel", "contacts"))} c
             WHERE c.id IN (${drizzleSql.join(
               personal.map((r) => drizzleSql`${r.id}::uuid`),
               drizzleSql`, `,
             )})
               AND EXISTS (
                 SELECT 1 FROM ${drizzleSql.raw(rel("kernel", "contacts"))} p
                  WHERE p.org_id = c.org_id AND p.org_access = 'none'
                    AND LOWER(p.email) = LOWER(c.email) AND p.id <> c.id
                    AND p.owner_user_id IS NOT NULL AND p.audience_key IS NULL)`),
        ).map((r) => r.id),
  )
  return {
    rows,
    inspection: {
      byClass,
      byReason,
      byOwner: ownerIds.map((ownerId) => ({
        ownerId,
        name: names.get(ownerId) ?? null,
        contacts: owners.get(ownerId) ?? 0,
      })),
      alreadyPrivateCopy: dup.size,
      ids: personal.filter((r) => !dup.has(r.id)).map((r) => r.id),
    },
  }
}

/** The dry run. Its transaction is READ ONLY: it cannot write, whatever it runs. */
export async function inspectPrivatize(orgId: string): Promise<PrivatizeInspection> {
  return withPrivilegedDb(orgId, "contacts-privatize:dry-run", async (tx) => {
    await tx.execute(drizzleSql`SET LOCAL transaction_read_only = on`)
    return (await inspect(tx, orgId)).inspection
  })
}

interface BackupRow {
  id: string
  email: string | null
  org_access: string
  owner_user_id: string | null
  /** The owner it was given. */
  new_owner_user_id: string
}

interface Backup {
  version: 2
  orgId: string
  createdAt: string
  contacts: BackupRow[]
}

export interface PrivatizeResult {
  privatized: number
  skipped: number
  byOwner: PrivatizeInspection["byOwner"]
  backup: string
}

export async function executePrivatize(
  orgId: string,
  backupPath: string,
): Promise<PrivatizeResult> {
  if (existsSync(backupPath)) throw new Error(`backup file already exists: ${backupPath}`)
  return withPrivilegedDb(orgId, "contacts-privatize:execute", async (tx) => {
    const { inspection, rows } = await inspect(tx, orgId)
    const ownerOf = new Map(rows.map((r) => [r.id, r.owner_id]))
    const contactsRel = drizzleSql.raw(rel("kernel", "contacts"))
    const ids = inspection.ids
    // Locked: nothing re-shares or re-references them between copy and change.
    const before =
      ids.length === 0
        ? []
        : extractRows<Omit<BackupRow, "new_owner_user_id">>(
            await tx.execute(drizzleSql`
              SELECT id::text AS id, email, org_access, owner_user_id::text AS owner_user_id
                FROM ${contactsRel}
               WHERE org_id = ${orgId}::uuid AND id IN (${drizzleSql.join(
                 ids.map((id) => drizzleSql`${id}::uuid`),
                 drizzleSql`, `,
               )})
               FOR UPDATE`),
          )
    const backup: Backup = {
      version: 2,
      orgId,
      createdAt: new Date().toISOString(),
      contacts: before.map((row) => ({
        ...row,
        new_owner_user_id: ownerOf.get(row.id) as string,
      })),
    }
    // The backup exists, complete, before a single row changes. A failure to
    // write it aborts the transaction.
    writeBackup(backupPath, backup)

    for (const row of backup.contacts) {
      await assignContactSharingAsKernel(tx as never, {
        orgId,
        contactId: row.id,
        ownerUserId: row.new_owner_user_id,
        orgAccess: "none",
        actorId: null,
        reason: "privatize-mailbox-senders",
      })
    }
    return {
      privatized: backup.contacts.length,
      skipped: inspection.alreadyPrivateCopy,
      byOwner: inspection.byOwner,
      backup: backupPath,
    }
  })
}

function writeBackup(path: string, backup: Backup): void {
  // `wx`: never overwrite an earlier backup. 0600: it holds addresses.
  writeFileSync(path, `${JSON.stringify(backup)}\n`, { flag: "wx", mode: 0o600 })
}

export interface RestoreResult {
  restored: number
  skipped: number
}

export async function restorePrivatize(orgId: string, backupPath: string): Promise<RestoreResult> {
  const backup = JSON.parse(readFileSync(backupPath, "utf8")) as Backup
  if (backup.version !== 2) throw new Error(`unknown backup version ${String(backup.version)}`)
  if (backup.orgId !== orgId) {
    throw new Error(`backup belongs to org ${backup.orgId}, not ${orgId}`)
  }
  return withPrivilegedDb(orgId, "contacts-privatize:restore", async (tx) => {
    const contactsRel = drizzleSql.raw(rel("kernel", "contacts"))
    let restored = 0
    for (const row of backup.contacts) {
      // Only a contact still as the privatization left it, and only while no
      // org contact has taken its address since (the newer one wins).
      const still = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          SELECT c.id::text AS id FROM ${contactsRel} c
           WHERE c.org_id = ${orgId}::uuid AND c.id = ${row.id}::uuid
             AND c.org_access = 'none' AND c.owner_user_id = ${row.new_owner_user_id}::uuid
             AND NOT EXISTS (
               SELECT 1 FROM ${contactsRel} o
                WHERE o.org_id = c.org_id AND o.org_access <> 'none' AND o.id <> c.id
                  AND LOWER(o.email) = LOWER(c.email))
           FOR UPDATE`),
      )
      if (still.length === 0) continue
      restored++
      await assignContactSharingAsKernel(tx as never, {
        orgId,
        contactId: row.id,
        ownerUserId: row.owner_user_id,
        orgAccess: row.org_access as "none" | "viewer" | "editor",
        actorId: null,
        reason: "restore-privatized-senders",
      })
    }
    return { restored, skipped: backup.contacts.length - restored }
  })
}

export interface PrivatizeArgs {
  mode: "privatize" | "restore"
  orgId: string
  execute: boolean
  backup: string | null
  printSql: boolean
}

export function parsePrivatizeArgv(
  mode: "privatize" | "restore",
  argv: string[],
): { ok: true; args: PrivatizeArgs } | { ok: false; error: string } {
  let orgId: string | null = null
  let backup: string | null = null
  let execute = false
  let printSql = false
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === "--execute" && mode === "privatize") {
      execute = true
      continue
    }
    if (flag === "--print-sql" && mode === "privatize") {
      printSql = true
      continue
    }
    if (flag === "--org" || flag === "--backup") {
      const value = argv[i + 1]
      if (!value || value.startsWith("--")) return { ok: false, error: `${flag} requires a value` }
      if (flag === "--org") orgId = value
      else backup = value
      i++
      continue
    }
    return { ok: false, error: `unknown option ${flag}` }
  }
  if (!orgId || !UUID.test(orgId)) return { ok: false, error: "--org <uuid> is required" }
  if ((execute || mode === "restore") && !backup) {
    return { ok: false, error: "--backup <path> is required" }
  }
  return { ok: true, args: { mode, orgId, execute, backup, printSql } }
}

export async function runPrivatizeMailboxSendersCli(
  mode: "privatize" | "restore",
  argv: string[],
  deps: { write?: (line: string) => void; writeErr?: (line: string) => void } = {},
): Promise<number> {
  const write = deps.write ?? ((line: string) => process.stdout.write(line))
  const writeErr = deps.writeErr ?? ((line: string) => process.stderr.write(line))
  const parsed = parsePrivatizeArgv(mode, argv)
  if (!parsed.ok) {
    writeErr(`${parsed.error}\n${PRIVATIZE_USAGE}\n`)
    return 2
  }
  const { orgId, execute, backup, printSql } = parsed.args
  try {
    if (mode === "restore") {
      const result = await restorePrivatize(orgId, backup as string)
      write(`${JSON.stringify({ orgId, ...result }, null, 2)}\n`)
      log.warn({ orgId, ...result }, "restored privatized mailbox-sender contacts")
      return 0
    }
    if (printSql) {
      // The statement with EVERY referencing table, for a read-only run elsewhere.
      write(`${classificationSql(orgId, ORG_USE_REFERENCES)};\n`)
      return 0
    }
    if (!execute) {
      writeErr(`DRY RUN for org ${orgId} (read-only transaction). Nothing will be written.\n`)
      const { ids: _ids, ...report } = await inspectPrivatize(orgId)
      write(`${JSON.stringify({ dryRun: true, orgId, ...report }, null, 2)}\n`)
      writeErr(
        "Re-run with --execute --backup <new file> to privatize, restore-privatized-senders to undo.\n",
      )
      return 0
    }
    const result = await executePrivatize(orgId, backup as string)
    write(`${JSON.stringify({ orgId, ...result }, null, 2)}\n`)
    writeErr(
      `Backup written to ${result.backup} (mode 0600, holds addresses). Keep it until the change ` +
        "is accepted: if that path is not on a mounted volume (the standard deploy mounts " +
        "/var/lib/liaison), copy it out with `docker cp <container>:" +
        `${result.backup} .\` before the container is replaced.\n`,
    )
    log.warn(
      { orgId, privatized: result.privatized },
      "privatized contacts created by personal mailboxes",
    )
    return 0
  } catch (error) {
    writeErr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
