// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task 4.6 and Task 4.7. The post-schema-sync assertion step, driven in the REAL
// deploy order.
//
// The prod deploy runs the `migrate` one-shot ONCE, before the app containers are
// recreated. On the deploy that introduces mailbox encryption the ciphertext and
// `encryption_state` columns therefore do not exist yet when the migrations run.
// 0032 (ciphertext storage) and 0036 (the pending_enrollment transition) are
// guarded on exactly those columns, so both no-op, record their journal row, and
// never run again. Left there, every existing personal mailbox would sit at
// `encryption_state = 'none'` forever with no error and no alert. That is why the
// boot step exists, and the assertion below is checked rather than assumed.
//
// So the drill is: degrade the schema to its pre-deploy shape, run the four
// migrations in the real order and record which of them actually applied, let the
// manifest's own ALTER path add the columns the way registration does, then run the
// boot step and assert it repaired all four facts. Asserting the pre-state was
// actually wrong is part of the test: a fixture that was already correct must not
// be able to pass.
//
// The whole drill runs inside one transaction that is rolled back, so it can be run
// against a shared test database without disturbing the live app_mail schema.

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { withSystemDb } from "~/db/privileged"
import { generateAlterTableDdl } from "~/modules/apps/ddl"
import { assertMailboxSchemaState } from "~/modules/mailbox-crypto/post-sync-assertions"

const MIGRATIONS = path.resolve(import.meta.dir, "../../db/migrations")
const MIGRATION_TAGS = [
  "0032_mailbox_ciphertext_storage_external",
  "0034_mailbox_invariant_helper",
  "0035_drafts_plaintext_nullable",
  "0036_mail_accounts_pending_enrollment",
]

const SCHEMA = "app_mail"
const ORG_ID = "00000000-0000-0000-0000-0000000b4600"
const PERSONAL_USER_ID = "00000000-0000-0000-0000-0000000b4601"
const CONN_ID = "00000000-0000-0000-0000-0000000b4602"
const PERSONAL_ACCT = "00000000-0000-0000-0000-0000000b4603"
const ORG_ACCT = "00000000-0000-0000-0000-0000000b4604"

/** Every ciphertext column, per table. Mirrors the module's own literals. */
const CIPHERTEXT_COLUMNS: Record<string, string[]> = {
  messages: [
    "text_body_ciphertext",
    "html_body_ciphertext",
    "subject_ciphertext",
    "snippet_ciphertext",
    "raw_headers_ciphertext",
    "content_key_wrapped",
    "content_key_epk",
  ],
  conversations: [
    "subject_ciphertext",
    "snippet_ciphertext",
    "content_key_wrapped",
    "content_key_epk",
  ],
  drafts: ["body_ciphertext", "subject_ciphertext", "content_key_wrapped", "content_key_epk"],
}

const DRAFT_PLAINTEXT_COLUMNS = ["subject", "html_body", "text_body"]

class Rollback extends Error {}

interface Tx {
  execute(query: unknown): Promise<unknown>
}

