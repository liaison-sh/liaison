// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison mailbox purge --user <uuid> --org <uuid> [--execute --confirm <uuid>]`
//
// The operator command for spec section 7 step 7. THIS IS THE MOST DESTRUCTIVE
// OPERATION IN THE PRODUCT: it NULLs the last readable copy of one person's
// mail. The only other copies are inside compliance-locked backups, so a
// mistake here is not a rollback, it is a restore from a WORM store, and only
// while those backups still exist.
//
// WHY A COMMAND AND NOT A JOB RUNNER. The purge is registered as a kernel job
// worker taking `{ userId, orgId }`, and `ops/deploy/prod/run-app-job.sh`
// enqueues `{ orgId }` only and gates on `kernel.apps_installed`, so it cannot
// fire this and should not learn how: a runner that can pass an arbitrary
// payload to an arbitrary kernel job is a worse thing to own than one explicit
// command. This is that command, and it calls the same module the job worker
// calls, with the same gate in front of it.
//
// The safety properties, all of them tested:
//   * both ids are explicit; there is no all-users and no all-orgs form,
//   * a run is a DRY RUN unless `--execute` is given,
//   * `--execute` also requires `--confirm <the same user id>`, typed out, so a
//     recalled shell line cannot destroy a mailbox by pressing return,
//   * it refuses without a valid client acknowledgement, which is the gate in
//     `purgeMailboxPlaintext` itself and is NOT re-implemented or relaxed here,
//   * it is loud: a banner before, a warn log, and the full result after,
//   * there is no schedule. Someone has to ask for this, per user, every time.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import {
  assertStoredAckCoversCurrentRows,
  MailboxAckError,
} from "~/modules/mailbox-crypto/ack-verify"
import {
  assertBackfillCompleted,
  assertFullySealed,
  countRemainingPlaintext,
  type PurgeResult,
  purgeMailboxPlaintext,
} from "~/modules/mailbox-crypto/purge"

const log = rootLogger.child({ module: "mailbox-purge-cli" })

const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)

export const MAILBOX_PURGE_USAGE =
  "usage: liaison mailbox purge --user <uuid> --org <uuid> [--execute --confirm <same user uuid>]"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface MailboxPurgeArgs {
  userId: string
  orgId: string
  execute: boolean
  confirm: string | null
}

export type ParsedMailboxPurgeArgs =
  | { ok: true; args: MailboxPurgeArgs }
  | { ok: false; error: string }

export function parseMailboxPurgeArgv(argv: string[]): ParsedMailboxPurgeArgs {
  let userId: string | null = null
  let orgId: string | null = null
  let confirm: string | null = null
  let execute = false
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === "--execute") {
      execute = true
      continue
    }
    const value = argv[i + 1]
    if (flag === "--user" || flag === "--org" || flag === "--confirm") {
      if (!value || value.startsWith("--")) {
        return { ok: false, error: `${flag} requires a value\n${MAILBOX_PURGE_USAGE}` }
      }
      if (flag === "--user") userId = value
      else if (flag === "--org") orgId = value
      else confirm = value
      i++
      continue
    }
    return { ok: false, error: `unknown option ${flag}\n${MAILBOX_PURGE_USAGE}` }
  }
  if (!userId || !orgId) {
    return { ok: false, error: `--user and --org are both required\n${MAILBOX_PURGE_USAGE}` }
  }
  if (!UUID.test(userId) || !UUID.test(orgId)) {
    return {
      ok: false,
      error: `--user and --org must be uuids, and must name ONE user\n${MAILBOX_PURGE_USAGE}`,
    }
  }
  return { ok: true, args: { userId, orgId, execute, confirm } }
}

export interface MailboxPurgeInspection {
  messagesWithPlaintext: number
  conversationsWithPlaintext: number
  draftsWithPlaintext: number
  headersToReduce: number
  gate: "passed"
}

type Executor = Pick<PrivilegedDb, "execute">

/**
 * The dry run: run the SAME gate the purge runs, then count what it would
 * destroy. It writes nothing. A gate refusal here throws `MailboxAckError`
 * exactly as the real run would, which is the point: an operator can see the
 * refusal without risking anything.
 */
