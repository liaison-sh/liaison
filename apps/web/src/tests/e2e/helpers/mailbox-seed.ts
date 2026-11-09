// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Seeding, read-back and drive helpers for the local mailbox-encryption lane
// (e2e plan section 1.5(b)).
//
// Two rules this file follows, because the bugs this lane exists to catch all
// came from breaking them:
//   * nothing here constructs crypto. Keys are minted by the real enrollment
//     wizard in a real browser, never by the test.
//   * nothing here writes a sealed row. Sealing is done by the real ingest
//     (through `mailbox-harness.ts`) or the real backfill job.
//
// The plaintext a mailbox holds before its owner enrols (accounts,
// connections, legacy conversations, messages and drafts) comes from the seed
// route's mail factories (`helpers/mail-fixtures.ts`), never a raw insert.

import { randomUUID } from "node:crypto"
import path from "node:path"
import type { WorkerEnv } from "@liaison/test-helpers"
import type { Page } from "@playwright/test"
import {
  seedMailAccount,
  seedMailConversation,
  seedMailDraft,
  setMailProviderEnabled,
} from "./mail-fixtures"

const API_DIR = path.resolve(import.meta.dir, "../../../../../api")

/** The shared local Meilisearch, namespaced per worker by `meiliIndexPrefix`. */
export const MEILI_HOST = process.env.MEILISEARCH_HOST ?? "http://localhost:7700"
export const MEILI_KEY = process.env.MEILISEARCH_API_KEY ?? "dev-master-key"

export function ms(env: WorkerEnv): string {
  return env.schemaPrefix ? `"${env.schemaPrefix}app_mail"` : "app_mail"
}

export function ks(env: WorkerEnv): string {
  return env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
}

/**
 * A passphrase that clears all three floors (zxcvbn 4 or the conservative
 * fallback, 64 bits, not breached). Long, multi-word and mixed-class on
 * purpose: the conservative estimator halves the entropy of a single word.
 */
export const TEST_PASSPHRASE = "Tuvala-Grimwick-8823-Perch!Nimbus-Quarry"

// ── Seeding ──────────────────────────────────────────────────────────────────

export interface SeededMailbox {
  accountId: string
  connectedAccountId: string
  email: string
  conversationIds: string[]
  messageIds: string[]
  phrases: string[]
  subjects: string[]
}

export interface SeedPersonalMailboxOptions {
  /** How many plaintext (legacy) messages to seed. */
  messages?: number
  /** A stable marker embedded in every phrase, so one mailbox cannot see another's. */
  tag?: string
  /** Seed a draft with an EMPTY html_body and a non-empty text_body (plan L10). */
  withEmptyHtmlDraft?: boolean
  /**
   * `org` seeds a SHARED mailbox: the positive control L8 needs. A shared
   * mailbox is outside the encryption regime entirely, so its plaintext is
   * still there afterwards, and an "no plaintext anywhere" sweep that also
   * finds nothing for it is sweeping the wrong database.
   */
  ownerType?: "user" | "org"
}

/**
 * A mailbox with a legacy plaintext corpus, from the seed route's mail
 * factories. Its encryption state is the one the accounts trigger stamps at
 * birth: a personal mailbox whose owner holds no keyring lands at
 * `pending_enrollment` (the only state with a legal `enrolled` edge to
 * `ready`), a shared one stays at `none`.
 */
export async function seedPersonalMailbox(
  env: WorkerEnv,
  orgId: string,
  userId: string,
  options: SeedPersonalMailboxOptions = {},
): Promise<SeededMailbox> {
  const tag = options.tag ?? randomUUID().slice(0, 8)
  const account = await seedMailAccount(env, orgId, {
    userId,
    email: `mailbox-${tag}@e2e.test`,
    ownerType: options.ownerType ?? "user",
  })
  const seeded = await seedIntoAccount(env, orgId, userId, account.accountId, { ...options, tag })
  return { ...seeded, ...account }
}

/**
 * Seed legacy plaintext rows into an EXISTING account. Split out of
 * `seedPersonalMailbox` because the sweep's acknowledgement covers a whole
 * mailbox: a big corpus has to land in the account that is already enrolled,
 * not in a second one.
 */
