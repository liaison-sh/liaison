// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The mail app's post-schema-sync assertion step.
//
// Why this exists at all: the prod deploy runs the `migrate` one-shot ONCE,
// before the app containers are recreated. On the deploy that introduces
// mailbox encryption the ciphertext and `encryption_state` columns therefore do
// not exist yet when migrations 0032, 0034, 0035 and 0036 run. Each of them is
// guarded on the column existing, so each no-ops, writes its journal row, and
// never runs again. Left there, every existing personal mailbox would sit at
// `encryption_state = 'none'` forever, sync would keep running, and plaintext
// would keep being written, with no error and no alert.
//
// So every piece of DDL and data state whose numbered migration will normally
// have no-opped is re-asserted here, after the schema sync, on every boot. Each
// assertion is conditional, so the cost when nothing is wrong is a handful of
// cheap catalogue reads. The migrations remain the fast path for a database
// where the columns already exist; this step is the one that has to work.
//
// It derives nothing: the schema name is passed in exactly as registration
// computed it, so a prefixed test schema runs the same code path as production.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withReleasedSavepoint } from "~/db/savepoint"
import { schemaRef } from "~/db/schema-ref"
import type { AppEvent } from "~/infra/events/event-bus"
import { appsLogger as log } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { validateIdentifier } from "~/modules/apps/ddl"

/** Anything that can run raw SQL: a privileged tx, or the privileged db itself. */
export interface SqlExecutor {
  execute(query: unknown): Promise<unknown>
  /**
   * The transactional-outbox helper. Present on a privileged tx, absent on a
   * bare pool handle, so the notification below is best effort by construction.
   */
  queueEvent?(event: AppEvent): Promise<unknown>
  /** A savepoint of this transaction (Drizzle's nested transaction). */
  transaction?<T>(fn: (savepoint: SqlExecutor) => Promise<T>): Promise<T>
}

/**
 * Every ciphertext column that must be STORAGE EXTERNAL. Kept as literals rather
 * than derived from the manifest so that dropping a column from the manifest has
 * to be reconciled here deliberately.
 */
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
  drafts: [
    "body_ciphertext",
    "html_body_ciphertext",
    "subject_ciphertext",
    "content_key_wrapped",
    "content_key_epk",
  ],
}

/** The draft plaintext columns that shipped NOT NULL DEFAULT ''. */
const DRAFT_PLAINTEXT_COLUMNS = ["subject", "html_body", "text_body"]

/** What the step actually changed, for the caller's log line and for tests. */
export interface MailboxSchemaAssertionResult {
  storageColumnsFixed: string[]
  draftColumnsRelaxed: string[]
  helpersAsserted: boolean
  accountsMovedToPendingEnrollment: number
  /**
   * Personal mailboxes whose owner never set up a private mailbox and whose
   * mode (the owner's choice, the org switch, the deployment default) is
   * transparent: moved to `managed`, so they sync with no mailbox password.
   */
  accountsMovedToManaged: number
  /** Owners told, in this run, that their mailbox stopped fetching mail. */
  ownersNotified: string[]
  /**
   * Accounts moved but deliberately NOT notified, because their org row is
   * gone. Reported rather than merely logged so a test can tell "skipped on
   * purpose" apart from "the outbox insert failed and was swallowed".
   */
  noticesSkippedForMissingOrg: string[]
}

async function columnExists(
  tx: SqlExecutor,
  schemaName: string,
  table: string,
  column: string,
): Promise<boolean> {
  const rows = extractRows<{ ok: boolean }>(
    await tx.execute(drizzleSql`
      SELECT true AS ok FROM information_schema.columns
       WHERE table_schema = ${schemaName} AND table_name = ${table} AND column_name = ${column}
    `),
  )
  return rows.length > 0
}

/**
 * Re-assert every mailbox-encryption schema fact after the mail app's schema
 * sync. Idempotent: safe to run on every boot, and a no-op once satisfied.
 */