export async function inspectMailboxPurge(
  userId: string,
  orgId: string,
): Promise<MailboxPurgeInspection> {
  return withPrivilegedDb(orgId, "mailbox-purge-cli:dry-run", async (db) => {
    const tx = db as unknown as Executor
    const accountIds = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id FROM ${MAIL}.accounts
         WHERE org_id = ${orgId}::uuid AND owner_type = 'user' AND owner_id = ${userId}::uuid`),
    ).map((r) => r.id)

    await assertStoredAckCoversCurrentRows(tx, userId, orgId)
    await assertBackfillCompleted(tx, userId)
    await assertFullySealed(tx, accountIds)

    // The SAME measurement the purge reports afterwards, so the operator's
    // before and after are two readings of one instrument rather than two
    // instruments that have to be reconciled.
    const remaining = await countRemainingPlaintext(tx, accountIds)
    return {
      messagesWithPlaintext: remaining.messages,
      conversationsWithPlaintext: remaining.conversations,
      draftsWithPlaintext: remaining.drafts,
      headersToReduce: remaining.messagesWithNonAllowlistedHeaders,
      gate: "passed" as const,
    }
  })
}

/**
 * The whole error, cause chain included.
 *
 * Drizzle throws `Error("Failed query: <sql>")` with the driver error hanging
 * off `cause`, so printing `error.stack` alone told the operator the SQL and
 * nothing about why it failed: no message, no SQLSTATE, no detail. That output
 * lands at the most dangerous moment in this feature, where the difference
 * between "a column is missing" and "a value is malformed" decides what happens
 * next, and it must not require a log dive.
 *
 * Postgres carries its useful fields as own properties rather than in the
 * message, so they are named explicitly. The chain is walked with a depth cap:
 * a self-referential `cause` must not turn an error report into a hang.
 */
export function describeError(error: unknown): string {
  const lines: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  for (let depth = 0; current != null && depth < 8; depth++) {
    if (seen.has(current)) break
    seen.add(current)
    if (current instanceof Error) {
      lines.push(depth === 0 ? (current.stack ?? current.message) : `caused by: ${current.message}`)
      const fields = current as unknown as Record<string, unknown>
      for (const key of ["code", "detail", "hint", "where", "constraint", "table", "routine"]) {
        const value = fields[key]
        if (typeof value === "string" && value.length > 0) lines.push(`  ${key}: ${value}`)
      }
      current = current.cause
      continue
    }
    lines.push(`caused by: ${String(current)}`)
    break
  }
  return lines.length > 0 ? lines.join("\n") : String(error)
}

export interface MailboxPurgeCliDeps {
  purge?: (userId: string, orgId: string) => Promise<PurgeResult>
  inspect?: (userId: string, orgId: string) => Promise<MailboxPurgeInspection>
  write?: (line: string) => void
  writeErr?: (line: string) => void
}

export async function runMailboxPurgeCli(
  argv: string[],
  deps: MailboxPurgeCliDeps = {},
): Promise<number> {
  const write = deps.write ?? ((line: string) => process.stdout.write(line))
  const writeErr = deps.writeErr ?? ((line: string) => process.stderr.write(line))
  const parsed = parseMailboxPurgeArgv(argv)
  if (!parsed.ok) {
    writeErr(`${parsed.error}\n`)
    return 2
  }
  const { userId, orgId, execute, confirm } = parsed.args

  if (execute && confirm !== userId) {
    writeErr(
      "refusing to run: --execute destroys the only readable copy of this mailbox, so it " +
        `requires --confirm ${userId} spelled out.\n${MAILBOX_PURGE_USAGE}\n`,
    )
    return 2
  }

  if (!execute) {
    writeErr(`DRY RUN for user ${userId} in org ${orgId}. Nothing will be written.\n`)
    try {
      const report = await (deps.inspect ?? inspectMailboxPurge)(userId, orgId)
      write(`${JSON.stringify({ dryRun: true, userId, orgId, ...report }, null, 2)}\n`)
      writeErr(
        `The gate PASSED. Re-run with --execute --confirm ${userId} to destroy the plaintext above.\n`,
      )
      return 0
    } catch (error) {
      if (error instanceof MailboxAckError) {
        writeErr(`REFUSED by the acknowledgement gate: ${error.message}\n`)
        return 1
      }
      writeErr(`${describeError(error)}\n`)
      return 1
    }
  }

  writeErr(
    `IRREVERSIBLE: purging the plaintext of user ${userId} in org ${orgId}. The only remaining ` +
      "readable copies are inside the backup repositories, one of which is compliance locked.\n",
  )
  log.warn({ userId, orgId }, "operator invoked mailbox plaintext purge")
  try {
    const result = await (deps.purge ?? purgeMailboxPlaintext)(userId, orgId)
    write(`${JSON.stringify(result, null, 2)}\n`)
    log.warn({ ...result }, "operator invoked mailbox plaintext purge finished")
    const left = result.remainingPlaintext
    writeErr(
      `Plaintext still readable after this run: ${left.messages} message(s), ` +
        `${left.conversations} conversation(s), ${left.drafts} draft(s), ` +
        `${left.messagesWithNonAllowlistedHeaders} message(s) with non-allowlisted headers. ` +
        "Those counts, not the ledger's completion flag, are the witness that the purge ran.\n",
    )
    writeErr(
      result.cutoverComplete
        ? "Done. The mailbox is now readable only with the owner's key.\n"
        : "Done, and IRREVERSIBLE, but the cutover is NOT complete: unsealed attachment objects " +
            "remain, so kernel.mailbox_migration_state.plaintext_purged_at is deliberately left " +
            "NULL. plaintext_purge_ran_at IS stamped: the destruction happened. Do NOT read the " +
            "NULL as 'the purge never ran', and do NOT hand-write a completion timestamp. See " +
            "unsealedAttachments.\n",
    )
    return 0
  } catch (error) {
    if (error instanceof MailboxAckError) {
      writeErr(
        `REFUSED by the acknowledgement gate: ${error.message}. Nothing was destroyed. ` +
          "Run the full-mailbox check in the browser first.\n",
      )
      return 1
    }
    writeErr(
      `${describeError(error)}\nNothing was destroyed by this failure path unless the log above says otherwise.\n`,
    )
    return 1
  }
}

if (import.meta.main) {
  runMailboxPurgeCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`${describeError(err)}\n`)
      process.exit(1)
    })
}