export async function seedIntoAccount(
  env: WorkerEnv,
  orgId: string,
  userId: string,
  accountId: string,
  options: SeedPersonalMailboxOptions = {},
): Promise<Omit<SeededMailbox, "accountId" | "connectedAccountId" | "email">> {
  const count = options.messages ?? 3
  const tag = options.tag ?? randomUUID().slice(0, 8)
  const email = `mailbox-${tag}@e2e.test`
  const corpus = Array.from({ length: count }, (_, i) => ({
    phrase: `zephyrine-${tag}-body-${i}-quillmark`,
    subject: `zephyrine ${tag} subject ${i}`,
    // Strictly increasing, so the LAST seeded conversation is the newest one
    // and sorts to the top of the inbox list whatever the corpus size.
    sentAt: new Date(Date.UTC(2026, 0, 1, 9, 0, 0) + i * 3_600_000).toISOString(),
    // A JSON object, as a sync stores it: the purge's header reduction calls
    // `jsonb_object_keys` on it (see FINDING D5).
    rawHeaders: {
      "message-id": `<${i}@e2e.web>`,
      subject: `zephyrine ${tag} subject ${i}`,
      "x-originating-ip": `203.0.113.${i % 250}`,
    },
  }))

  const seeded: Array<{ conversationId: string; messageId: string }> = []
  // A few at a time: a 260 message corpus is 260 route calls.
  for (let start = 0; start < corpus.length; start += 10) {
    const batch = await Promise.all(
      corpus.slice(start, start + 10).map(async (c) => {
        const { conversationId, messageIds } = await seedMailConversation(env, orgId, {
          accountId,
          subject: c.subject,
          snippet: c.phrase,
          messages: [
            {
              direction: "inbound",
              from: { name: "Amina", email: "amina@example.test" },
              to: [{ email }],
              textBody: c.phrase,
              sentAt: c.sentAt,
              rawHeaders: c.rawHeaders,
            },
          ],
        })
        return { conversationId, messageId: messageIds[0] as string }
      }),
    )
    seeded.push(...batch)
  }
  const conversationIds = seeded.map((r) => r.conversationId)
  const messageIds = seeded.map((r) => r.messageId)
  const phrases = corpus.map((c) => c.phrase)
  const subjects = corpus.map((c) => c.subject)

  if (options.withEmptyHtmlDraft) {
    const draftPhrase = `zephyrine-${tag}-draft-quillmark`
    await seedMailDraft(env, orgId, {
      accountId,
      userId,
      ...(conversationIds[0] ? { conversationId: conversationIds[0] } : {}),
      to: [{ email: "lucas@example.test" }],
      subject: `zephyrine ${tag} draft subject`,
      textBody: draftPhrase,
      htmlBody: "",
    })
    phrases.push(draftPhrase)
  }

  return { conversationIds, messageIds, phrases, subjects }
}

/** Turn the mail app's gmail provider on, so the connect flow is reachable (as the admin does). */
export async function enableGmailProvider(env: WorkerEnv, adminToken: string): Promise<void> {
  await setMailProviderEnabled(env, adminToken, true)
}

// ── Read-back ────────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: raw SQL rows, shape asserted at the call site
type Row = Record<string, any>

export async function queryRows(env: WorkerEnv, sql: string, params: unknown[] = []) {
  return (await env.db.sql.unsafe(sql, params as never[])) as Row[]
}

export async function readIdentities(env: WorkerEnv, userId: string): Promise<Row[]> {
  return queryRows(
    env,
    `SELECT id::text, key_id, status,
            ecdh_public_key IS NOT NULL AS has_ecdh,
            sign_public_key IS NOT NULL AS has_sign,
            keyring_attestation IS NOT NULL AS has_attestation,
            wrapped_ecdh_private IS NOT NULL AS has_wrapped_ecdh,
            wrapped_sign_private IS NOT NULL AS has_wrapped_sign
       FROM ${ks(env)}.user_mailbox_identities WHERE user_id = $1 ORDER BY key_id`,
    [userId],
  )
}

export async function readWraps(env: WorkerEnv, userId: string): Promise<Row[]> {
  return queryRows(
    env,
    `SELECT id::text, wrap_type, label, kdf_params FROM ${ks(env)}.user_key_wraps WHERE user_id = $1 ORDER BY wrap_type`,
    [userId],
  )
}

export async function readMigrationState(env: WorkerEnv, userId: string): Promise<Row | null> {
  const rows = await queryRows(
    env,
    `SELECT * FROM ${ks(env)}.mailbox_migration_state WHERE user_id = $1`,
    [userId],
  )
  return rows[0] ?? null
}

export async function readAccount(env: WorkerEnv, accountId: string): Promise<Row> {
  const rows = await queryRows(env, `SELECT * FROM ${ms(env)}.accounts WHERE id = $1`, [accountId])
  if (!rows[0]) throw new Error(`no mail account ${accountId}`)
  return rows[0]
}

export async function readMessages(env: WorkerEnv, accountId: string): Promise<Row[]> {
  return queryRows(
    env,
    `SELECT * FROM ${ms(env)}.messages WHERE account_id = $1 ORDER BY sent_at`,
    [accountId],
  )
}

export interface PlaintextCounts {
  messages: number
  conversations: number
  drafts: number
}

/**
 * The witness the plan mandates: a direct count of remaining plaintext.
 * `plaintext_purged_at IS NULL` is NOT a witness that nothing was destroyed
 * (plan section 2.5), so it is never used as one here.
 */
export async function countRemainingPlaintext(
  env: WorkerEnv,
  accountId: string,
): Promise<PlaintextCounts> {
  const [m] = await queryRows(
    env,
    `SELECT count(*)::int AS n FROM ${ms(env)}.messages
      WHERE account_id = $1 AND (subject IS NOT NULL OR text_body IS NOT NULL
            OR html_body IS NOT NULL OR snippet IS NOT NULL)`,
    [accountId],
  )
  const [c] = await queryRows(
    env,
    `SELECT count(*)::int AS n FROM ${ms(env)}.conversations
      WHERE account_id = $1 AND (subject IS NOT NULL OR snippet IS NOT NULL)`,
    [accountId],
  )
  const [d] = await queryRows(
    env,
    // `nullif(..., '')` mirrors the purge's own definition of "still has
    // plaintext": an empty-string column is not a readable copy, and a draft
    // whose `html_body` was '' never gets an `html_body_ciphertext`, so the
    // purge leaves the empty string in place on purpose.
    `SELECT count(*)::int AS n FROM ${ms(env)}.drafts
      WHERE account_id = $1 AND (nullif(subject, '') IS NOT NULL
            OR nullif(text_body, '') IS NOT NULL OR nullif(html_body, '') IS NOT NULL)`,
    [accountId],
  )
  return { messages: m?.n ?? 0, conversations: c?.n ?? 0, drafts: d?.n ?? 0 }
}