export async function assertMailboxSchemaState(
  tx: SqlExecutor,
  schemaName: string,
): Promise<MailboxSchemaAssertionResult> {
  validateIdentifier(schemaName)
  const kernelSchema = validateIdentifier(schemaRef("kernel"))
  const q = quoteIdent(schemaName)
  const result: MailboxSchemaAssertionResult = {
    storageColumnsFixed: [],
    draftColumnsRelaxed: [],
    helpersAsserted: false,
    accountsMovedToPendingEnrollment: 0,
    accountsMovedToManaged: 0,
    ownersNotified: [],
    noticesSkippedForMissingOrg: [],
  }

  // 1. STORAGE EXTERNAL on every ciphertext column that is not already EXTERNAL.
  //    `attstorage = 'e'` is the catalogue's own answer, so a column that the
  //    migration already fixed costs one read and no DDL.
  for (const [table, columns] of Object.entries(CIPHERTEXT_COLUMNS)) {
    const pending = extractRows<{ attname: string }>(
      await tx.execute(drizzleSql`
        SELECT a.attname FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = ${schemaName} AND c.relname = ${table}
           AND a.attname IN (${drizzleSql.join(
             columns.map((c) => drizzleSql`${c}`),
             drizzleSql.raw(", "),
           )}) AND a.attstorage <> 'e' AND NOT a.attisdropped
      `),
    )
    for (const { attname } of pending) {
      await tx.execute(
        drizzleSql.raw(
          `ALTER TABLE ${q}.${quoteIdent(table)} ALTER COLUMN ${quoteIdent(attname)} SET STORAGE EXTERNAL`,
        ),
      )
      result.storageColumnsFixed.push(`${table}.${attname}`)
    }
  }

  // 2. The draft plaintext columns must be able to hold NULL, and must not
  //    reinstate '' by default after a purge NULLs them.
  const relaxable = extractRows<{ column_name: string }>(
    await tx.execute(drizzleSql`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = ${schemaName} AND table_name = 'drafts'
         AND column_name IN (${drizzleSql.join(
           DRAFT_PLAINTEXT_COLUMNS.map((c) => drizzleSql`${c}`),
           drizzleSql.raw(", "),
         )})
         AND (is_nullable = 'NO' OR column_default IS NOT NULL)
    `),
  )
  for (const { column_name } of relaxable) {
    const col = quoteIdent(validateIdentifier(column_name))
    await tx.execute(
      drizzleSql.raw(`ALTER TABLE ${q}.${quoteIdent("drafts")} ALTER COLUMN ${col} DROP NOT NULL`),
    )
    await tx.execute(
      drizzleSql.raw(`ALTER TABLE ${q}.${quoteIdent("drafts")} ALTER COLUMN ${col} DROP DEFAULT`),
    )
    result.draftColumnsRelaxed.push(`drafts.${column_name}`)
  }

  // 2b. The row lock a sync page takes on its mailbox (modules/mail/page-write.ts)
  //     so a concurrent disconnect purge serialises with it. A row lock under
  //     RLS needs the UPDATE policy (mail:accounts:write), which a person or a
  //     routine replying from a shared mailbox does not hold: the page write
  //     then found no account, refused, and the sent copy was neither stored nor
  //     announced until the next provider sync. Visibility stays the caller's
  //     own RLS read after the lock; this only takes the lock, pinned to the
  //     transaction's org, as `kernel.lock_live_message` does for messages.
  if (await columnExists(tx, schemaName, "accounts", "org_id")) {
    await tx.execute(
      drizzleSql.raw(`CREATE OR REPLACE FUNCTION ${q}.mail_lock_account(p_org uuid, p_account uuid)
  RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $lock$
BEGIN
  IF p_org IS NULL OR p_org IS DISTINCT FROM COALESCE(
       NULLIF(rls_ctx.org_id(), '')::uuid, p_org) THEN
    RAISE EXCEPTION 'mail_lock_account: not the transaction''s org' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM ${q}.accounts a WHERE a.id = p_account AND a.org_id = p_org FOR SHARE;
  RETURN FOUND;
END
$lock$`),
    )
    const hasAdmin = extractRows<{ ok: boolean }>(
      await tx.execute(drizzleSql`SELECT true AS ok FROM pg_roles WHERE rolname = 'liaison_admin'`),
    )
    if (hasAdmin.length > 0) {
      await tx.execute(
        drizzleSql.raw(`ALTER FUNCTION ${q}.mail_lock_account(uuid, uuid) OWNER TO liaison_admin`),
      )
    }
  }

  // 3. The two SECURITY DEFINER helpers the Invariant P trigger calls. The
  //    trigger function itself is emitted SECURITY INVOKER by the app DDL
  //    generator, and both `accounts` and `user_mailbox_identities` are RLS
  //    protected, so an inline lookup would fail OPEN for a writer that cannot
  //    see them. CREATE OR REPLACE is idempotent by construction.
  //
  //    Armed means: the owner holds an active identity, OR the owner has EVER
  //    enrolled (`mailbox_migration_state.enrolled_at`). The second half is what
  //    keeps a reset mailbox armed. The mailbox reset deletes the whole keyring,
  //    so without it the trigger would disarm between the reset and the
  //    re-enrollment and a draft saved from a second device in that window
  //    would land in plaintext. With it, every writer must seal, has nothing to
  //    seal to, and refuses. Once a mailbox has entered the regime it never
  //    leaves it, which is the same rule `encryption_state` follows.
  if (await columnExists(tx, kernelSchema, "user_mailbox_identities", "status")) {
    const k = quoteIdent(kernelSchema)
    const everEnrolled = (await columnExists(
      tx,
      kernelSchema,
      "mailbox_migration_state",
      "enrolled_at",
    ))
      ? `
        OR EXISTS (
          SELECT 1 FROM ${k}.mailbox_migration_state s
           WHERE s.user_id = a.owner_id AND s.enrolled_at IS NOT NULL
        )`
      : ""
    // A server-managed mailbox is armed too: by its state, and by its data key
    // existing, so neither one UPDATE of `encryption_state` nor a missing key
    // row alone can disarm it. Both branches only ever make MORE accounts armed.
    const managedArmed = `
        OR a.encryption_state = 'managed'${
          (await columnExists(tx, kernelSchema, "mailbox_server_keys", "account_id"))
            ? `
        OR EXISTS (
          SELECT 1 FROM ${k}.mailbox_server_keys sk
           WHERE sk.account_id = a.id AND sk.status = 'active'
        )`
            : ""
        }`
    const hasStateColumn = await columnExists(tx, schemaName, "accounts", "encryption_state")
    await tx.execute(
      drizzleSql.raw(`CREATE OR REPLACE FUNCTION ${q}.mailbox_invariant_armed(acct uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $armed$
  SELECT EXISTS (
    SELECT 1
      FROM ${q}.accounts a
     WHERE a.id = acct AND a.owner_type = 'user'
       AND (
        EXISTS (
          SELECT 1 FROM ${k}.user_mailbox_identities i
           WHERE i.user_id = a.owner_id AND i.status = 'active'
        )${everEnrolled}${hasStateColumn ? managedArmed : ""}
       )
  )
$armed$`),
    )
    await tx.execute(
      drizzleSql.raw(`CREATE OR REPLACE FUNCTION ${q}.mailbox_account_exists(acct uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $known$
  SELECT EXISTS (SELECT 1 FROM ${q}.accounts a WHERE a.id = acct)
$known$`),
    )
    // The third helper answers the accounts INSERT trigger
    // (`default_mailbox_encryption_state` in the manifest): does this owner
    // already hold an active identity? A personal mailbox connected AFTER its
    // owner enrolled used to land at `none`, which suspends its sync, and
    // nothing lifted it: the enroll route has no legal edge from `none`, the
    // wizard never shows again for an owner who has keys, and the boot step
    // only moves it to `pending_enrollment` on the next restart. The trigger
    // stamps the row `ready` or `pending_enrollment` at birth instead.
    await tx.execute(
      drizzleSql.raw(`CREATE OR REPLACE FUNCTION ${q}.mailbox_owner_enrolled(owner uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $enrolled$
  SELECT EXISTS (
    SELECT 1
      FROM ${quoteIdent(kernelSchema)}.user_mailbox_identities i
     WHERE i.user_id = owner AND i.status = 'active'
  )
$enrolled$`),
    )
    // The registration transaction already runs as liaison_admin, so the owner
    // is normally right by construction. Re-assert it anyway: this file is also
    // reachable from a test or a repair path running under another role, and a
    // SECURITY DEFINER helper owned by the wrong role is a silent fail-open.
    const hasRole = extractRows<{ ok: boolean }>(
      await tx.execute(drizzleSql`SELECT true AS ok FROM pg_roles WHERE rolname = 'liaison_admin'`),
    )
    if (hasRole.length > 0) {
      await tx.execute(
        drizzleSql.raw(`ALTER FUNCTION ${q}.mailbox_invariant_armed(uuid) OWNER TO liaison_admin`),
      )
      await tx.execute(
        drizzleSql.raw(`ALTER FUNCTION ${q}.mailbox_account_exists(uuid) OWNER TO liaison_admin`),
      )
      await tx.execute(
        drizzleSql.raw(`ALTER FUNCTION ${q}.mailbox_owner_enrolled(uuid) OWNER TO liaison_admin`),
      )
    }
    result.helpersAsserted = true
  }

  // 3a. Crypto-shredding parity with private mailboxes: whatever deletes a
  //     mailbox row (disconnect purge, a user's erasure, the app's own delete,
  //     an admin), its server-managed data keys go with it in the same
  //     statement, so nothing sealed under them can be opened afterwards. An
  //     AFTER DELETE trigger covers every path at once; SECURITY DEFINER because
  //     the request role cannot see the key table at all.
  if (
    (await columnExists(tx, schemaName, "accounts", "id")) &&
    (await columnExists(tx, kernelSchema, "mailbox_server_keys", "account_id"))
  ) {
    const k = quoteIdent(kernelSchema)
    await tx.execute(
      drizzleSql.raw(`CREATE OR REPLACE FUNCTION ${q}.mailbox_shred_server_keys()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $shred$
BEGIN
  DELETE FROM ${k}.mailbox_server_keys WHERE account_id = OLD.id;
  RETURN OLD;
END
$shred$`),
    )
    // Created once: a boot that finds it in place takes no lock on the table.
    // Two processes booting at once would both find it missing and the second
    // CREATE would fail its boot: the check and the create are serialized on a
    // transaction-scoped advisory lock, so the second waits for the first to
    // commit and then finds the trigger in place.
    await tx.execute(
      drizzleSql`SELECT pg_advisory_xact_lock(hashtext(${`liaison:mailbox_shred_server_keys:${schemaName}`}))`,
    )
    const hasTrigger = extractRows<{ ok: boolean }>(
      await tx.execute(drizzleSql`
        SELECT true AS ok FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE t.tgname = 'mailbox_shred_server_keys' AND c.relname = 'accounts'
           AND n.nspname = ${schemaName}`),
    )
    if (hasTrigger.length === 0) {
      await tx.execute(
        drizzleSql.raw(`CREATE TRIGGER mailbox_shred_server_keys AFTER DELETE ON ${q}.accounts
  FOR EACH ROW EXECUTE FUNCTION ${q}.mailbox_shred_server_keys()`),
      )
    }
    const hasAdminRole = extractRows<{ ok: boolean }>(
      await tx.execute(drizzleSql`SELECT true AS ok FROM pg_roles WHERE rolname = 'liaison_admin'`),
    )
    if (hasAdminRole.length > 0) {
      await tx.execute(
        drizzleSql.raw(`ALTER FUNCTION ${q}.mailbox_shred_server_keys() OWNER TO liaison_admin`),
      )
    }
  }

  // 3b. Server-managed by default. A personal mailbox still waiting for a
  //     mailbox password (`none`, `pending_enrollment`, `paused`) whose owner
  //     NEVER set up a private mailbox moves to `managed` when the owner's
  //     mode is transparent, and starts syncing; its key is minted on the
  //     first seal. Nothing an owner ever made private moves: an owner with a
  //     keyring, or who ever enrolled, keeps today's behaviour, and on a
  //     deployment whose default is private nothing moves at all. Runs BEFORE
  //     step 4 so those mailboxes are not first told their mail is paused.
  if (
    (await columnExists(tx, schemaName, "accounts", "encryption_state")) &&
    (await columnExists(tx, kernelSchema, "user_mailbox_identities", "status")) &&
    (await columnExists(tx, kernelSchema, "mailbox_migration_state", "enrolled_at"))
  ) {
    const k = quoteIdent(kernelSchema)
    const candidates = extractRows<{
      id: string
      org_id: string
      owner_id: string
      encryption_state: string
    }>(
      await tx.execute(
        drizzleSql.raw(`SELECT a.id::text AS id, a.org_id::text AS org_id,
                a.owner_id::text AS owner_id, a.encryption_state
           FROM ${q}.accounts a
          WHERE a.owner_type = 'user' AND a.owner_id IS NOT NULL
            AND a.encryption_state IN ('none', 'pending_enrollment', 'paused')
            AND NOT EXISTS (SELECT 1 FROM ${k}.user_mailbox_identities i
                             WHERE i.user_id = a.owner_id AND i.status = 'active')
            AND NOT EXISTS (SELECT 1 FROM ${k}.mailbox_migration_state s
                             WHERE s.user_id = a.owner_id AND s.enrolled_at IS NOT NULL)`),
      ),
    )
    if (candidates.length > 0) {
      const { effectiveMailboxEncryptionMode } = await import(
        "~/modules/mailbox-crypto/encryption-mode"
      )
      for (const account of candidates) {
        const mode = await effectiveMailboxEncryptionMode(tx, account.org_id, account.owner_id)
        if (mode !== "managed") continue
        const moved = extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
            UPDATE ${drizzleSql.raw(q)}.accounts SET encryption_state = 'managed'
             WHERE id = ${account.id}::uuid AND encryption_state = ${account.encryption_state}
            RETURNING id::text AS id`),
        )
        result.accountsMovedToManaged += moved.length
      }
    }
  }

  // 4. The deploy-time transition. Idempotent by its own `= 'none'` predicate,
  //    and it is what actually flips the fleet on the deploy that lands this.
  if (await columnExists(tx, schemaName, "accounts", "encryption_state")) {
    const moved = extractRows<{
      id: string
      owner_id: string | null
      email_address: string
      org_id: string
    }>(
      await tx.execute(
        drizzleSql.raw(`UPDATE ${q}.accounts SET encryption_state = 'pending_enrollment'
           WHERE owner_type = 'user' AND encryption_state = 'none'
           RETURNING id, owner_id, email_address, org_id`),
      ),
    )
    result.accountsMovedToPendingEnrollment = moved.length

    // 5. Tell the owner. This step is what STOPS their mail arriving (the sync
    //    guard reads the state this UPDATE just wrote), and the enrollment wizard
    //    does not land until a later phase, so without a notice the observable
    //    product behaviour is "mail silently stopped": the worst possible framing
    //    of a security improvement. One-shot by construction, because the
    //    `= 'none'` predicate moves each account exactly once.
    // Only notify for an account whose org row is still there. A dangling
    // org_id (a purged org whose mail rows outlived it) makes the outbox insert
    // violate `pending_events_org_fk`, and a failed statement poisons the
    // registration transaction whether or not the failure itself is caught: the
    // app then fails to register over a courtesy message. Skip those rows here
    // rather than discover it at the FK.
    const liveOrgs = new Set(
      extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          SELECT id::text AS id FROM ${drizzleSql.raw(quoteIdent(kernelSchema))}.organizations`),
      ).map((row) => row.id),
    )

    for (const account of moved) {
      if (!account.owner_id || typeof tx.queueEvent !== "function") continue
      if (!liveOrgs.has(account.org_id)) {
        log.warn(
          { accountId: account.id, orgId: account.org_id },
          "Mailbox enrollment notice skipped: the account's org row is gone",
        )
        result.noticesSkippedForMissingOrg.push(account.id)
        continue
      }
      // A released savepoint per notice. The outbox insert carries an org FK,
      // and a stale account row whose org is gone would otherwise abort the
      // whole registration transaction on a failed courtesy message. The schema
      // assertions above are the part that must not be lost. The driver's
      // savepoint, not a raw SAVEPOINT: postgres.js rethrows a scope's failed
      // query when the scope ends, even one the caller caught.
      const notice: AppEvent = {
        app: "kernel",
        entity: "agent_notification",
        action: "create",
        entityId: crypto.randomUUID(),
        data: {
          summary:
            `New mail for ${account.email_address} is paused. Liaison is switching personal ` +
            "mailboxes to encryption only you can unlock, and this mailbox needs you to set " +
            "that up before mail can arrive again. Nothing has been lost: messages stay at " +
            "your provider until you finish.",
          urgency: 80,
          targetUserIds: [account.owner_id],
          // Fully qualified: bare "settings" is ambiguous (invoicing has its own).
          link: { tabType: "kernel:settings", entityId: "security" },
        },
        actorId: null,
        actorType: "system",
        orgId: account.org_id,
        timestamp: new Date().toISOString(),
      }
      try {
        if (tx.transaction) {
          const host = tx as SqlExecutor & Required<Pick<SqlExecutor, "transaction">>
          await withReleasedSavepoint(host, async (sp) => {
            if (!sp.queueEvent) throw new Error("the savepoint carries no outbox")
            await sp.queueEvent(notice)
          })
        } else {
          await tx.queueEvent(notice)
        }
        result.ownersNotified.push(account.owner_id)
      } catch (err) {
        // A failed notice must never abort the schema assertion that is holding
        // the mailbox safe. The banner on the mail surface is the durable half.
        log.warn({ err, accountId: account.id }, "Mailbox enrollment notice could not be queued")
      }
    }
  }

  const changed =
    result.storageColumnsFixed.length > 0 ||
    result.draftColumnsRelaxed.length > 0 ||
    result.accountsMovedToPendingEnrollment > 0 ||
    result.accountsMovedToManaged > 0
  if (changed) {
    log.info({ schemaName, ...result }, "Mailbox encryption schema state asserted")
  }
  return result
}
