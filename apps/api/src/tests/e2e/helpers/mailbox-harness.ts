// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The headless mailbox harness the local e2e lane drives (e2e plan section
// 1.5(a)). It is a SUBPROCESS entry point, not a library: a Playwright worker
// runs it with `bun`, cwd = apps/api, and the worker's own `SCHEMA_PREFIX` and
// `DATABASE_URL` in its environment, so every read and write lands in that
// worker's `w<N>_kernel` / `w<N>_app_mail` schemas.
//
// WHY A SUBPROCESS AND NOT AN IN-PROCESS IMPORT. The plan weighed two shapes
// and picked "a test-only ingest endpoint on the API". A third shape is
// strictly better and is what this file is: the Playwright runner has
// `~/*` bound to `apps/web/src` (its own tsconfig), so importing
// `apps/api/src/modules/...` from a web scenario resolves `~/db` to the WEB
// tree and fails. Running the same code as a child process with cwd = apps/api
// gets the API's own path mapping, the API's own `schemaRef`, and adds NO test-only route to the shipped app. What the plan cared
// about is preserved exactly: the real bridge, the real `system:mail:sync`
// actor, the real mail handlers, the real database trigger, and only
// the outbound provider methods stubbed. The bridge is built the way production
// mail sync builds it (`createSessionRpcBridge` over an RLS session, see
// modules/mail/service.ts), so each bridge call commits its own short
// transaction instead of one ambient transaction spanning the whole ingest:
// rehearsing the other transaction shape would rehearse a shape production
// never runs.
//
// Usage:  bun src/tests/e2e/helpers/mailbox-harness.ts <command> <json-file>
// Result: a single line on stdout, `__MAILBOX_HARNESS__ <json>`.

import { sql as drizzleSql } from "drizzle-orm"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { createRlsSession } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

/** The mail handlers, with this file's test-only entries beside them. */
async function mailTestRunner() {
  const [{ mailRunner }, mail] = await Promise.all([
    import("~/apps/mail/test-mail-runner"),
    import("~/apps/mail/handlers"),
  ])
  return mailRunner({
    __test_processMessages: (params, ctx) =>
      mail.processMessages(params.messages, params.account, ctx),
  })
}

const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)

const RESULT_MARKER = "__MAILBOX_HARNESS__"

interface IngestParams {
  orgId: string
  accountId: string
  /** The bridge actor. Production sync is `system:mail:sync`, never the owner. */
  actor: string
  messages: unknown[]
}

interface BackfillParams {
  orgId: string
  userId: string
  /** Stop after this many message batches, to rehearse an interrupted run. */
  maxBatches?: number
}