// ── The API-side harness, as a subprocess ────────────────────────────────────

export interface HarnessResult {
  exitCode: number
  stdout: string
  stderr: string
  // biome-ignore lint/suspicious/noExplicitAny: the payload shape is per command
  result: any
}

/**
 * Run `apps/api/src/tests/e2e/helpers/mailbox-harness.ts` (or another api-side
 * bun entry point) as a child process bound to THIS worker's schemas.
 */
export async function runApiEntry(
  env: WorkerEnv,
  entry: string,
  args: string[],
  params?: unknown,
): Promise<HarnessResult> {
  let paramFile: string | null = null
  if (params !== undefined) {
    paramFile = path.join(process.env.TMPDIR ?? "/tmp", `mailbox-harness-${randomUUID()}.json`)
    await Bun.write(paramFile, JSON.stringify(params))
  }
  const proc = Bun.spawn({
    cmd: ["bun", entry, ...args, ...(paramFile ? [paramFile] : [])],
    cwd: API_DIR,
    env: {
      ...process.env,
      DATABASE_URL:
        process.env.E2E_SERVER_DATABASE_URL ??
        "postgres://liaison_app:liaison_app@localhost:5432/liaison_test",
      // `export --full` runs pg_dump, which needs the privileged role (the app
      // role cannot lock the drizzle schema). Same connection the worker
      // fixture uses for its own schema surgery.
      MIGRATION_DATABASE_URL:
        process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/liaison_test",
      SCHEMA_PREFIX: env.schemaPrefix,
      REDIS_PREFIX: env.redisPrefix,
      MEILI_INDEX_PREFIX: env.meiliIndexPrefix,
      // The same services the worker's own API process is given. Without these
      // an attachment import would write to a different bucket than the one
      // the browser then reads through `/api/files/:id/inline`.
      MEILISEARCH_HOST: MEILI_HOST,
      MEILISEARCH_API_KEY: MEILI_KEY,
      OBJECT_STORAGE_ENDPOINT: process.env.OBJECT_STORAGE_ENDPOINT ?? "http://localhost:9000",
      OBJECT_STORAGE_BUCKET: process.env.OBJECT_STORAGE_BUCKET ?? "liaison-dev",
      OBJECT_STORAGE_ACCESS_KEY: process.env.OBJECT_STORAGE_ACCESS_KEY ?? "liaison",
      OBJECT_STORAGE_SECRET_KEY: process.env.OBJECT_STORAGE_SECRET_KEY ?? "liaison-dev-secret",
      OBJECT_STORAGE_FORCE_PATH_STYLE: "true",
      ENCRYPTION_KEY: env.encryptionKey,
      JWT_SECRET: "e2e-test-secret-minimum-32-characters-long",
      NODE_ENV: "test",
      LOG_LEVEL: "warn",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const marker = stdout
    .split("\n")
    .find((line) => line.startsWith("__MAILBOX_HARNESS__"))
    ?.slice("__MAILBOX_HARNESS__ ".length)
  return { exitCode, stdout, stderr, result: marker ? JSON.parse(marker) : null }
}

export async function runIngest(
  env: WorkerEnv,
  params: { orgId: string; accountId: string; actor: string; messages: unknown[] },
): Promise<HarnessResult> {
  return runApiEntry(env, "src/tests/e2e/helpers/mailbox-harness.ts", ["ingest"], params)
}

export async function runBackfill(
  env: WorkerEnv,
  params: { orgId: string; userId: string; maxBatches?: number },
): Promise<HarnessResult> {
  return runApiEntry(env, "src/tests/e2e/helpers/mailbox-harness.ts", ["backfill"], params)
}

/** The real operator command: `liaison mailbox purge ...`. */
export async function runPurgeCli(
  env: WorkerEnv,
  args: string[],
): Promise<Omit<HarnessResult, "result">> {
  const { result: _ignored, ...rest } = await runApiEntry(env, "src/cli/index.ts", [
    "mailbox",
    "purge",
    ...args,
  ])
  return rest
}

/** An attachment as the mail bundle's `processMessages` hands it to the bridge. */
export interface IngestAttachment {
  filename: string
  mimeType: string
  bytesBase64: string
  disposition?: "attachment" | "inline"
}

/** Fixture messages in the shape the mail bundle's `processMessages` expects. */
export function ingestFixtures(
  tag: string,
  count: number,
  toEmail: string,
  attachments: IngestAttachment[] = [],
): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    // Attachments ride on the FIRST message only, so a scenario that seeds
    // three files knows exactly which message carries them.
    attachments: i === 0 ? attachments : [],
    externalMessageId: `<${tag}-${randomUUID()}@example.test>`,
    externalProviderId: `p-${tag}-${i}`,
    externalThreadId: `<${tag}-thread-${i}@example.test>`,
    from: { name: "Amina", email: "amina@example.test" },
    to: [{ email: toEmail }],
    cc: [],
    bcc: [],
    subject: `zephyrine ${tag} inbound subject ${i}`,
    textBody: `zephyrine-${tag}-inbound-${i}-quillmark`,
    htmlBody: `<p>zephyrine-${tag}-inbound-${i}-quillmark</p>`,
    snippet: `zephyrine-${tag}-inbound-${i}-quillmark`,
    headers: {
      "message-id": `<${tag}-${i}@example.test>`,
      subject: `zephyrine ${tag} inbound subject ${i}`,
      "x-originating-ip": "203.0.113.9",
      "x-secret-routing": `zephyrine-${tag}-header-${i}-quillmark`,
    },
    inReplyTo: null,
    references: [],
    labels: ["INBOX"],
    isRead: false,
    isStarred: false,
    sentAt: new Date(Date.UTC(2026, 1, 1 + (i % 27), 11, i % 60)).toISOString(),
    direction: "inbound",
  }))
}