function rowsOf(res: unknown): Record<string, unknown>[] {
  return (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as Record<
    string,
    unknown
  >[]
}

async function q(tx: Tx, text: string): Promise<Record<string, unknown>[]> {
  return rowsOf(await tx.execute(drizzleSql.raw(text)))
}

async function helperNames(tx: Tx): Promise<string[]> {
  const rows = await q(
    tx,
    `SELECT p.proname, p.prosecdef, r.rolname AS owner
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_roles r ON r.oid = p.proowner
      WHERE n.nspname = '${SCHEMA}'
        AND p.proname IN ('mailbox_invariant_armed', 'mailbox_account_exists', 'mailbox_owner_enrolled')
        AND p.prosecdef AND r.rolname = 'liaison_admin'
      ORDER BY p.proname`,
  )
  return rows.map((r) => String(r.proname))
}

async function draftNullability(tx: Tx): Promise<Record<string, unknown>[]> {
  return q(
    tx,
    `SELECT column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = '${SCHEMA}' AND table_name = 'drafts'
        AND column_name IN ('subject', 'html_body', 'text_body')
      ORDER BY column_name`,
  )
}

async function nonExternalCiphertextColumns(tx: Tx): Promise<string[]> {
  const out: string[] = []
  for (const [table, columns] of Object.entries(CIPHERTEXT_COLUMNS)) {
    const rows = await q(
      tx,
      `SELECT a.attname, a.attstorage FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = '${SCHEMA}' AND c.relname = '${table}'
          AND a.attname IN (${columns.map((c) => `'${c}'`).join(", ")})
          AND NOT a.attisdropped AND a.attstorage <> 'e'`,
    )
    for (const r of rows) out.push(`${table}.${String(r.attname)}`)
  }
  return out
}

/** Roll the schema back to the shape it had before this feature's deploy. */
async function degradeToPreDeploy(tx: Tx): Promise<void> {
  for (const [table, columns] of Object.entries(CIPHERTEXT_COLUMNS)) {
    for (const column of columns) {
      await tx.execute(
        drizzleSql.raw(`ALTER TABLE ${SCHEMA}.${table} DROP COLUMN IF EXISTS ${column}`),
      )
    }
  }
  for (const column of ["enc_key_id", "enc_version", "plaintext_purged_at"]) {
    for (const table of ["messages", "conversations", "drafts"]) {
      await tx.execute(
        drizzleSql.raw(`ALTER TABLE ${SCHEMA}.${table} DROP COLUMN IF EXISTS ${column}`),
      )
    }
  }
  await tx.execute(
    drizzleSql.raw(`ALTER TABLE ${SCHEMA}.accounts DROP COLUMN IF EXISTS encryption_state`),
  )
  await tx.execute(
    drizzleSql.raw(`DROP FUNCTION IF EXISTS ${SCHEMA}.mailbox_invariant_armed(uuid)`),
  )
  await tx.execute(drizzleSql.raw(`DROP FUNCTION IF EXISTS ${SCHEMA}.mailbox_account_exists(uuid)`))
  await tx.execute(drizzleSql.raw(`DROP FUNCTION IF EXISTS ${SCHEMA}.mailbox_owner_enrolled(uuid)`))
  await restoreDraftPlaintextNotNull(tx)
}

/** Put the draft plaintext columns back to NOT NULL DEFAULT '', their shape
 *  before the feature. A shared test database can hold drafts other tests
 *  committed with NULL plaintext (a sealed draft), so the backfill has to
 *  rewrite rows. The schema before the feature had no plaintext invariant
 *  trigger, and with its helpers dropped (or `encryption_state` gone) the
 *  trigger cannot run, so the backfill runs with that trigger disabled, the
 *  way the pre-deploy table would take it. The drill's transaction rolls back. */
async function restoreDraftPlaintextNotNull(tx: Tx): Promise<void> {
  await tx.execute(
    drizzleSql.raw(
      `ALTER TABLE ${SCHEMA}.drafts DISABLE TRIGGER enforce_mailbox_plaintext_invariant`,
    ),
  )
  for (const column of DRAFT_PLAINTEXT_COLUMNS) {
    await tx.execute(
      drizzleSql.raw(`UPDATE ${SCHEMA}.drafts SET ${column} = '' WHERE ${column} IS NULL`),
    )
    await tx.execute(
      drizzleSql.raw(`ALTER TABLE ${SCHEMA}.drafts ALTER COLUMN ${column} SET DEFAULT ''`),
    )
    await tx.execute(
      drizzleSql.raw(`ALTER TABLE ${SCHEMA}.drafts ALTER COLUMN ${column} SET NOT NULL`),
    )
  }
  await tx.execute(
    drizzleSql.raw(
      `ALTER TABLE ${SCHEMA}.drafts ENABLE TRIGGER enforce_mailbox_plaintext_invariant`,
    ),
  )
}

/** The manifest's own ALTER path, exactly as app registration runs it. */
async function applyManifestAlter(tx: Tx): Promise<void> {
  const schema = (mailAppManifest as unknown as { schema: Record<string, { fields: unknown }> })
    .schema
  for (const entity of ["accounts", "conversations", "messages", "drafts"]) {
    const ddl = generateAlterTableDdl(
      SCHEMA,
      entity,
      schema[entity].fields as Record<string, unknown>,
    )
    for (const stmt of ddl.split(";\n").filter((s) => s.trim())) {
      await tx.execute(drizzleSql.raw(stmt))
    }
  }
}

/** Age a personal row back to `none`, the state every mailbox had before the
 *  feature. The accounts INSERT trigger now stamps a personal row `ready` or
 *  `pending_enrollment` at birth, so a drill that needs the pre-feature shape
 *  has to set it explicitly, and only when the column exists at all. */
async function ageToLegacyNone(tx: Tx, accountId: string): Promise<void> {
  await tx.execute(
    drizzleSql.raw(`DO $legacy$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = '${SCHEMA}' AND table_name = 'accounts'
                    AND column_name = 'encryption_state') THEN
        UPDATE ${SCHEMA}.accounts SET encryption_state = 'none' WHERE id = '${accountId}';
      END IF;
    END $legacy$`),
  )
}

async function seedAccounts(tx: Tx): Promise<void> {
  await tx.execute(drizzleSql`
    INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG_ID}, 'Post Sync Org', 'post-sync-org') ON CONFLICT (id) DO NOTHING`)
  await tx.execute(drizzleSql`
    INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
    VALUES (${PERSONAL_USER_ID}, ${ORG_ID}, 'post-sync@test.com', 'hash', 'Post Sync', 'active')
    ON CONFLICT (id) DO NOTHING`)
  await tx.execute(drizzleSql`
    INSERT INTO kernel.connected_accounts
      (id, org_id, app_name, connection_name, owner_type, provider_type, identifier, created_by)
    VALUES (${CONN_ID}, ${ORG_ID}, 'mail', 'gmail', 'org', 'oauth2', 'post-sync', ${PERSONAL_USER_ID})
    ON CONFLICT (id) DO NOTHING`)
  await tx.execute(drizzleSql`
    INSERT INTO app_mail.accounts
      (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address, sync_status)
    VALUES (${PERSONAL_ACCT}, ${ORG_ID}, ${CONN_ID}, 'user', ${PERSONAL_USER_ID}, 'gmail',
            'post-sync-personal@test.com', 'active')`)
  await tx.execute(drizzleSql`
    INSERT INTO app_mail.accounts
      (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address, sync_status)
    VALUES (${ORG_ACCT}, ${ORG_ID}, ${CONN_ID}, 'shared', NULL, 'gmail',
            'post-sync-shared@test.com', 'active')`)
  await ageToLegacyNone(tx, PERSONAL_ACCT)
}

describe("mailbox encryption migrations, static shape", () => {
  it("every migration is guarded and registered in the journal above its predecessor", () => {
    const journal = JSON.parse(
      readFileSync(path.join(MIGRATIONS, "meta/_journal.json"), "utf8"),
    ) as { entries: { idx: number; when: number; tag: string; breakpoints: boolean }[] }
    // Non-vacuity: the journal actually parsed and carries the whole ladder.
    expect(journal.entries.length).toBeGreaterThan(30)
    for (const tag of MIGRATION_TAGS) {
      const entry = journal.entries.find((e) => e.tag === tag)
      expect(entry, `${tag} is not in the journal`).toBeDefined()
      expect((entry as { breakpoints: boolean }).breakpoints).toBe(true)
      const earlier = journal.entries.filter((e) => e.idx < (entry as { idx: number }).idx)
      const highest = Math.max(...earlier.map((e) => e.when))
      expect((entry as { when: number }).when).toBeGreaterThan(highest)
      const text = readFileSync(path.join(MIGRATIONS, `${tag}.sql`), "utf8")
      expect(text).toContain("to_regclass")
    }
  })

  it("0035 drops the default as well as the NOT NULL on all three draft columns", () => {
    const text = readFileSync(path.join(MIGRATIONS, "0035_drafts_plaintext_nullable.sql"), "utf8")
    for (const column of DRAFT_PLAINTEXT_COLUMNS) {
      expect(text).toContain(`ALTER COLUMN ${column} DROP NOT NULL`)
      expect(text).toContain(`ALTER COLUMN ${column} DROP DEFAULT`)
    }
  })

  it("0036 is idempotent by its own predicate", () => {
    const text = readFileSync(
      path.join(MIGRATIONS, "0036_mail_accounts_pending_enrollment.sql"),
      "utf8",
    )
    expect(text).toContain("encryption_state = 'none'")
    expect(text).toContain("owner_type = 'user'")
  })
})

describe("the enrollment notice never costs the app its registration", () => {
  it("skips a notice for an account whose org row is gone, and the tx survives", async () => {
    const GHOST_ORG = "00000000-0000-0000-0000-0000000b4700"
    let ran = false
    try {
      await withSystemDb("post-sync-dangling-org", async (tx) => {
        await seedAccounts(tx)
        // A personal account whose org row does not exist. Mail rows outlive a
        // purged org in the real database, and the outbox insert carries an org
        // FK, so a courtesy notice for such a row fails the statement. A failed
        // statement inside the registration transaction costs the mail app its
        // whole registration, over a message nobody can receive anyway.
        const ghostAcct = (
          await q(
            tx,
            `INSERT INTO ${SCHEMA}.accounts
               (org_id, connected_account_id, owner_type, owner_id, provider, email_address,
                sync_status, encryption_state)
             VALUES ('${GHOST_ORG}', '${CONN_ID}', 'user', '${PERSONAL_USER_ID}', 'gmail',
                     'post-sync-ghost@test.com', 'active', 'none')
             RETURNING id::text AS id`,
          )
        )[0].id as string
        await ageToLegacyNone(tx, ghostAcct)

        // Non-vacuity: the org really is absent, and the row really is personal
        // and really is at 'none', so the step has a reason to notify it.
        expect(
          await q(tx, `SELECT id FROM kernel.organizations WHERE id = '${GHOST_ORG}'`),
        ).toEqual([])

        const result = await assertMailboxSchemaState(tx, SCHEMA)

        // The schema work still happened and the row still moved: the notice is
        // the optional half, the state transition is not.
        const after = await q(
          tx,
          `SELECT encryption_state FROM ${SCHEMA}.accounts WHERE id = '${ghostAcct}'`,
        )
        expect(after[0].encryption_state).toBe("pending_enrollment")
        // The load-bearing assertion: the step DECIDED to skip, rather than
        // issuing an insert that fails and gets swallowed. Without the org
        // check this array is empty and the FK error is what "protects" the
        // registration, which is not protection at all.
        expect(result.noticesSkippedForMissingOrg).toContain(ghostAcct)
        expect(
          await q(tx, `SELECT 1 FROM kernel.pending_events WHERE org_id = '${GHOST_ORG}'`),
        ).toEqual([])

        // The transaction is still usable. This is the assertion that actually
        // pins the bug: a poisoned transaction fails HERE, not above.
        expect((await q(tx, "SELECT 1 AS ok"))[0].ok).toBe(1)

        ran = true
        throw new Rollback()
      })
    } catch (err) {
      if (!(err instanceof Rollback)) throw err
    }
    expect(ran, "the drill must have run to completion").toBe(true)
  })
})

describe("assertMailboxSchemaState, driven in the real deploy order", () => {
  it("repairs every fact the migrations could not, and is a no-op on the second run", async () => {
    let ran = false
    try {
      await withSystemDb("post-sync-assertions-drill", async (tx) => {
        // --- 0. Non-vacuity on the fixture -------------------------------------
        const tables = await q(
          tx,
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = '${SCHEMA}'
              AND table_name IN ('accounts', 'conversations', 'messages', 'drafts')`,
        )
        expect(tables.length).toBe(4)

        // --- 1. Degrade to the pre-deploy schema -------------------------------
        await degradeToPreDeploy(tx)

        // The pre-state must actually be the WRONG one, or every assertion below
        // could pass against a database that was already correct.
        expect(await helperNames(tx)).toEqual([])
        const preDrafts = await draftNullability(tx)
        expect(preDrafts.length).toBe(3)
        for (const row of preDrafts) {
          expect(row.is_nullable).toBe("NO")
          expect(row.column_default).not.toBeNull()
        }
        const preEncState = await q(
          tx,
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = '${SCHEMA}' AND table_name = 'accounts'
              AND column_name = 'encryption_state'`,
        )
        expect(preEncState.length).toBe(0)

        // --- 2. The migrations run FIRST, in the real deploy order -------------
        // Recorded fact, checked rather than assumed: 0034 and 0035 are guarded
        // only on things that already exist pre-deploy (the accounts table, the
        // draft columns), so they DO apply on this deploy. 0032 and 0036 are
        // guarded on columns the app schema sync has not created yet, so they
        // no-op, write their journal row, and never run again. Those two are the
        // reason the boot step exists; the other two are re-asserted there because
        // a helper that silently vanished is a fail-open.
        for (const tag of MIGRATION_TAGS) {
          await tx.execute(
            drizzleSql.raw(readFileSync(path.join(MIGRATIONS, `${tag}.sql`), "utf8")),
          )
        }
        expect(await helperNames(tx)).toEqual(["mailbox_account_exists", "mailbox_invariant_armed"])
        for (const row of await draftNullability(tx)) {
          expect(row.is_nullable).toBe("YES")
        }
        expect(
          await q(
            tx,
            `SELECT column_name FROM information_schema.columns
              WHERE table_schema = '${SCHEMA}' AND table_name = 'accounts'
                AND column_name = 'encryption_state'`,
          ),
          "0036 must no-op before the schema sync creates encryption_state",
        ).toEqual([])

        // --- 3. The app schema sync adds the columns ---------------------------
        await applyManifestAlter(tx)
        await seedAccounts(tx)
        const seeded = await q(
          tx,
          `SELECT owner_type, encryption_state FROM ${SCHEMA}.accounts
            WHERE id IN ('${PERSONAL_ACCT}', '${ORG_ACCT}') ORDER BY owner_type`,
        )
        expect(seeded.length).toBe(2)
        for (const row of seeded) expect(row.encryption_state).toBe("none")
        expect((await nonExternalCiphertextColumns(tx)).length).toBeGreaterThan(0)

        // Degrade the two facts the migrations DID fix, so the boot step has to
        // repair all four rather than three. A helper dropped by a bad repair
        // script or a schema restore is exactly the case this covers.
        await tx.execute(
          drizzleSql.raw(`DROP FUNCTION IF EXISTS ${SCHEMA}.mailbox_invariant_armed(uuid)`),
        )
        await tx.execute(
          drizzleSql.raw(`DROP FUNCTION IF EXISTS ${SCHEMA}.mailbox_account_exists(uuid)`),
        )
        await tx.execute(
          drizzleSql.raw(`DROP FUNCTION IF EXISTS ${SCHEMA}.mailbox_owner_enrolled(uuid)`),
        )
        await restoreDraftPlaintextNotNull(tx)
        expect(await helperNames(tx)).toEqual([])

        // --- 4. The boot step -------------------------------------------------
        const first = await assertMailboxSchemaState(tx, SCHEMA)

        expect(await nonExternalCiphertextColumns(tx)).toEqual([])
        expect(first.storageColumnsFixed.length).toBe(15)
        for (const row of await draftNullability(tx)) {
          expect(row.is_nullable).toBe("YES")
          expect(row.column_default).toBeNull()
        }
        expect(first.draftColumnsRelaxed.sort()).toEqual([
          "drafts.html_body",
          "drafts.subject",
          "drafts.text_body",
        ])
        expect(await helperNames(tx)).toEqual([
          "mailbox_account_exists",
          "mailbox_invariant_armed",
          "mailbox_owner_enrolled",
        ])
        expect(first.helpersAsserted).toBe(true)
        const after = await q(
          tx,
          `SELECT owner_type, encryption_state FROM ${SCHEMA}.accounts
            WHERE id IN ('${PERSONAL_ACCT}', '${ORG_ACCT}') ORDER BY owner_type`,
        )
        expect(after.find((r) => r.owner_type === "user")?.encryption_state).toBe(
          "pending_enrollment",
        )
        expect(after.find((r) => r.owner_type === "shared")?.encryption_state).toBe("none")
        expect(first.accountsMovedToPendingEnrollment).toBeGreaterThanOrEqual(1)

        // The owner is told. Task 4.4 stops fetching for exactly the accounts
        // this UPDATE just moved, and the enrollment wizard lands in a later
        // phase, so shipping the transition without the notice means "mail
        // silently stopped".
        expect(first.ownersNotified).toContain(PERSONAL_USER_ID)
        const queued = await q(
          tx,
          `SELECT payload FROM kernel.pending_events
            WHERE payload->>'entity' = 'agent_notification'
              AND payload->'data'->'targetUserIds' ? '${PERSONAL_USER_ID}'`,
        )
        expect(queued.length).toBe(1)
        const summary = String((queued[0].payload as { data: { summary: string } }).data.summary)
        expect(summary).toContain("post-sync-personal@test.com")
        expect(summary).toContain("paused")
        expect(summary).toContain("Nothing has been lost")
        // No dash punctuation in anything a customer reads.
        expect(summary).not.toMatch(/\u2014|\u2013|--/)

        // --- 5. Task 4.7: a draft can now actually hold NULL --------------------
        await tx.execute(drizzleSql`
          INSERT INTO app_mail.drafts (org_id, account_id, "to", cc, bcc, subject, html_body, text_body, created_by)
          VALUES (${ORG_ID}, ${PERSONAL_ACCT}, '[]', '[]', '[]', NULL, NULL, NULL, ${PERSONAL_USER_ID})`)

        // --- 6. Second run changes nothing and raises nothing -------------------
        const second = await assertMailboxSchemaState(tx, SCHEMA)
        expect(second.storageColumnsFixed).toEqual([])
        expect(second.draftColumnsRelaxed).toEqual([])
        expect(second.accountsMovedToPendingEnrollment).toBe(0)
        expect(second.ownersNotified, "the notice is one-shot").toEqual([])
        expect(second.helpersAsserted).toBe(true)

        ran = true
        throw new Rollback()
      })
    } catch (err) {
      if (!(err instanceof Rollback)) throw err
    }
    expect(ran).toBe(true)
  }, 60_000)
})