async function ingest(params: IngestParams): Promise<unknown> {
  // App registration, exactly as the API process runs it at boot.
  //
  // It is what populates `manifestFileParentRegistry`, which
  // `files_importAttachment` consults through `resolveParent`. Without it the
  // bridge refuses every inbound attachment with "forbidden: unknown parent",
  // which is correct behaviour for a process that has not loaded the manifest
  // and says nothing at all about the product.
  const { ensureAppsForOrg } = await import("~/modules/apps/init")
  await ensureAppsForOrg(params.orgId)
  const logs: string[] = []
  const enqueued: string[] = []
  // The account lookup is its OWN short privileged transaction. Nothing is held
  // open across the handler run below.
  const account = await withPrivilegedDb(params.orgId, "mailbox-harness-account", async (tx) =>
    extractRows<{
      id: string
      owner_type: string
      owner_id: string | null
      encryption_state: string
    }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id, owner_type, owner_id::text AS owner_id, encryption_state
          FROM ${MAIL}.accounts WHERE id = ${params.accountId}::uuid`),
    ).at(0),
  )
  if (!account) throw new Error(`no mail account ${params.accountId}`)

  {
    // Same shape as production mail sync (modules/mail/service.ts): a system
    // RLS session, one short transaction per bridge call.
    //
    // `scopes` is NOT optional decoration here. `SYSTEM_PURPOSE_SCOPES.job` is
    // deliberately empty (db/rls.ts), so a purpose-only session sets
    // `app.current_scopes` to the empty string and every generated app-table
    // policy's scope conjunct is false: the ingest then dies on
    // `new row violates row-level security policy for table "conversations"`
    // before it writes anything. Production never runs that way — the job
    // worker hands a system-initiated app job `scopes: ["<app>:*"]`
    // (infra/jobs/jobs.ts), so the harness uses exactly that.
    const session = createRlsSession({
      actorType: "system",
      orgId: params.orgId,
      purpose: "job",
      scopes: ["mail:*"],
    })
    const real = createSessionRpcBridge(
      "mail",
      params.actor,
      params.orgId,
      session,
      mailAppManifest as never,
    )
    // Only the outbound provider socket and the log sinks are stubbed. Every
    // mailbox method below this line is the real bridge.
    // biome-ignore lint/suspicious/noExplicitAny: the bridge is a dynamic RPC surface
    const bridge: Record<string, any> = {
      ...real,
      emit: async () => {},
      // Recorded, not merely swallowed: whether a derivative job was enqueued
      // for a SEALED attachment is a product decision, and a stub that drops
      // the call silently would make "thumbnail_key IS NULL" pass for the
      // wrong reason (plan L7).
      enqueueJob: async (...args: unknown[]) => {
        enqueued.push(args.map((a) => String(a)).join(" "))
      },
      connections_getToken: async () => "token",
      connections_getAccounts: async () => "[]",
      fetch: async () => JSON.stringify({ status: 200, headers: {}, body: "{}" }),
      imap_fetch: async () => JSON.stringify({ messages: [], done: true, uidValidity: 1 }),
      smtp_send: async () => JSON.stringify({ messageId: "<harness>" }),
      // Sender contacts stay REAL: a personal mailbox only links to existing
      // contacts (the host page write, mail_writePage), so the harness creates none.
      // EVERY argument, not just the message: the mail bundle passes its
      // reason as a second JSON argument ("Failed to persist inbound
      // attachment", {reason}), and keeping only the first turns a diagnosable
      // failure into a shrug.
      log_info: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      log_warn: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      log_error: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
      log_debug: (...args: unknown[]) => logs.push(args.map(String).join(" ")),
    }

    const runMailHandler = await mailTestRunner()
    let error: string | null = null
    try {
      await runMailHandler({
        exportName: "__test_processMessages",
        params: {
          messages: params.messages,
          account: {
            id: account.id,
            owner_type: account.owner_type,
            owner_id: account.owner_id,
            encryption_state: account.encryption_state,
          },
        },
        bridge,
        timeoutMs: 120_000,
      })
    } catch (e) {
      error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    }
    return { error, logs, enqueued }
  }
}

async function backfill(params: BackfillParams): Promise<unknown> {
  const { runMailboxBackfillForUser } = await import("~/modules/mailbox-crypto/backfill-job")
  const result = await runMailboxBackfillForUser(params.userId, params.orgId, {
    batchIntervalMs: 0,
    ...(params.maxBatches !== undefined ? { maxBatches: params.maxBatches } : {}),
  })
  return result as unknown
}

async function main(): Promise<void> {
  const [command, file] = process.argv.slice(2)
  if (!command || !file) {
    process.stderr.write("usage: mailbox-harness.ts <ingest|backfill> <json-file>\n")
    process.exit(2)
  }
  const params = JSON.parse(await Bun.file(file).text())
  let result: unknown
  switch (command) {
    case "ingest":
      result = await ingest(params as IngestParams)
      break
    case "backfill":
      result = await backfill(params as BackfillParams)
      break
    default:
      process.stderr.write(`unknown command ${command}\n`)
      process.exit(2)
      return
  }
  process.stdout.write(`${RESULT_MARKER} ${JSON.stringify(result)}\n`)
  process.exit(0)
}

void main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`)
  process.exit(1)
})