/** The real `liaison export --full`, into a temp path this worker owns. */
export async function runExportFull(
  env: WorkerEnv,
  outPath: string,
): Promise<Omit<HarnessResult, "result">> {
  const { result: _ignored, ...rest } = await runApiEntry(env, "src/cli/index.ts", [
    "export",
    "--full",
    "--output",
    outPath,
  ])
  return rest
}

/** The real `liaison search reindex`, so the Meili probe is not vacuous. */
export async function runSearchReindex(env: WorkerEnv): Promise<Omit<HarnessResult, "result">> {
  // One rebuild at a time per search namespace: a lane running in parallel
  // (another file's reindex) holds the rebuild lock, and the CLI refuses
  // rather than queue. Take a turn after it, for up to two minutes.
  const deadline = Date.now() + 120_000
  for (;;) {
    const { result: _ignored, ...rest } = await runApiEntry(env, "src/cli/index.ts", [
      "search",
      "reindex",
    ])
    const busy =
      rest.exitCode !== 0 && rest.stderr.includes("another search index rebuild is running")
    if (!busy || Date.now() > deadline) return rest
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
}

export interface ExtractedExport {
  /** Every extracted file's bytes, decoded as latin1 and concatenated. */
  text: string
  /** Relative paths inside the artifact. */
  files: string[]
}

/**
 * Unpack an `export --full` tarball and read everything in it.
 *
 * latin1, not utf8: the artifact carries object-storage bytes as well as SQL,
 * and a lossy utf8 decode of ciphertext could in principle destroy a byte
 * sequence a phrase search is looking for. latin1 is a total decoding.
 */
export async function extractExport(tarPath: string): Promise<ExtractedExport> {
  const dir = path.join(process.env.TMPDIR ?? "/tmp", `mailbox-export-${randomUUID()}`)
  const mk = Bun.spawn({ cmd: ["mkdir", "-p", dir] })
  await mk.exited
  const tar = Bun.spawn({ cmd: ["tar", "xzf", tarPath, "-C", dir], stderr: "pipe" })
  const tarErr = await new Response(tar.stderr).text()
  if ((await tar.exited) !== 0) throw new Error(`tar failed: ${tarErr}`)
  const listing = Bun.spawn({ cmd: ["find", dir, "-type", "f"], stdout: "pipe" })
  const found = (await new Response(listing.stdout).text()).split("\n").filter(Boolean)
  let text = ""
  for (const file of found) {
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
    text += new TextDecoder("latin1").decode(bytes)
  }
  return { text, files: found.map((f) => f.slice(dir.length + 1)) }
}

export interface MeiliProbeResult {
  index: string
  /** Documents that actually CONTAIN the phrase. */
  hits: number
  /** Documents Meilisearch considered relevant, exact or not. Diagnostic only. */
  matched: number
  /** Exact hits left out because they belong to an excluded conversation. */
  excluded: number
}

/**
 * Search every index in THIS worker's Meili namespace for a phrase.
 *
 * Scoped to `env.meiliIndexPrefix` deliberately (plan L8): Meilisearch is a
 * shared instance, and sweeping every index would reach sibling workers and
 * stale leftovers and fail for reasons that have nothing to do with the mailbox
 * under test. "Every index, enumerated live" is the prod lane's rule.
 */
export async function meiliProbe(
  env: WorkerEnv,
  phrase: string,
  options: {
    waitMs?: number
    /**
     * Kernel conversations whose messages may carry the phrase because the user
     * put it there: a chat where they typed it, or asked their agent to quote
     * it back. Only `app: kernel` documents with one of these `thread_id`s are
     * left out; a mail document, or any other conversation, still counts.
     */
    excludeKernelThreadIds?: readonly string[]
  } = {},
): Promise<MeiliProbeResult[]> {
  // Meilisearch indexes asynchronously: a probe fired the moment the reindex
  // command returns can read an empty index and call it a pass.
  if (options.waitMs) await new Promise((resolve) => setTimeout(resolve, options.waitMs))
  return meiliProbeNow(env, phrase, options.excludeKernelThreadIds ?? [])
}

async function meiliProbeNow(
  env: WorkerEnv,
  phrase: string,
  excludeKernelThreadIds: readonly string[],
): Promise<MeiliProbeResult[]> {
  const headers = { authorization: `Bearer ${MEILI_KEY}`, "content-type": "application/json" }
  const listed = await fetch(`${MEILI_HOST}/indexes?limit=1000`, { headers })
  if (!listed.ok) throw new Error(`meili index listing failed: ${listed.status}`)
  const body = (await listed.json()) as { results: Array<{ uid: string }> }
  const mine = body.results.filter((i) => i.uid.startsWith(env.meiliIndexPrefix))
  const out: MeiliProbeResult[] = []
  for (const index of mine) {
    const res = await fetch(`${MEILI_HOST}/indexes/${index.uid}/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({ q: phrase, limit: 50 }),
    })
    if (!res.ok) throw new Error(`meili search on ${index.uid} failed: ${res.status}`)
    const body = (await res.json()) as { hits: unknown[] }
    // EXACT containment, not Meilisearch's own relevance. Meili is typo- and
    // prefix-tolerant, so `zephyrine-l10-body-0-quillmark` matches any document
    // built from the same vocabulary (another mailbox's subject, say) and a
    // naive hit count reports a leak that is not there. What SC4 asks is
    // whether any DOCUMENT carries the phrase, so that is what is counted.
    const exact = body.hits.filter((hit) =>
      JSON.stringify(hit).toLowerCase().includes(phrase.toLowerCase()),
    )
    const isExcluded = (hit: unknown) => {
      const doc = hit as { app?: unknown; thread_id?: unknown }
      return (
        doc.app === "kernel" &&
        typeof doc.thread_id === "string" &&
        excludeKernelThreadIds.includes(doc.thread_id)
      )
    }
    const counted = exact.filter((hit) => !isExcluded(hit))
    out.push({
      index: index.uid,
      hits: counted.length,
      matched: body.hits.length,
      excluded: exact.length - counted.length,
    })
  }
  return out
}

/** `kernel.files` rows parented to one mail message. */
export async function readMessageFiles(env: WorkerEnv, messageId: string): Promise<Row[]> {
  return queryRows(
    env,
    `SELECT id::text, filename, mime_type, size_bytes, storage_key, enc_version,
            chunk_size, chunk_count, plaintext_length,
            thumbnail_key, analysis_summary
       FROM ${ks(env)}.files
      WHERE app = 'mail' AND entity_type = 'message' AND entity_id = $1
      ORDER BY ordinal`,
    [messageId],
  )
}

// ── Browser drive helpers ────────────────────────────────────────────────────

/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/plain",
      body: "0000000000000000000000000000000000A:12\n1111111111111111111111111111111111B:3\n",
    })
  })
}

/**
 * Point the page's WebSocket at the API directly, and record what it sends.
 *
 * WHY THIS EXISTS, MEASURED RATHER THAN ASSUMED. This lane must run against a
 * production BUILD (`E2E_WEB_PREVIEW=1`), which is served by `vite preview`.
 * The built bundle has no `VITE_API_TARGET` baked in, so it derives the socket
 * host from `window.location` and reaches the API through the preview server's
 * `/ws` proxy. That proxy does not complete the upgrade: measured from inside
 * the page, `ws://<preview-host>/ws?ticket=...` times out with no open, no
 * error and no close, while the SAME ticket against the API's own host opens
 * immediately. So under preview, every socket-dependent behaviour is dead, and
 * the two-phase agent read is entirely socket-dependent.
 *
 * This rewrites the socket URL to the API host the proxy would have forwarded
 * to. It is a harness routing fix, not a stub: the frames, the ticket, the
 * server handler, the unlock assertion and the decrypt request are all the real
 * ones. Nothing that this lane exists to test sits on the rewritten hop.
 *
 * Call it BEFORE the first navigation.
 */
export async function routeWebSocketToApi(page: Page, env: WorkerEnv): Promise<void> {
  const apiHost = new URL(env.serverUrl).host
  await page.addInitScript((host: string) => {
    const w = window as unknown as { __wsSent?: string[] }
    w.__wsSent = []
    const Original = window.WebSocket
    // A `function`, NOT an arrow: the app calls `new WebSocket(...)`, and an
    // arrow function has no [[Construct]], so `new` on it throws and every
    // socket in the page dies. Biome's `useArrowFunction` rewrite of this line
    // is a behaviour change, not a style fix.
    // biome-ignore lint/complexity/useArrowFunction: must be constructible with `new`
    const Patched = function (url: string | URL, protocols?: string | string[]) {
      const rewritten = String(url).replace(/^(wss?:\/\/)[^/]+/, `$1${host}`)
      const socket = new Original(rewritten, protocols as string[])
      const send = socket.send.bind(socket)
      socket.send = (data: string) => {
        try {
          w.__wsSent?.push(String(data).slice(0, 200))
        } catch {
          /* observation only */
        }
        send(data)
      }
      return socket
    } as unknown as typeof WebSocket
    Patched.prototype = Original.prototype
    // The STATIC readyState constants, and they are load-bearing:
    // `createWebSocket` guards every send with
    // `socket?.readyState === WebSocket.OPEN`, so a patched constructor that
    // drops `OPEN` makes every send a silent no-op and the app looks broken
    // in exactly the way this lane is trying to detect. Copy them all.
    Object.defineProperties(
      Patched,
      Object.getOwnPropertyDescriptors(Original) as PropertyDescriptorMap,
    )
    window.WebSocket = Patched
  }, apiHost as never)
}

/** What the page's own socket has sent so far, newest last. */
export async function sentSocketFrames(page: Page): Promise<string[]> {
  return (await page.evaluate(() => {
    const w = window as unknown as { __wsSent?: string[] }
    return w.__wsSent === undefined ? ["<socket probe not installed>"] : w.__wsSent
  })) as string[]
}

export interface EnrolmentResult {
  /** Wall clock milliseconds spent inside the mailbox password step (real PBKDF2). */
  passphraseMs: number
  /** True when the page fetched the hash-wasm module during enrolment. */
  hashWasmObserved: boolean
}

/**
 * Drive the REAL enrollment wizard, in the order the shipped component offers.
 *
 * The wizard is reached the way a person reaches it: connecting a personal
 * mailbox. `MailAccountSettings.connectGmail("user")` refuses to hand off to
 * OAuth until a keyring exists, and mounts `MailboxEnrollment` instead, so the
 * connect button IS the entry point. `mail-account-security` shows the security
 * PANEL, which never offers enrolment.
 *
 * Setup is one screen: the mailbox password, which cannot be skipped. Where the
 * browser says passkeys can work, a one-line passkey offer follows and
 * `skip-passkey` finishes without one (a headless browser has no
 * authenticator); elsewhere the password step posts the keyring by itself.
 * Either way the wizard ends with the mailbox OPEN: it unlocks with the
 * password just chosen, so no unlock prompt follows.
 */
export function webUrl(env: WorkerEnv, path = "/"): string {
  return `http://localhost:${env.ports[1]}${path}`
}

/**
 * The rendered body text of the nth message on screen.
 *
 * `mail-message-body` is the sandboxed iframe inside `MailMessageRenderer`
 * (its card in `MailConversation` is `mail-message-content`). The text lives
 * in the iframe's document: read through the frame.
 */
export async function readRenderedBody(page: Page, index = 0): Promise<string> {
  const frame = page.getByTestId("mail-message-body").nth(index).contentFrame()
  const body = frame.locator("body")
  await body.waitFor({ state: "attached", timeout: 60_000 })
  return (await body.innerText()).trim()
}

/**
 * Open one conversation by id. A SEALED conversation has no readable subject in
 * the list, so locating it by text works only after an unlock. The row carries
 * `data-conversation-id`, which is stable either way.
 */
export async function openConversationById(page: Page, conversationId: string): Promise<void> {
  const row = page.locator(`[data-conversation-id="${conversationId}"]`)
  await row.waitFor({ state: "visible", timeout: 60_000 })
  await row.locator("button").first().click()
}

/**
 * Open the mail surface through the activity bar, as a person does.
 *
 * On an encrypted mailbox a fresh page is locked, and the mail home asks to
 * unlock as soon as it knows (once per page load). By default this answers
 * "Not now", so a scenario that unlocks from a conversation keeps doing so;
 * `landingPrompt: "keep"` leaves the prompt open for the scenario to drive.
 *
 * The home also shows its own locked notice, and tabs stay mounted when
 * hidden, so scenarios target the VISIBLE `mailbox-locked-notice`.
 */
export async function openMail(
  page: Page,
  env: WorkerEnv,
  options: { landingPrompt?: "dismiss" | "keep" } = {},
): Promise<void> {
  await openMailAt(page, webUrl(env, "/"), options)
}

/** `openMail` against an explicit web root (the helper's own regression test serves one). */
export async function openMailAt(
  page: Page,
  root: string,
  options: { landingPrompt?: "dismiss" | "keep" } = {},
): Promise<void> {
  await page.goto(root)
  // Registered AFTER the navigation has finished and before the click, so the
  // response is one this document made: the mail home reads the keyring on
  // mount (MailInbox `loadMailboxKeyring`), so the read cannot be missed. Its
  // body says whether a prompt is coming at all.
  //
  // Never before the `goto`: the previous document (the shell `loginAs` left
  // open) reads the same keyring at startup. When that read had its headers
  // but not its body as the navigation tore the document down, the waiter
  // matched it, and Playwright's `response.text()` on a response whose
  // document is gone never settles (neither resolves nor rejects, so the
  // `.catch` below never ran). The helper then hung with the landing prompt
  // open until the test's own timeout (CI: 300 s and 600 s).
  const keyring = page
    .waitForResponse((r) => r.url().includes("/api/mailbox-keys/me"), { timeout: 60_000 })
    .then((r) => r.text())
    .catch(() => "")
  await page.getByRole("button", { name: "Mail", exact: true }).click()
  await page.getByTestId("mail-inbox").waitFor({ state: "visible", timeout: 60_000 })
  const enrolled = /"status"\s*:\s*"active"/.test(await keyring)
  if (!enrolled || options.landingPrompt === "keep") return
  const host = page.getByTestId("mailbox-unlock-host")
  const prompted = await host
    .waitFor({ state: "visible", timeout: 30_000 })
    .then(() => true)
    .catch(() => false)
  if (prompted) {
    await page.getByTestId("mailbox-unlock-host.dismiss").click()
    await host.waitFor({ state: "hidden", timeout: 30_000 })
  }
}

/**
 * Reach Settings > Apps > Mail (the accounts page) the way a person does. A direct `goto` of
 * `/settings/mail/accounts` opens the Settings TAB but renders Profile (the tab
 * store owns the sub-route), so the sidebar link is the real navigation.
 */
export async function openMailAccountSettings(
  page: Page,
  env: WorkerEnv,
  options: { reload?: boolean } = {},
): Promise<void> {
  // `reload: false` keeps the SPA session alive. It matters for anything that
  // has unlocked the mailbox: the crypto worker holds the session, so a full
  // page load relocks it and the next sweep refuses with "unlock the mailbox
  // before verifying it".
  if (options.reload === false) {
    await page.getByTestId("activity-settings").click()
  } else {
    await page.goto(webUrl(env, "/settings"))
  }
  await page.getByTestId("settings-link-app:mail").click()
  await page.getByTestId("mail-account-settings").waitFor({ state: "visible", timeout: 60_000 })
}

export async function enrolMailboxThroughUi(page: Page, env: WorkerEnv): Promise<EnrolmentResult> {
  let hashWasmObserved = false
  page.on("request", (request) => {
    if (/hash-wasm|argon2/i.test(request.url())) hashWasmObserved = true
  })

  await openMailAccountSettings(page, env)
  // The crypto worker boots with the app. It is fetched (and hashed) before it
  // starts, so its resource entry is the boot's witness. Waited for BEFORE the
  // route below: while any route is on, Playwright's WebKit cannot boot a
  // module worker from a revoked blob URL, and setup now opens the mailbox on
  // that worker.
  await page
    .waitForFunction(
      () =>
        performance.getEntriesByType("resource").some((entry) => /crypto-worker/.test(entry.name)),
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => {})
  await page.waitForTimeout(500)

  // The OAuth handoff that follows a successful enrolment: intercepted at the
  // network boundary so the browser is not sent to Google. Nothing about
  // sealing, reading or key handling is on this wire.
  await page.route("**/api/connections/mail/gmail/authorize", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, data: { redirectUrl: "" } }),
    })
  })

  await page.getByTestId("mail-connect-gmail").click()
  await page.getByTestId("mailbox-enrollment").waitFor({ state: "visible", timeout: 60_000 })

  // One screen: no "begin" click before the password.
  await page.getByTestId("mailbox-enrollment.passphrase").fill(TEST_PASSPHRASE)
  await page.getByTestId("mailbox-enrollment.passphrase-confirm").fill(TEST_PASSPHRASE)
  const started = Date.now()
  await page.getByTestId("mailbox-enrollment.accept-passphrase").click()
  // The passkey offer (where passkeys can work) is reached only after the
  // password wrap is minted; where they cannot, the wizard finishes by itself.
  // Either is the password step's completion.
  const skip = page.getByTestId("mailbox-enrollment.skip-passkey")
  const offered = await Promise.race([
    skip.waitFor({ state: "visible", timeout: 120_000 }).then(() => true),
    page
      .getByTestId("mailbox-enrollment")
      .waitFor({ state: "detached", timeout: 120_000 })
      .then(() => false),
  ])
  const passphraseMs = Date.now() - started
  if (offered) await skip.click()
  // `onEnrolled` unmounts the wizard (it clears `enrollmentFor`), so the wizard
  // disappearing is the POST having succeeded. The DB read is the real proof.
  await page.getByTestId("mailbox-enrollment").waitFor({ state: "detached", timeout: 120_000 })

  return { passphraseMs, hashWasmObserved }
}

/** Unlock through the real unlock surface, with the mailbox password. */
export async function unlockMailboxThroughUi(
  page: Page,
  method: "passphrase",
  secret: string,
): Promise<void> {
  // The page's own account of the attempt, kept for the failure message: the
  // unlock runs in the crypto worker, and a stall leaves nothing else behind.
  const consoleLines: string[] = []
  const onConsole = (message: { type(): string; text(): string }) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleLines.push(`[${message.type()}] ${message.text().slice(0, 300)}`)
    }
  }
  page.on("console", onConsole)
  try {
    await page.getByTestId("mailbox-unlock").waitFor({ state: "visible", timeout: 60_000 })
    await page.getByTestId(`mailbox-unlock.method-${method}`).click()
    await page.getByTestId("mailbox-unlock.secret").fill(secret)
    await page.getByTestId("mailbox-unlock.submit").click()
    // A browser with WebAuthn is offered this computer's passkey after a
    // password unlock, and the modal stays open until that is answered. The run
    // has no authenticator, so it answers "not now". Whichever comes first ends
    // the wait: the offer, the modal closing, or a refusal (callers that expect
    // one assert on it). None of them within the budget is a stalled unlock, and
    // it fails HERE, with what the screen showed, instead of running the test
    // into its own timeout with nothing to say.
    const offer = page.getByTestId("mailbox-unlock.offer-passkey")
    const settled = await Promise.race([
      offer
        .waitFor({ state: "visible", timeout: 120_000 })
        .then(() => page.getByTestId("mailbox-unlock.decline-passkey").click())
        .then(() => true),
      page
        .getByTestId("mailbox-unlock-host")
        .waitFor({ state: "hidden", timeout: 120_000 })
        .then(() => true),
      page
        .getByTestId("mailbox-unlock.refusal")
        .waitFor({ state: "visible", timeout: 120_000 })
        .then(() => true),
    ]).catch(() => false)
    if (!settled) {
      throw new Error(
        `the mailbox unlock did not settle within 120 s\n${await describeUnlock(page)}\nconsole:\n${consoleLines.join("\n") || "(none)"}`,
      )
    }
  } finally {
    page.off("console", onConsole)
  }
}

/** What the unlock surface shows right now, for a failure message. */
async function describeUnlock(page: Page): Promise<string> {
  const visible = (testId: string) =>
    page
      .getByTestId(testId)
      .isVisible()
      .catch(() => false)
  const field = await page
    .getByTestId("mailbox-unlock.secret")
    .inputValue({ timeout: 1_000 })
    .catch(() => null)
  return [
    `host visible: ${await visible("mailbox-unlock-host")}`,
    `password field: ${field === null ? "absent" : field === "" ? "EMPTY" : `${field.length} chars`}`,
    `still working: ${await visible("mailbox-unlock.still-working")}`,
    `refusal: ${await visible("mailbox-unlock.refusal")}`,
    `passkey offer: ${await visible("mailbox-unlock.offer-passkey")}`,
  ].join("\n")
}

// ── Pre-cutover control-plane residue (plan L10 step 6) ──────────────────────

export interface SeededResidue {
  phrase: string
  before: Record<string, number>
  recount(): Promise<Record<string, number>>
}

/**
 * Write the four kinds of pre-cutover residue purge step 7d claims to remove,
 * shaped to match its own predicates exactly:
 *   * `kernel.audit_log.changes` for a mail entity of this mailbox,
 *   * a `kernel.threads.title` reachable through `conversations.internal_thread_id`,
 *   * a `mail__*` approval payload requested by this user,
 *   * `kernel.messages.metadata.toolCalls[].result` on a thread this user is in.
 *
 * Without this, step 7d has NO local coverage: the Invariant K checks elsewhere
 * only assert that NEWLY written rows are clean, which a residue purge that
 * silently does nothing satisfies perfectly.
 */
export async function seedControlPlaneResidue(
  env: WorkerEnv,
  orgId: string,
  userId: string,
  tag: string,
): Promise<SeededResidue> {
  const phrase = `zephyrine-${tag}-residue-quillmark`
  const K = ks(env)
  const M = ms(env)

  const [conversation] = await queryRows(
    env,
    `SELECT c.id::text AS id, c.subject FROM ${M}.conversations c
       JOIN ${M}.accounts a ON a.id = c.account_id
      WHERE a.owner_id = $1 AND a.owner_type = 'user' LIMIT 1`,
    [userId],
  )
  const [message] = await queryRows(
    env,
    `SELECT m.id::text AS id FROM ${M}.messages m
       JOIN ${M}.accounts a ON a.id = m.account_id
      WHERE a.owner_id = $1 AND a.owner_type = 'user' LIMIT 1`,
    [userId],
  )
  if (!conversation || !message) throw new Error("no mail rows to hang residue off")

  // 1. A thread title carrying the conversation subject, linked to the
  // conversation through its created_from reference.
  const threadId = randomUUID()
  await env.db.sql.unsafe(
    `INSERT INTO ${K}.threads (id, org_id, handle, title, type, created_by)
     VALUES ($1, $2, $3, $4, 'thread', $5)`,
    [threadId, orgId, `residue-${tag}`, `Discussion: ${phrase}`, userId],
  )
  await env.db.sql.unsafe(
    `INSERT INTO ${K}.thread_participants (id, thread_id, user_id, role, org_id)
     VALUES ($1, $2, $3, 'member', $4)`,
    [randomUUID(), threadId, userId, orgId],
  )
  await env.db.sql.unsafe(`UPDATE ${M}.conversations SET internal_thread_id = $1 WHERE id = $2`, [
    threadId,
    conversation.id,
  ])

  // 2. An audit-log change payload for a mail entity of this mailbox.
  await env.db.sql.unsafe(
    `INSERT INTO ${K}.audit_log (id, org_id, actor_id, actor_type, app, entity_type, entity_id, action, changes)
     VALUES ($1, $2, $3, 'user', 'mail', 'message', $4, 'update', $5::jsonb)`,
    [randomUUID(), orgId, userId, message.id, { textBody: phrase }],
  )

  // 3. A tool-call result on a kernel message of a thread this user is in.
  await env.db.sql.unsafe(
    `INSERT INTO ${K}.messages (id, thread_id, org_id, author_id, author_type, content, metadata, required_scopes)
     VALUES ($1, $2, $3, $4, 'agent', 'residue', $5::jsonb, '{}')`,
    [
      randomUUID(),
      threadId,
      orgId,
      userId,
      { toolCalls: [{ toolName: "mail__read", result: { body: phrase } }] },
    ],
  )

  // 4. A gated mail send's approval payload.
  await env.db.sql.unsafe(
    `INSERT INTO ${K}.approval_requests
       (id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
        current_payload, expires_at, requested_by, summary)
     VALUES ($1, $2, $3, $4, $4, 'mail:reply', $5::jsonb, $5::jsonb, now() + interval '1 day', $6, $7::jsonb)`,
    [
      randomUUID(),
      orgId,
      `AP-${tag}`,
      threadId,
      { conversationId: conversation.id, textBody: phrase },
      userId,
      { text: phrase },
    ],
  )

  const recount = async (): Promise<Record<string, number>> => {
    const one = async (sql: string) => Number((await queryRows(env, sql, [phrase]))[0]?.n ?? 0)
    return {
      "threads.title": await one(
        `SELECT count(*)::int AS n FROM ${K}.threads WHERE title LIKE '%' || $1 || '%'`,
      ),
      "audit_log.changes": await one(
        `SELECT count(*)::int AS n FROM ${K}.audit_log WHERE changes::text LIKE '%' || $1 || '%'`,
      ),
      "messages.metadata": await one(
        `SELECT count(*)::int AS n FROM ${K}.messages WHERE metadata::text LIKE '%' || $1 || '%'`,
      ),
      "approval_requests.payload": await one(
        `SELECT count(*)::int AS n FROM ${K}.approval_requests
          WHERE (tool_params::text LIKE '%' || $1 || '%'
                 OR current_payload::text LIKE '%' || $1 || '%'
                 OR coalesce(summary::text, '') LIKE '%' || $1 || '%')`,
      ),
    }
  }

  return { phrase, before: await recount(), recount }
}
