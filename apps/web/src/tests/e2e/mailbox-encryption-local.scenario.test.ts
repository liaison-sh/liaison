// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The LOCAL lane for zero-access personal mailboxes (e2e plan section 3).
//
// Every scenario here runs against a per-worker stack: a real API process, a
// real Vite build, a real Chromium, a real Postgres schema, the real sandbox
// and the real crypto worker. Nothing about sealing, reading, sweeping or
// purging is stubbed. Each scenario names what is REAL and what is FAKED.
//
//   bun run scripts/test-run.ts playwright \
//     --file src/tests/e2e/mailbox-encryption-local.scenario.test.ts
//
// The lane uses no fakes: the mailbox password check makes no network call.
//
// Non-vacuity is asserted FIRST, every time. "No plaintext was found" is
// satisfied perfectly by an empty corpus.

import { randomUUID } from "node:crypto"
import type { WorkerEnv } from "@liaison/test-helpers"
import type { Page } from "@playwright/test"
import { openAgentConversation, sendInConversation } from "./agent-bootstrap"
import {
  agentDmThreadId,
  ECHO_MISS,
  type ScriptedTurnStep,
  scriptAgentTurn,
  waitForTurnEnd,
} from "./agent-turn"
import { expect, loginAs, test } from "./fixtures/test"
import { grantScopes, seedModelPricingAndCredits } from "./helpers/agent-seed"
import { freshAccessToken } from "./helpers/fresh-token"
import {
  countRemainingPlaintext,
  enableGmailProvider,
  enrolMailboxThroughUi,
  extractExport,
  ingestFixtures,
  ks,
  meiliProbe,
  ms,
  openConversationById,
  openMail,
  openMailAccountSettings,
  queryRows,
  readAccount,
  readIdentities,
  readMessageFiles,
  readMessages,
  readMigrationState,
  readRenderedBody,
  readWraps,
  routeWebSocketToApi,
  runBackfill,
  runExportFull,
  runIngest,
  runPurgeCli,
  runSearchReindex,
  seedControlPlaneResidue,
  seedPersonalMailbox,
  sentSocketFrames,
  TEST_PASSPHRASE,
  unlockMailboxThroughUi,
  webUrl,
} from "./helpers/mailbox-seed"

/**
 * Opens the unlock modal from the locked mail home. Landing on a locked inbox
 * also opens it by itself, once per page (MailInbox's landing prompt), and that
 * races the click: a modal that appears first intercepts it. Either way ends
 * with the modal open.
 */
async function openMailboxUnlock(page: Page): Promise<void> {
  const host = page.getByTestId("mailbox-unlock-host")
  const notice = page.getByTestId("mailbox-locked-notice.unlock").filter({ visible: true }).first()
  await expect(async () => {
    if (await host.isVisible()) return
    await notice.click({ timeout: 2_000 })
    await expect(host).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
}

test.describe.configure({ mode: "serial" })

/**
 * THIS LANE REQUIRES A BUILD, and says so loudly rather than skipping.
 *
 * The crypto worker is booted from a blob URL after the page verifies its
 * SHA-256 (`worker-integrity.ts`), which needs the ONE self-contained file the
 * production build emits (`worker: { format: "iife" }` in vite.config.ts).
 * Under `vite dev` the worker is a module with imports, the blob worker dies on
 * load, and every sealed read then hangs forever (see FINDING D1). Run:
 *
 *   cd apps/web && E2E_WEB_PREVIEW=1 bunx --bun playwright test \
 *     src/tests/e2e/mailbox-encryption-local.scenario.test.ts
 */
test.beforeAll(() => {
  expect(
    process.env.E2E_WEB_PREVIEW,
    "the mailbox lane must run against a production build: set E2E_WEB_PREVIEW=1 " +
      "(global-setup runs `vite build`, the worker fixture then serves it with `vite preview`). " +
      "Under the dev server the crypto worker cannot boot from a blob URL and every sealed read hangs.",
  ).toBe("1")
})

/**
 * Enrolment happens ONCE, in L1, and the later scenarios use that mailbox.
 * That is not a shortcut: `enrollKeyring` short-circuits on an existing active
 * identity, so a second enrolment through the wizard would mint no new wraps,
 * and the mailbox under test is the one a person actually set up.
 */
/** What L10 leaves behind: a fully sealed, purged mailbox, which is the state
 *  SC1 to SC5 describe. L8 sweeps THAT, because a mailbox mid-migration still
 *  holds legacy plaintext on purpose. */
const purged: { userId: string; accountId: string; phrases: string[]; subjects: string[] } = {
  userId: "",
  accountId: "",
  phrases: [],
  subjects: [],
}

const enrolled: {
  accountId: string
  email: string
  phrases: string[]
  subjects: string[]
  sealedConversationId: string
  sealedMessageId: string
  sealedPhrase: string
  sealedSubject: string
  conversationIds: string[]
} = {
  accountId: "",
  email: "",
  phrases: [],
  subjects: [],
  sealedConversationId: "",
  sealedMessageId: "",
  sealedPhrase: "",
  sealedSubject: "",
  conversationIds: [],
}

/** A real thread, through the real route, so the agent panel has somewhere to run. */
async function createThread(
  env: WorkerEnv,
  token: string,
  title: string,
  userId: string,
): Promise<string> {
  const res = await fetch(`${env.serverUrl}/api/threads`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ forceCreate: true, title, participantIds: [userId] }),
  })
  const body = (await res.json()) as { data?: { id?: string }; error?: unknown }
  if (!res.ok || !body.data?.id) throw new Error(`thread create failed: ${JSON.stringify(body)}`)
  return body.data.id
}

/**
 * The script step that loads one deferred app tool, the way a model does it.
 *
 * Every app tool is deferred by default (`tool-bridge.ts` returns
 * `toolDef.deferLoading ?? appName !== "kernel"`), so a turn has to call
 * `tool_search` before the provider is shown `mail__read` at all. Writing the
 * name into `threads.agent_discovered_tools` no longer stands in for that: the
 * discovery window (`discovery-window.ts`) keeps a persisted name only while an
 * agent row after the checkpoint shows it, so a seeded name with no such row
 * is expired before the turn starts, and the call the scenario scripted is
 * rewritten into a `tool_search select:` (`blindCallRepair`), leaving the next
 * scripted step to run with no tool result. The select step is one real
 * `tool_search`; the tool that then runs is the real one.
 */
function loadToolStep(name: string): ScriptedTurnStep {
  return { toolCalls: [{ name: "kernel__tool_search", args: { query: `select:${name}` } }] }
}

/**
 * P4c-T21b — THE THREE AGENT SCENARIOS HERE (L5, L6, L12) RUN ON A SCRIPTED
 * SERVER-SIDE TURN, IN THE ONE CONVERSATION.
 *
 * They used to drive the retired right-rail `agent-panel` inside a bespoke
 * thread tab, against a LIVE model, and retry the send up to four times until
 * the model happened to call the tool the scenario needed. The panel is gone;
 * so is the retrying. Only the MODEL is scripted (`agent-turn.ts`): `mail__read`,
 * `mail__search` and `mail__reply` execute FOR REAL, so the two-phase broker,
 * the client index, the seal and the gate are all still the real ones.
 *
 * TWO CONSEQUENCES WORTH KNOWING:
 *
 *  - The conversation is the personal-agent DM, reached with `mod+.`
 *    (`openAgentConversation`). It comes up as an expanded DOCK tab, which
 *    floats over whatever surface is showing — so the mail tab can stay ACTIVE
 *    and mounted while the turn runs, which is what the two-phase protocol needs
 *    and what the old version had to build a second tab to arrange.
 *  - Each script opens with `loadToolStep`, one real `tool_search select:`,
 *    because the mail tools are deferred and a seeded discovery column is
 *    expired by the discovery window before the turn starts.
 *
 * L5 additionally uses the script's `echo` step. Everywhere else a scenario
 * reads the REAL tool result off the turn's persisted `metadata.toolCalls`; for
 * mail that is deliberately impossible (Invariant K redacts it), so `echo` makes
 * the step answer with what the MODEL WAS SHOWN, and "the decrypted body reached
 * the model" becomes an assertion instead of a hope.
 *
 * STATUS: all three run green on the scripted turn. They had never passed on
 * it: the discovery column seeding they relied on is expired by the discovery
 * window, L6 passed `body` as a boolean, and the agent DM itself (the user's
 * prompt, the quoted reply) carries the phrase by the user's own choice.
 */
const L6_ANSWER = "L6: the client index answered the search."
const L12_ANSWER = "L12: the reply is staged for your approval."

test("L1: a user enrols and their mailbox becomes readable only to them", async ({
  page,
  env,
  world,
  qa,
}) => {
  // A real enrolment in a headless browser does not fit the 90s default.
  test.setTimeout(240_000)

  // The WHOLE corpus is seeded here, before enrolment, and L10 reuses it.
  // Invariant P is armed by the active identity row, so once this user is
  // enrolled no plaintext row can be inserted into `app_mail` at all: seeding
  // L10's 200 messages later fails with `mailbox_plaintext_forbidden`, which is
  // the database refusing correctly, not a test problem to work around.
  const mailbox = await seedPersonalMailbox(env, world.org.id, qa.admin.id, {
    messages: 200,
    tag: `l1${randomUUID().slice(0, 6)}`,
    withEmptyHtmlDraft: true,
  })
  await enableGmailProvider(env, await freshAccessToken(env.serverUrl, qa.admin.email, "12345678"))

  // Non-vacuity: the corpus exists before anything claims something about it.
  const seeded = await readMessages(env, mailbox.accountId)
  expect(seeded.length, "L1 needs a seeded corpus").toBe(200)

  await loginAs(page, env, qa.admin.email, "12345678")
  const enrolment = await enrolMailboxThroughUi(page, env)

  const identities = await readIdentities(env, qa.admin.id)
  const active = identities.filter((row) => row.status === "active")
  expect(active.length, "exactly one active identity").toBe(1)
  expect(active[0].has_ecdh).toBe(true)
  expect(active[0].has_sign).toBe(true)
  expect(active[0].has_attestation).toBe(true)
  // Migration 0041: the durable copy of the private halves is server-side
  // ciphertext, which is what makes L4 possible at all.
  expect(active[0].has_wrapped_ecdh, "0041 wrapped ecdh private").toBe(true)
  expect(active[0].has_wrapped_sign, "0041 wrapped sign private").toBe(true)

  const wraps = await readWraps(env, qa.admin.id)
  const types = wraps.map((row) => row.wrap_type).sort()
  // The mailbox password is the one wrap every enrolment carries; there is no
  // recovery phrase any more, and a headless run adds no passkey.
  expect(types, "exactly the mailbox password wrap").toEqual(["passphrase"])

  const account = await readAccount(env, mailbox.accountId)
  expect(account.encryption_state, "the mailbox may fetch mail again").toBe("ready")

  // KDF witness. "No fake was injected" is not evidence: the wrap is read back
  // from the database, and a new passphrase row must name PBKDF2-HMAC-SHA256 at
  // its full iteration count, which the unlock then reads back from the row.
  const passphraseWrap = wraps.find((row) => row.wrap_type === "passphrase")
  const kdfParams = (passphraseWrap?.kdf_params ?? {}) as { kdf?: string; iterations?: number }
  expect(kdfParams.kdf, "the passphrase wrap names its KDF").toBe("pbkdf2-sha256")
  expect(kdfParams.iterations, "PBKDF2 iteration count").toBe(600_000)
  // eslint-disable-next-line no-console
  console.log(
    `[L1] PBKDF2 passphrase step: ${enrolment.passphraseMs}ms (spec section 10 mobile target)`,
  )

  // Reload so nothing is carried in memory across the read. Setup opened the
  // mailbox with the password just chosen and that unlock lasts until logout,
  // so the reload lands on an OPEN mailbox: no prompt is expected, and the
  // scenario keeps any that appears so the assertion below can see it.
  await openMail(page, env, { landingPrompt: "keep" })
  // The QA world seeds mail of its own, so target THIS mailbox's conversation
  // by subject rather than taking whatever sorts first.
  // The NEWEST conversation: with a 200 message corpus the first-seeded one is
  // far down the list and never rendered.
  const newestIndex = mailbox.conversationIds.length - 1
  const row = page
    .getByTestId("conversation-row")
    .filter({ hasText: mailbox.subjects[newestIndex] })
  await expect(row).toBeVisible({ timeout: 60_000 })
  await row.click()
  const rendered = await readRenderedBody(page)
  expect(rendered.length, "the message rendered empty: the read path is broken").toBeGreaterThan(0)
  expect(rendered, "the rendered body is not the seeded plaintext").toContain(
    mailbox.phrases[newestIndex],
  )
  await expect(
    page.getByTestId("mailbox-unlock-host"),
    "setup ended locked: the user was asked for the password just set",
  ).toHaveCount(0)
  await expect(page.getByTestId("mailbox-locked-notice").filter({ visible: true })).toHaveCount(0)

  enrolled.accountId = mailbox.accountId
  enrolled.email = mailbox.email
  enrolled.phrases = mailbox.phrases
  enrolled.subjects = mailbox.subjects
  enrolled.conversationIds = mailbox.conversationIds
})

test("L2: inbound mail seals with nobody watching", async ({ page, browser, env, world, qa }) => {
  test.setTimeout(300_000)
  expect(enrolled.accountId, "L2 runs on L1's enrolled mailbox").not.toBe("")

  // 1. The browser is CLOSED. Nothing in the page can be part of the seal.
  await page.context().close()

  const before = await readMessages(env, enrolled.accountId)
  const tag = `l2${randomUUID().slice(0, 6)}`
  const fixtures = ingestFixtures(tag, 2, enrolled.email)

  // 2. The REAL ingest: real sandbox, real bridge, real `mailbox_sealAndInsert`,
  // real recipient resolution, real trigger. The actor is `system:mail:sync`,
  // which is the actor production uses and the one the original bug refused.
  const ingest = await runIngest(env, {
    orgId: world.org.id,
    accountId: enrolled.accountId,
    actor: "system:mail:sync",
    messages: fixtures,
  })
  expect(ingest.exitCode, `ingest harness failed:\n${ingest.stderr}`).toBe(0)
  expect(ingest.result?.error, "the ingest threw").toBeNull()

  const after = await readMessages(env, enrolled.accountId)
  // Non-vacuity FIRST.
  expect(after.length - before.length, "the ingest wrote exactly two rows").toBe(2)

  const fresh = after.filter((row) => !before.some((old) => old.id === row.id))
  for (const row of fresh) {
    expect(row.enc_version, "sealed rows carry enc_version 1").toBe(1)
    expect(row.text_body_ciphertext).not.toBeNull()
    expect(row.subject_ciphertext).not.toBeNull()
    expect(row.content_key_wrapped).not.toBeNull()
    expect(row.content_key_epk).not.toBeNull()
    expect(row.subject, "no plaintext subject").toBeNull()
    expect(row.text_body, "no plaintext body").toBeNull()
    expect(row.html_body, "no plaintext html").toBeNull()
    expect(row.snippet, "no plaintext snippet").toBeNull()
  }

  // The header allowlist, driven from the SHIPPED constant so the test cannot
  // drift from the product.
  const { MAIL_HEADER_ALLOWLIST } = (await import(
    "../../../../api/src/modules/mailbox-crypto/header-allowlist"
  )) as { MAIL_HEADER_ALLOWLIST: readonly string[] }
  expect(MAIL_HEADER_ALLOWLIST.length).toBeGreaterThan(0)
  for (const row of fresh) {
    const kept = Object.keys(row.raw_headers ?? {})
    for (const key of kept) {
      expect(
        MAIL_HEADER_ALLOWLIST.includes(key.toLowerCase()),
        `raw_headers kept a non-allowlisted key: ${key}`,
      ).toBe(true)
    }
    expect(JSON.stringify(row.raw_headers ?? {})).not.toContain("zephyrine")
  }

  // The account is still usable: sealing did not block it.
  const account = await readAccount(env, enrolled.accountId)
  expect(account.encryption_state, "a RECIPIENT_MISMATCH would have blocked it").toBe("ready")

  // 3. A fresh context wakes up, unlocks, and reads what arrived.
  const context = await browser.newContext()
  const page2 = await context.newPage()
  try {
    await loginAs(page2, env, qa.admin.email, "12345678")
    await openMail(page2, env)
    // A locked mailbox lists no sealed rows: the unlock panel stands in for
    // them, so the unlock comes first and the row is opened after it.
    await expect(
      page2.getByTestId("mailbox-locked-notice").filter({ visible: true }).first(),
    ).toBeVisible({
      timeout: 60_000,
    })
    await openMailboxUnlock(page2)
    await unlockMailboxThroughUi(page2, "passphrase", TEST_PASSPHRASE)
    await expect(page2.getByTestId("mailbox-unlock-host")).toBeHidden({ timeout: 120_000 })
    // A sealed conversation shows no subject until it is unlocked, so the row
    // is located by its stable id, not by text.
    await openConversationById(page2, fresh[0].conversation_id)
    // Polled: the unlock also reopens the sealed list rows in the worker, so
    // the message decrypt can land a moment after the modal closes.
    await expect
      .poll(async () => readRenderedBody(page2), {
        timeout: 60_000,
        message: "the sealed body did not come back byte for byte",
      })
      .toContain(`zephyrine-${tag}-inbound-0-quillmark`)
    enrolled.sealedConversationId = fresh[0].conversation_id
    enrolled.sealedMessageId = fresh[0].id
    enrolled.sealedPhrase = `zephyrine-${tag}-inbound-0-quillmark`
    enrolled.sealedSubject = `zephyrine ${tag} inbound subject 0`
  } finally {
    await context.close()
  }
})

test("L4: a fresh browser profile unlocks with the mailbox password alone", async ({
  browser,
  env,
  qa,
}) => {
  test.setTimeout(300_000)
  expect(enrolled.sealedConversationId, "L4 needs L1's sealed conversation").not.toBe("")

  const context = await browser.newContext()
  const page = await context.newPage()
  const keyringFetches: Array<{ url: string; body: string }> = []
  page.on("response", (response) => {
    if (response.url().includes("/api/mailbox-keys/me")) {
      void response
        .text()
        .then((body) => keyringFetches.push({ url: response.url(), body }))
        .catch(() => {})
    }
  })
  try {
    await loginAs(page, env, qa.admin.email, "12345678")
    await openMail(page, env, { landingPrompt: "keep" })
    // A SEALED conversation, so the unlock is load-bearing: this device holds
    // no key material at all. The mail home asks to unlock on its own once it
    // has read the keyring; that prompt is the unlock this device needs. Only
    // when it has not come is the locked notice's Unlock pressed (pressing it
    // under the open prompt clicks the prompt's backdrop).
    const unlockHost = page.getByTestId("mailbox-unlock-host")
    const prompted = await unlockHost
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => true)
      .catch(() => false)
    if (!prompted) {
      await openMailboxUnlock(page)
    }
    await unlockMailboxThroughUi(page, "passphrase", TEST_PASSPHRASE)
    await expect(page.getByTestId("mailbox-unlock-host")).toBeHidden({ timeout: 120_000 })
    // Sealed rows are listed only once unlocked, so the row is opened after.
    await openConversationById(page, enrolled.sealedConversationId)

    await expect
      .poll(async () => readRenderedBody(page), {
        timeout: 60_000,
        message: "the mailbox password did not rebuild a working keyring",
      })
      .toContain(enrolled.sealedPhrase)

    // The mechanism, not just the outcome: the durable copy of the private
    // halves is SERVER-side ciphertext (migration 0041). A test that only
    // checked "it unlocked" would pass again on a local-only keyring.
    expect(
      keyringFetches.length,
      "the page never fetched GET /api/mailbox-keys/me",
    ).toBeGreaterThan(0)
    const withPrivates = keyringFetches.filter((r) => r.body.includes("wrappedEcdhPrivate"))
    expect(
      withPrivates.length,
      "the keyring response carried no wrapped private halves",
    ).toBeGreaterThan(0)
  } finally {
    await context.close()
  }

  // A WRONG password refuses, and says nothing about how close it was.
  const bad = await browser.newContext()
  const badPage = await bad.newPage()
  try {
    await loginAs(badPage, env, qa.admin.email, "12345678")
    await openMail(badPage, env)
    // A locked mailbox lists no sealed rows: the unlock panel stands in for them.
    await openMailboxUnlock(badPage)
    await unlockMailboxThroughUi(badPage, "passphrase", "not the mailbox password at all 0")
    const refusal = badPage.getByTestId("mailbox-unlock.refusal")
    await expect(refusal).toBeVisible({ timeout: 60_000 })
    const text = await refusal.innerText()
    expect(text.toLowerCase()).not.toMatch(/close|almost|word \d/)
  } finally {
    await bad.close()
  }
})

/**
 * The two-phase agent read, end to end (SC9).
 *
 * This is the scenario the plan calls the regression for integration bug 5, the
 * agent protocol with no browser half. It is written so that a build where the
 * browser half is absent CANNOT pass: the load-bearing assertion is that the
 * page issued `POST /api/agent/mailbox-plaintext/<requestId>` during the turn
 * and the server answered it 200. An assertion that only read the model's reply
 * would pass on a locked path that politely says "the mailbox is locked".
 *
 * REAL: the whole chain. The mail surface, the crypto worker, the socket
 * assertion, the turn nonce, the server broker, the responder, the REST
 * fulfilment route, the ephemeral context injection, the model.
 * FAKED: nothing, except that the model is Gemini Flash-Lite (the e2e
 * convention; never an Anthropic model) and the prompt is bounded-retried,
 * because a language model is not deterministic.
 */
test("L5: the user's own agent can read; a headless turn cannot", async ({
  page,
  env,
  world,
  qa,
}) => {
  // Two model turns plus an unlock, over a real provider.
  test.setTimeout(900_000)
  expect(enrolled.sealedConversationId, "L5 runs on the mailbox L2 sealed into").not.toBe("")

  await seedModelPricingAndCredits(env, world.org.id)
  const token = await freshAccessToken(env.serverUrl, qa.admin.email, "12345678")

  const plaintextCalls: Array<{ url: string; status: number }> = []
  page.on("response", (r) => {
    if (r.url().includes("/api/agent/mailbox-plaintext/"))
      plaintextCalls.push({ url: r.url(), status: r.status() })
  })
  // Wiring #1 of the three the protocol needs: the unlock assertion on the
  // socket. Under `vite preview` the app's socket cannot reach the API through
  // the preview proxy at all, so the lane routes it to the API host and records
  // what the app sends. See `routeWebSocketToApi` for the measurement.
  await routeWebSocketToApi(page, env)
  const consoleErrors: string[] = []
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200))
  })
  page.on("pageerror", (e) => consoleErrors.push(`pageerror ${e.message.slice(0, 300)}`))

  // THE TURN, scripted on the server. `mail__read` is deferred like every app
  // tool, so the script loads it first with one `tool_search select:` step
  // (`loadToolStep`, same as the headless half below): this scenario is
  // measuring the READ PROTOCOL, not tool discovery.
  //
  // The closing step ECHOES the sealed phrase out of the prompt. It cannot be
  // asserted any other way: the broker injects the decrypted body as an
  // ephemeral context block precisely so it never reaches
  // `kernel.messages.metadata` (Invariant K, asserted at the end of this test),
  // so the prompt is the only place it is observable. A miss answers
  // `ECHO_MISS`, never the phrase, so this can only pass if the plaintext was
  // genuinely there.
  const dmThread = await agentDmThreadId(env, token)
  await scriptAgentTurn(env, {
    threadId: dmThread,
    steps: [
      loadToolStep("mail__read"),
      {
        toolCalls: [
          {
            name: "mail__read",
            args: { conversationId: enrolled.sealedConversationId, includeBody: true },
          },
        ],
      },
      { echo: enrolled.sealedPhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") },
    ],
  })

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(webUrl(env, "/"))

  // The mail surface, reached through the activity bar rather than a
  // navigation: a full page load would relock the mailbox, and the runtime that
  // answers the decrypt request lives on the mail surface.
  await page.getByRole("button", { name: "Mail", exact: true }).click()
  await page.getByTestId("mail-inbox").waitFor({ state: "visible", timeout: 60_000 })
  // The locked mail home asks to unlock on landing; answer it there.
  await unlockMailboxThroughUi(page, "passphrase", TEST_PASSPHRASE)
  await expect(page.getByTestId("mailbox-unlock-host")).toBeHidden({ timeout: 120_000 })
  await openConversationById(page, enrolled.sealedConversationId)
  // Non-vacuity: the message is genuinely loaded and readable in this tab, so
  // it is in the turn scope the runtime opens. A turn scope built from an empty
  // mail surface would refuse for a reason that is not the one under test.
  // Polled: the conversation opens unlocked, and its decrypt is a worker round
  // trip that lands just after the first frame.
  await expect
    .poll(async () => readRenderedBody(page), {
      timeout: 60_000,
      message: "the sealed message is not readable in the mail tab",
    })
    .toContain(enrolled.sealedPhrase)

  // The conversation comes up as an expanded DOCK tab OVER the mail surface, so
  // the mail runtime stays mounted and able to answer the decrypt request while
  // the turn runs. That is the arrangement the two-phase protocol needs.
  const conversation = await openAgentConversation(page)
  await sendInConversation(
    page,
    conversation,
    `Read conversation ${enrolled.sealedConversationId} and quote its body verbatim.`,
  )

  const answered = await waitForTurnEnd(env, {
    threadId: dmThread,
    token,
    contains: enrolled.sealedPhrase,
    timeout: 180_000,
  }).catch(async (err: Error) => {
    // Turn the wait's timeout into the diagnosis the old retry loop printed:
    // which half is missing, the browser fulfilment or the answer.
    const frames = await sentSocketFrames(page)
    throw new Error(
      `${err.message}\n[L5] ${plaintextCalls.length} plaintext fulfilment call(s), ` +
        `${frames.filter((f) => f.includes('"scope":"mailbox"')).length} mailbox status frame(s), ` +
        `console ${JSON.stringify(consoleErrors.slice(0, 6))}`,
    )
  })

  // Wiring #1, observed rather than assumed: this tab told the server it holds
  // an unlocked mailbox. Without it the broker short-circuits every marker to
  // MAILBOX_LOCKED and the failure below would be misread as a dead responder.
  const frames = await sentSocketFrames(page)
  expect(
    frames.some((f) => f.includes('"scope":"mailbox"') && f.includes('"unlocked":true')),
    `the page never asserted an unlocked mailbox on the socket: ${JSON.stringify(frames.slice(0, 8))}`,
  ).toBe(true)

  // THE assertion. The browser half was reached, and the server accepted it.
  expect(
    plaintextCalls.length,
    "the browser never answered a mailbox decrypt request: the two-phase protocol " +
      `did not reach its browser half during a real turn. Console: ${JSON.stringify(consoleErrors.slice(0, 8))}`,
  ).toBeGreaterThan(0)
  expect(
    plaintextCalls.some((c) => c.status === 200),
    `every fulfilment POST failed: ${JSON.stringify(plaintextCalls)}`,
  ).toBe(true)
  // And the round trip actually produced plaintext FOR THE MODEL to use: the
  // echo step answered out of its own prompt, so this is the decrypted body
  // arriving in the model's context, not a line the script wrote.
  expect(answered, "the answer does not carry the decrypted body").toContain(enrolled.sealedPhrase)
  expect(answered, "the echo step missed: no plaintext was in the prompt").not.toContain(ECHO_MISS)

  // The ask the HEADLESS half replays, in the same words a person would use.
  const ask =
    `Call the mail read tool with conversationId ${enrolled.sealedConversationId}. ` +
    "Then reply with the exact body text of the message it returns, copied verbatim and nothing else."

  // ── The headless half ─────────────────────────────────────────────────────
  // The same tool, the same message, in a turn no browser started: no turn
  // nonce, so the broker refuses to ask even though an unlocked session is live
  // in the page right now. That live session is the point: this proves the
  // nonce gate, not merely the absence of a socket.
  const headlessThread = await createThread(env, token, "Headless mail read", qa.admin.id)
  // Scripted like the browser turn: load the tool, call it, then a closing
  // line. Only the model is scripted; the call and the broker's refusal are real.
  await scriptAgentTurn(env, {
    threadId: headlessThread,
    steps: [
      loadToolStep("mail__read"),
      {
        toolCalls: [
          {
            name: "mail__read",
            args: { conversationId: enrolled.sealedConversationId, includeBody: true },
          },
        ],
      },
      { text: "L5: headless read done." },
    ],
  })
  let stream = ""
  for (let attempt = 0; attempt < 3 && !stream.includes("MAILBOX_LOCKED"); attempt++) {
    const res = await fetch(`${env.serverUrl}/api/agent/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ threadId: headlessThread, content: ask }),
    })
    expect(res.status, "the headless turn was not accepted").toBe(200)
    stream = await res.text()
  }
  expect(
    stream.includes("MAILBOX_LOCKED"),
    `the headless turn did not report a locked mailbox:\n${stream.slice(0, 4000)}`,
  ).toBe(true)
  expect(stream, "a turn with no browser session was handed plaintext").not.toContain(
    enrolled.sealedPhrase,
  )

  // Invariant K over the control plane, after both turns. Non-vacuity first:
  // the turns really did write kernel messages.
  const [msgCount] = await queryRows(
    env,
    `SELECT count(*)::int AS n FROM ${ks(env)}.messages WHERE thread_id = ANY($1::uuid[])`,
    [[dmThread, headlessThread]],
  )
  expect(Number(msgCount.n), "the turns wrote no kernel messages at all").toBeGreaterThan(0)
  // The tool result NEVER carries plaintext: the broker injects it as an
  // ephemeral context block, so `extractToolCalls` cannot reach it and it
  // cannot land in `kernel.messages.metadata`. That is the property the
  // broker's own header claims and nothing else here proves it.
  //
  // One key is judged separately: `timeline`, which since the turn's text is
  // drawn between its tools carries each text run the agent wrote, i.e. a copy
  // of the visible reply (the disclosure the user asked for, see the audit
  // note below). Everything else in the metadata must be free of the phrase,
  // and a timeline text run may carry it only on a row whose own content, the
  // reply the user sees, carries it too.
  const metaRows = await queryRows(
    env,
    `SELECT id, author_type,
            substring((metadata - 'timeline')::text
                      FROM greatest(position($1 IN (metadata - 'timeline')::text) - 300, 1) FOR 500) AS around
       FROM ${ks(env)}.messages
      WHERE coalesce((metadata - 'timeline')::text, '') LIKE '%' || $1 || '%'`,
    [enrolled.sealedPhrase],
  )
  expect(
    metaRows.length,
    `mail plaintext reached kernel.messages.metadata: ${JSON.stringify(metaRows)}`,
  ).toBe(0)
  const timelineRows = await queryRows(
    env,
    `SELECT id, author_type, left(coalesce(content, ''), 200) AS content
       FROM ${ks(env)}.messages
      WHERE coalesce(metadata->>'timeline', '') LIKE '%' || $1 || '%'
        AND coalesce(content, '') NOT LIKE '%' || $1 || '%'`,
    [enrolled.sealedPhrase],
  )
  expect(
    timelineRows.length,
    `mail plaintext reached a metadata timeline that is not the visible reply: ${JSON.stringify(timelineRows)}`,
  ).toBe(0)

  const [titleRow] = await queryRows(
    env,
    `SELECT count(*)::int AS n FROM ${ks(env)}.threads WHERE coalesce(title, '') LIKE '%' || $1 || '%'`,
    [enrolled.sealedPhrase],
  )
  expect(Number(titleRow.n), "mail plaintext reached kernel.threads.title").toBe(0)

  // The audit log and the outbox are NOT asserted at zero, and the reason is
  // not a weakened assertion.
  //
  // The user asked the assistant, in so many words, to print the body into the
  // chat. That answer is an ordinary thread message: the disclosure the user
  // themselves asked for. Every message is audited with a preview and
  // broadcast through the outbox, so demanding zero would be demanding that
  // the assistant may not answer. What Invariant K forbids is mail content
  // reaching the control plane through a path the user did not drive, so the
  // assertion is that EVERY row carrying the phrase is that one visible reply.
  const auditRows = await queryRows(
    env,
    `SELECT app, entity_type, action, left(changes::text, 200) AS changes
       FROM ${ks(env)}.audit_log WHERE coalesce(changes::text, '') LIKE '%' || $1 || '%'`,
    [enrolled.sealedPhrase],
  )
  const outboxRows = await queryRows(
    env,
    `SELECT payload->>'app' AS app, payload->>'entity' AS entity_type,
            payload->>'action' AS action, left(payload::text, 200) AS changes
       FROM ${ks(env)}.pending_events WHERE coalesce(payload::text, '') LIKE '%' || $1 || '%'`,
    [enrolled.sealedPhrase],
  )
  for (const row of [...outboxRows]) {
    expect(
      `${row.app}/${row.entity_type}`,
      `mail plaintext reached the outbox through a path the user did not drive: ${JSON.stringify(row)}`,
    ).toBe("kernel/message")
  }
  for (const audit of auditRows) {
    expect(
      `${audit.app}/${audit.entity_type}/${audit.action}`,
      `mail plaintext reached the audit log through a path the user did not drive: ${JSON.stringify(audit)}`,
    ).toBe("kernel/message/message.create")
  }
})

test("L9: the purge refuses, four ways, and changes nothing", async ({ env, world, qa }) => {
  test.setTimeout(300_000)
  expect(enrolled.accountId, "L9 runs on L1's enrolled mailbox").not.toBe("")

  // Non-vacuity FIRST: without a corpus whose plaintext is still present, the
  // before/after comparison below is trivially satisfied.
  const before = await countRemainingPlaintext(env, enrolled.accountId)
  expect(before.messages, "L9 needs messages that still carry plaintext").toBeGreaterThan(0)

  const token = await freshAccessToken(env.serverUrl, qa.admin.email, "12345678")
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${env.serverUrl}/api${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.text() }
  }

  const nonceRes = await post("/mailbox/verify-nonce", {})
  expect(nonceRes.status, "issuing a nonce is the only thing that should work here").toBe(200)
  const issued = JSON.parse(nonceRes.body).data as { nonce: string }
  expect(issued.nonce.length).toBeGreaterThan(0)

  const base = {
    accountId: enrolled.accountId,
    keyId: 1,
    count: before.messages,
    idSetDigest: Buffer.from(new Uint8Array(32)).toString("base64"),
    signature: Buffer.from(new Uint8Array(64)).toString("base64"),
    backfillCursor: "",
  }

  // (i) no signature at all, (ii) a stale nonce, (iii) a reused nonce,
  // (iv) a digest that cannot cover the current rows.
  const attempts: Array<[string, Record<string, unknown>]> = [
    ["no signature", { ...base, nonce: issued.nonce, signature: "" }],
    ["stale nonce", { ...base, nonce: "stale-nonce-that-was-never-issued" }],
    ["reused nonce", { ...base, nonce: issued.nonce }],
    ["short digest", { ...base, nonce: issued.nonce, count: Math.max(0, before.messages - 1) }],
  ]
  for (const [name, payload] of attempts) {
    const res = await post("/mailbox/verify-decrypt", payload)
    expect(res.status, `${name} was accepted: ${res.body}`).toBeGreaterThanOrEqual(400)
    expect(res.status, `${name} returned a server error, not a refusal`).toBeLessThan(500)
    // The witness is the remaining-plaintext count, never `plaintext_purged_at`
    // (plan section 2.5: that column is stamped only on a complete cutover, so
    // it reads NULL after a purge that destroyed everything).
    const after = await countRemainingPlaintext(env, enrolled.accountId)
    expect(after, `${name} changed the corpus`).toEqual(before)
  }

  // The real operator command, with the real gate in front of it.
  const purge = await runPurgeCli(env, [
    "--user",
    qa.admin.id,
    "--org",
    world.org.id,
    "--execute",
    "--confirm",
    qa.admin.id,
  ])
  expect(purge.exitCode, `the purge did not refuse:\n${purge.stdout}\n${purge.stderr}`).toBe(1)
  // eslint-disable-next-line no-console
  console.log("[L9] purge refusal output:", `${purge.stdout}\n${purge.stderr}`.slice(0, 1200))
  expect(
    `${purge.stdout}${purge.stderr}`.toLowerCase(),
    "the refusal did not name the missing acknowledgement",
  ).toMatch(/acknowledg|ack/)
  const afterPurge = await countRemainingPlaintext(env, enrolled.accountId)
  expect(afterPurge, "the refused purge destroyed plaintext").toEqual(before)
})

test("L10: the client sweep, then the purge, over a real local corpus", async ({
  page,
  env,
  world,
  qa,
}) => {
  // A 200 message backfill, a full browser sweep and a purge do not fit 90s.
  test.setTimeout(900_000)

  // A SECOND user, with a legacy-only corpus. It is not the admin's mailbox
  // because that one received mail after enrolment, and L10b records why that
  // makes the sweep impossible today. Everything below is the migration a real
  // mailbox goes through: seed, enrol, backfill, sweep, purge, read back.
  const tag = `l10${randomUUID().slice(0, 6)}`
  // 260, not 200: `BACKFILL_BATCH_SIZE` is 200, so a 200 message mailbox is
  // sealed by ONE batch and the interrupt-and-resume leg below would prove
  // nothing.
  const mailbox = await seedPersonalMailbox(env, world.org.id, qa.amina.id, {
    messages: 260,
    tag,
    withEmptyHtmlDraft: true,
  })
  const corpus = await readMessages(env, mailbox.accountId)
  expect(corpus.length, "L10 needs at least 200 messages").toBeGreaterThanOrEqual(200)
  expect(
    corpus.every((row) => (row.enc_version ?? 0) === 0),
    "the corpus must start as legacy plaintext",
  ).toBe(true)

  await enableGmailProvider(env, await freshAccessToken(env.serverUrl, qa.admin.email, "12345678"))
  // `mail:accounts:write`, granted explicitly and NOT as a convenience: see
  // FINDING D3. `enrollKeyring` advances `encryption_state` through the
  // enrolling user's own RLS transaction, and the QA users carry only
  // `mail:accounts:read`, so the UPDATE matches no row and is SILENTLY skipped:
  // the identity is created (the mailbox is armed) while the account stays at
  // `pending_enrollment` (sync suspended forever) and the API answers 200.
  // Granting the scope here isolates L10 to the purge mechanism; the enrolment
  // bug is reported separately rather than hidden.
  await grantScopes(env, world.org.id, qa.amina.id, ["mail:accounts:write"])
  await loginAs(page, env, qa.amina.email, "QaPass1!")
  await enrolMailboxThroughUi(page, env)
  // eslint-disable-next-line no-console
  console.log(
    "[L10] after enrolment:",
    JSON.stringify(await readIdentities(env, qa.amina.id)),
    JSON.stringify(await readWraps(env, qa.amina.id)),
    JSON.stringify((await readAccount(env, mailbox.accountId)).encryption_state),
  )
  expect((await readAccount(env, mailbox.accountId)).encryption_state).toBe("ready")

  // ── 1. The real backfill job, interrupted once and resumed ────────────────
  const partial = await runBackfill(env, {
    orgId: world.org.id,
    userId: qa.amina.id,
    maxBatches: 1,
  })
  expect(partial.exitCode, `backfill failed:\n${partial.stderr}`).toBe(0)
  expect(partial.result?.completed, "one batch cannot finish a 200 message mailbox").toBe(false)
  const sealedAfterPartial = (await readMessages(env, mailbox.accountId)).filter(
    (row) => (row.enc_version ?? 0) > 0,
  ).length
  expect(sealedAfterPartial, "the interrupted backfill sealed nothing").toBeGreaterThan(0)
  expect(sealedAfterPartial, "one batch sealed the whole mailbox").toBeLessThan(corpus.length)

  const full = await runBackfill(env, { orgId: world.org.id, userId: qa.amina.id })
  expect(full.exitCode, `backfill failed:\n${full.stderr}`).toBe(0)
  expect(full.result?.completed, "the resumed backfill did not finish").toBe(true)
  const sealedRows = (await readMessages(env, mailbox.accountId)).filter(
    (row) => (row.enc_version ?? 0) > 0,
  )
  expect(sealedRows.length, "every message must be sealed after the backfill").toBe(corpus.length)

  // Idempotence: a second run stays complete and seals nothing new.
  const again = await runBackfill(env, { orgId: world.org.id, userId: qa.amina.id })
  expect(again.result?.completed).toBe(true)
  expect(
    (await readMessages(env, mailbox.accountId)).filter((row) => (row.enc_version ?? 0) > 0).length,
  ).toBe(corpus.length)

  // ── 2. The dual-read window must be OPEN before the sweep starts ──────────
  const token = await freshAccessToken(env.serverUrl, qa.amina.email, "QaPass1!")
  const verifyPage = await fetch(`${env.serverUrl}/api/mailbox/sync-cursor?mode=verify&limit=50`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(verifyPage.status).toBe(200)
  const verifyBody = (await verifyPage.json()) as {
    data: { items: Array<{ plaintext: { textBody: string | null } | null }> }
  }
  expect(verifyBody.data.items.length, "verify mode returned nothing").toBeGreaterThan(0)
  expect(
    verifyBody.data.items.every((item) => item.plaintext?.textBody != null),
    "the dual-read window is closed: the sweep would compare nothing",
  ).toBe(true)

  // ── 3. The sweep, through the real UI ─────────────────────────────────────
  const statuses: Array<{ url: string; status: number }> = []
  page.on("response", (r) => {
    if (/\/mailbox\/(sync-cursor|verify-nonce|verify-decrypt)/.test(r.url()))
      statuses.push({ url: r.url(), status: r.status() })
  })
  // Setup opened the mailbox and the unlock lasts until logout, so the sealed
  // conversation reads with no prompt: asking again here would be the setup
  // defect this lane now pins.
  await openMail(page, env, { landingPrompt: "keep" })
  await openConversationById(page, mailbox.conversationIds[mailbox.conversationIds.length - 1])
  await expect
    .poll(async () => readRenderedBody(page), {
      timeout: 60_000,
      message: "the mailbox opened at setup did not read the sealed conversation",
    })
    .toContain(mailbox.phrases[mailbox.conversationIds.length - 1])
  await expect(page.getByTestId("mailbox-unlock-host")).toHaveCount(0)

  // In-app navigation: the sweep runs in this page's open session.
  await openMailAccountSettings(page, env, { reload: false })
  const row = page.getByTestId("mail-account-row").filter({ hasText: mailbox.email })
  await row.getByTestId("mail-account-security").click()
  await expect(page.getByTestId("mailbox-verification-panel")).toBeVisible({ timeout: 60_000 })
  await page.getByTestId("mailbox-verify.start").click()
  const result = page.getByTestId("mailbox-verify.result")
  const refused = page.getByTestId("mailbox-verify.refused")
  await expect(result.or(refused)).toBeVisible({ timeout: 600_000 })
  const refusalText = (await refused.count()) > 0 ? await refused.innerText() : ""
  if (refusalText) {
    for (const id of refusalText.match(/[0-9a-f-]{36}/g) ?? []) {
      const [bad] = await queryRows(
        env,
        `SELECT id::text, enc_version, subject, left(text_body, 60) AS text_body,
                left(html_body, 80) AS html_body, left(snippet, 60) AS snippet
           FROM ${ms(env)}.messages WHERE id = $1`,
        [id],
      )
      // eslint-disable-next-line no-console
      console.log("[L10] mismatching row:", JSON.stringify(bad))
    }
  }
  expect(refusalText, `the sweep refused: ${refusalText}`).toBe("")

  // ── 4. What the sweep did on the wire, by status code ─────────────────────
  expect(
    statuses.some((s) => s.url.includes("mode=verify") && s.status === 200),
    "the sweep did not list in verify mode",
  ).toBe(true)
  expect(
    statuses.some((s) => s.url.includes("/verify-nonce") && s.status === 200),
    "no nonce was issued at a 2xx",
  ).toBe(true)
  expect(
    statuses.some((s) => s.url.includes("/verify-decrypt") && s.status === 200),
    "the acknowledgement was never accepted",
  ).toBe(true)

  // ── 5. The ledger says the whole mailbox was covered ──────────────────────
  const ledger = await readMigrationState(env, qa.amina.id)
  expect(ledger?.client_verified_at, "the acknowledgement was not recorded").toBeTruthy()
  // Every PERSONAL message of this user, across every personal account: the
  // acknowledgement covers the mailbox, not one account, and the QA world seeds
  // a second personal account of its own.
  const [personal] = await queryRows(
    env,
    `SELECT count(*)::int AS n FROM ${ms(env)}.messages m
       JOIN ${ms(env)}.accounts a ON a.id = m.account_id
      WHERE a.owner_type = 'user' AND a.owner_id = $1`,
    [qa.amina.id],
  )
  expect(Number(personal.n), "non-vacuity: the mailbox is empty").toBeGreaterThanOrEqual(260)
  expect(Number(ledger?.client_ack_count), "the ack did not cover every message").toBe(
    Number(personal.n),
  )

  // ── 6. Pre-cutover control-plane residue, so purge step 7d is exercised ───
  const residue = await seedControlPlaneResidue(env, world.org.id, qa.amina.id, tag)
  for (const [where, count] of Object.entries(residue.before)) {
    expect(count, `residue was never seeded into ${where}`).toBeGreaterThan(0)
  }

  // ── 7. The purge, through the real operator command ───────────────────────
  const beforePurge = await countRemainingPlaintext(env, mailbox.accountId)
  expect(beforePurge.messages, "nothing to purge").toBeGreaterThan(0)
  const purge = await runPurgeCli(env, [
    "--user",
    qa.amina.id,
    "--org",
    world.org.id,
    "--execute",
    "--confirm",
    qa.amina.id,
  ])
  if (purge.exitCode !== 0) {
    // eslint-disable-next-line no-console
    console.log(
      "[L10] raw_headers shapes:",
      JSON.stringify(
        await queryRows(
          env,
          `SELECT jsonb_typeof(m.raw_headers) AS t, count(*)::int AS n
             FROM ${ms(env)}.messages m
             JOIN ${ms(env)}.accounts a ON a.id = m.account_id
            WHERE a.owner_type = 'user' AND a.owner_id = $1
            GROUP BY 1`,
          [qa.amina.id],
        ),
      ),
    )
  }
  expect(purge.exitCode, `the purge failed:\n${purge.stdout}\n${purge.stderr}`).toBe(0)

  const afterPurge = await countRemainingPlaintext(env, mailbox.accountId)
  expect(afterPurge.messages, "message plaintext survived the purge").toBe(0)
  expect(afterPurge.conversations, "conversation plaintext survived the purge").toBe(0)
  expect(afterPurge.drafts, "draft plaintext survived the purge").toBe(0)

  // The ledger witness that a destructive purge ran (migration 0042): stamped
  // on BOTH branches, unlike `plaintext_purged_at`.
  const afterLedger = await readMigrationState(env, qa.amina.id)
  expect(afterLedger?.plaintext_purge_ran_at, "the 0042 witness was not stamped").toBeTruthy()

  // Residue: step 6's non-vacuity is what makes these zeros mean something.
  const residueAfter = await residue.recount()
  for (const [where, count] of Object.entries(residueAfter)) {
    expect(count, `control-plane residue survived in ${where}`).toBe(0)
  }

  // ── 8. Post-purge readability, after a full reload ────────────────────────
  // A full navigation plus a fresh sign-in: the access token lives in memory,
  // so a bare reload lands on the login screen. This is the "nothing carried
  // over" property the post-purge read needs. There was no logout, and an
  // unlock lasts until logout, so the mailbox re-opens from this device's
  // persisted session with no prompt: the read below is the real decrypt of
  // ciphertext, the plaintext being gone.
  await loginAs(page, env, qa.amina.email, "QaPass1!")
  await openMail(page, env, { landingPrompt: "keep" })
  await openConversationById(page, mailbox.conversationIds[mailbox.conversationIds.length - 1])
  // Polled: the decrypt is a worker round trip that lands after the first
  // frame, so a single read can catch the pre-hydration frame.
  await expect
    .poll(async () => readRenderedBody(page), {
      timeout: 120_000,
      message: "a backfilled message is unreadable AFTER its plaintext was destroyed",
    })
    .toContain(mailbox.phrases[mailbox.conversationIds.length - 1])

  // The draft whose html_body was the empty string kept its text through the
  // round trip (review finding 23), and its plaintext is now gone.
  const draft = (
    await queryRows(
      env,
      `SELECT body_ciphertext IS NOT NULL AS sealed, text_body FROM ${ms(env)}.drafts WHERE account_id = $1`,
      [mailbox.accountId],
    )
  )[0]
  expect(draft?.sealed, "the draft was never sealed").toBe(true)
  expect(draft?.text_body, "the draft plaintext was not purged").toBeNull()

  purged.userId = qa.amina.id
  purged.accountId = mailbox.accountId
  purged.phrases = mailbox.phrases
  purged.subjects = mailbox.subjects
})

test("L10b: a mailbox that received mail AFTER enrolment can still be swept", async ({
  page,
  env,
  world,
  qa,
}) => {
  // WRITTEN RED. the admin's mailbox holds rows sealed at ingest (L2), which
  // never had plaintext. `sync-cursor?mode=verify` attaches a `plaintext`
  // object to EVERY row regardless, with all four fields null, and the sweep
  // compares "" against the decrypted subject and calls it a content mismatch.
  // Every enrolled mailbox receives mail, so on the shipped code no live
  // mailbox can ever complete the sweep, and the purge can never be armed.
  test.setTimeout(600_000)
  expect(enrolled.accountId, "L10b runs on L1's enrolled mailbox").not.toBe("")

  // Seal the legacy half first, so the only rows that can fail the sweep are
  // the ones the ingest sealed. Without this the refusal names every unsealed
  // row too and the finding is not isolated.
  const backfill = await runBackfill(env, { orgId: world.org.id, userId: qa.admin.id })
  expect(backfill.exitCode, `backfill failed:\n${backfill.stderr}`).toBe(0)
  expect(backfill.result?.completed, "the backfill did not finish").toBe(true)

  await loginAs(page, env, qa.admin.email, "12345678")
  await openMail(page, env)
  await openMailboxUnlock(page)
  await unlockMailboxThroughUi(page, "passphrase", TEST_PASSPHRASE)
  await expect(page.getByTestId("mailbox-unlock-host")).toBeHidden({ timeout: 120_000 })
  // Sealed rows are listed only once unlocked, so the row is opened after.
  await openConversationById(page, enrolled.sealedConversationId)

  await openMailAccountSettings(page, env, { reload: false })
  const row = page.getByTestId("mail-account-row").filter({ hasText: enrolled.email })
  await row.getByTestId("mail-account-security").click()
  await page.getByTestId("mailbox-verify.start").click()
  const result = page.getByTestId("mailbox-verify.result")
  const refused = page.getByTestId("mailbox-verify.refused")
  await expect(result.or(refused)).toBeVisible({ timeout: 600_000 })
  const refusalText = (await refused.count()) > 0 ? await refused.innerText() : ""
  expect(
    refusalText,
    "the sweep refused a mailbox whose only fault is that mail arrived after enrolment",
  ).toBe("")
})

/**
 * The privileged-reader sweep (SC1, SC2, SC4, SC5, SC13 locally).
 *
 * It runs over the mailbox L10 sealed and purged, because that is the state
 * the criteria describe: a mailbox mid-migration still holds legacy plaintext
 * on purpose, and sweeping one would be measuring the wrong thing.
 *
 * NON-VACUITY IS THE WHOLE DESIGN HERE. Every assertion below is of the form
 * "no plaintext was found", which an empty corpus, a wrong database or a
 * missing index satisfies perfectly. So each leg carries a positive control
 * that must FIND something: a minimum corpus size, a SHARED org mailbox whose
 * plaintext is still there and still searchable and still exported, and a
 * positive count of ciphertext columns in the artifact.
 *
 * The evaluation is not restated here: it imports the very verdict functions
 * the prod assertion tool runs (`scripts/lib/mailbox-at-rest-verdicts.ts`), so
 * the local rehearsal and the prod check cannot drift apart.
 *
 * REAL: the privileged (superuser, RLS-bypassing) connection, the real
 * `liaison export --full`, the real `liaison search reindex`, the real
 * Meilisearch, the real Redis keyspace. FAKED: nothing.
 */
test("L8: ciphertext at rest survives every privileged reader", async ({ env, world, qa }) => {
  test.setTimeout(900_000)
  expect(purged.accountId, "L8 sweeps the mailbox L10 sealed and purged").not.toBe("")

  const {
    assertNonVacuousCorpus,
    assertPlaintextColumnsClean,
    assertMeiliClean,
    assertExportArtifact,
    assertControlPlaneClean,
    countPhrasePresence,
    summarize,
  } = await import("../../../../../scripts/lib/mailbox-at-rest-verdicts")
  const { MAIL_HEADER_ALLOWLIST } = await import(
    "../../../../api/src/modules/mailbox-crypto/header-allowlist"
  )

  // The positive control: a SHARED org mailbox, outside the encryption regime.
  // Its plaintext must still be in the database, in the export and in the
  // search index. A sweep that finds nothing for it is sweeping nothing.
  const controlTag = `l8ctl${randomUUID().slice(0, 6)}`
  const control = await seedPersonalMailbox(env, world.org.id, qa.admin.id, {
    messages: 3,
    tag: controlTag,
    ownerType: "org",
  })
  // The subject, not the body: a mail CONVERSATION document indexes
  // `indexFields.title = subject` and carries no body field, so the subject is
  // the only text that can be found there at all.
  const controlPhrase = control.subjects[0]

  // Five distinct phrases, which is what the prod assertion requires.
  const phrases = purged.phrases.slice(0, 3).concat(purged.subjects.slice(0, 2))
  expect(phrases.length, "L8 needs five distinct phrases").toBe(5)

  const verdicts = []

  // ── V9a: the corpus, read as the privileged operator ──────────────────────
  // `env.db.sql` connects as the postgres SUPERUSER, so RLS does not apply.
  // This is the platform-operator view the criterion is about.
  const [ready] = await queryRows(
    env,
    `SELECT count(*)::int AS n FROM ${ms(env)}.messages m
       JOIN ${ms(env)}.accounts a ON a.id = m.account_id
      WHERE a.owner_type = 'user' AND a.encryption_state = 'ready' AND a.owner_id = $1`,
    [purged.userId],
  )
  verdicts.push(assertNonVacuousCorpus(Number(ready.n)))
  expect(Number(ready.n), "non-vacuity: fewer than 200 ready messages under test").toBeGreaterThan(
    199,
  )

  const allowlist = MAIL_HEADER_ALLOWLIST.map((h) => `'${h}'`).join(",")
  const count = async (sql: string): Promise<number> =>
    Number((await queryRows(env, sql, [purged.userId]))[0]?.n ?? -1)
  const readyJoin = `${ms(env)}.messages m JOIN ${ms(env)}.accounts a ON a.id = m.account_id
     WHERE a.owner_type = 'user' AND a.encryption_state = 'ready' AND a.owner_id = $1`
  verdicts.push(
    ...assertPlaintextColumnsClean({
      messages: await count(
        `SELECT count(*)::int AS n FROM ${readyJoin}
           AND (m.subject IS NOT NULL OR m.text_body IS NOT NULL
                OR m.html_body IS NOT NULL OR m.snippet IS NOT NULL)`,
      ),
      conversations: await count(
        `SELECT count(*)::int AS n FROM ${ms(env)}.conversations c
           JOIN ${ms(env)}.accounts a ON a.id = c.account_id
          WHERE a.owner_type = 'user' AND a.encryption_state = 'ready' AND a.owner_id = $1
            AND (c.subject IS NOT NULL OR c.snippet IS NOT NULL)`,
      ),
      drafts: await count(
        `SELECT count(*)::int AS n FROM ${ms(env)}.drafts d
           JOIN ${ms(env)}.accounts a ON a.id = d.account_id
          WHERE a.owner_type = 'user' AND a.encryption_state = 'ready' AND a.owner_id = $1
            AND (nullif(d.subject, '') IS NOT NULL OR nullif(d.text_body, '') IS NOT NULL
                 OR nullif(d.html_body, '') IS NOT NULL)`,
      ),
      rawHeaders: await count(
        `SELECT count(*)::int AS n FROM ${readyJoin}
           AND EXISTS (SELECT 1 FROM jsonb_object_keys(m.raw_headers) k
                        WHERE lower(k) NOT IN (${allowlist}))`,
      ),
    }),
  )

  // The positive control, same query shape: the shared mailbox IS readable.
  const [controlRows] = await queryRows(
    env,
    `SELECT count(*)::int AS n FROM ${ms(env)}.messages
      WHERE account_id = $1 AND text_body IS NOT NULL`,
    [control.accountId],
  )
  expect(
    Number(controlRows.n),
    "the shared org mailbox lost its plaintext too: this sweep is not reading what it thinks",
  ).toBe(3)

  // ── V9b: the search index ─────────────────────────────────────────────────
  const reindex = await runSearchReindex(env)
  expect(reindex.exitCode, `search reindex failed:\n${reindex.stderr}`).toBe(0)
  const controlHits = await meiliProbe(env, controlPhrase, { waitMs: 3_000 })
  expect(
    controlHits.reduce((sum, p) => sum + p.hits, 0),
    `the shared mailbox is not searchable either, so a zero-hit result proves nothing: ${JSON.stringify(controlHits)}`,
  ).toBeGreaterThan(0)
  const probes = []
  for (const phrase of phrases) {
    for (const probe of await meiliProbe(env, phrase)) {
      // The prod assertion requires the `thread` index by its bare name; local
      // indexes carry this worker's namespace prefix.
      probes.push({
        indexUid: probe.index.slice(env.meiliIndexPrefix.length),
        phrase,
        hits: probe.hits,
      })
    }
  }
  verdicts.push(assertMeiliClean(probes))

  // ── V9c: the full export ──────────────────────────────────────────────────
  const tarPath = `${process.env.TMPDIR ?? "/tmp"}/mailbox-l8-${randomUUID()}.tar.gz`
  const exported = await runExportFull(env, tarPath)
  expect(exported.exitCode, `export --full failed:\n${exported.stdout}\n${exported.stderr}`).toBe(0)
  const artifact = await extractExport(tarPath)
  expect(artifact.files.length, "the export artifact is empty").toBeGreaterThan(0)
  expect(
    artifact.text.includes(controlPhrase),
    "the export does not contain the SHARED mailbox's plaintext either, so its silence about the personal one proves nothing",
  ).toBe(true)
  verdicts.push(
    assertExportArtifact({
      phraseCounts: countPhrasePresence(artifact.text, phrases),
      ciphertextMatches: (artifact.text.match(/text_body_ciphertext/g) ?? []).length,
    }),
  )

  // The key material is excluded BY DATA, not by table: the DDL is present and
  // the rows are not. Scoped to this worker's schema so a sibling worker's
  // rows cannot decide the verdict.
  const wrapsTable = `${env.schemaPrefix}kernel.user_key_wraps`
  expect(
    artifact.text.includes(`CREATE TABLE ${wrapsTable}`),
    `the export dropped the ${wrapsTable} DDL, so a restore would not be schema-complete`,
  ).toBe(true)
  for (const table of ["user_key_wraps", "user_mailbox_identities"]) {
    expect(
      artifact.text.includes(`COPY ${env.schemaPrefix}kernel.${table} `),
      `the export carried ${table} ROWS: a wrap plus a keyring is an offline cracking oracle`,
    ).toBe(false)
  }

  // ── V9e: the control plane, including Redis ───────────────────────────────
  const controlPlanePhrase = phrases[0]
  const one = async (sql: string): Promise<number> =>
    Number((await queryRows(env, sql, [controlPlanePhrase]))[0]?.n ?? -1)
  const K = ks(env)
  let redisKeys = 0
  {
    let cursor = "0"
    do {
      const [next, keys] = (await env.redis.redis.scan(
        cursor,
        "MATCH",
        `${env.redisPrefix}*`,
        "COUNT",
        500,
      )) as [string, string[]]
      cursor = next
      for (const key of keys) {
        const type = await env.redis.redis.type(key)
        const value =
          type === "string"
            ? ((await env.redis.redis.get(key)) ?? "")
            : type === "list"
              ? (await env.redis.redis.lrange(key, 0, -1)).join("\n")
              : type === "hash"
                ? JSON.stringify(await env.redis.redis.hgetall(key))
                : ""
        if (value.includes(controlPlanePhrase)) redisKeys += 1
      }
    } while (cursor !== "0")
  }
  verdicts.push(
    assertControlPlaneClean({
      messagesMetadata: await one(
        `SELECT count(*)::int AS n FROM ${K}.messages WHERE coalesce(metadata::text, '') LIKE '%' || $1 || '%'`,
      ),
      auditLog: await one(
        `SELECT count(*)::int AS n FROM ${K}.audit_log WHERE coalesce(changes::text, '') LIKE '%' || $1 || '%'`,
      ),
      pendingEvents: await one(
        `SELECT count(*)::int AS n FROM ${K}.pending_events WHERE coalesce(payload::text, '') LIKE '%' || $1 || '%'`,
      ),
      approvalRequests: await one(
        `SELECT count(*)::int AS n FROM ${K}.approval_requests
          WHERE coalesce(tool_params::text, '') LIKE '%' || $1 || '%'
             OR coalesce(current_payload::text, '') LIKE '%' || $1 || '%'
             OR coalesce(summary::text, '') LIKE '%' || $1 || '%'`,
      ),
      threadTitles: await one(
        `SELECT count(*)::int AS n FROM ${K}.threads WHERE coalesce(title, '') LIKE '%' || $1 || '%'`,
      ),
      fileDerivatives: await one(
        `SELECT count(*)::int AS n FROM ${K}.files f
           JOIN ${ms(env)}.messages m ON f.entity_id = m.id::text
           JOIN ${ms(env)}.accounts a ON a.id = m.account_id
          WHERE f.app = 'mail' AND a.owner_type = 'user' AND $1 = $1
            AND (f.thumbnail_key IS NOT NULL OR f.analysis_summary IS NOT NULL)`,
      ),
      redisKeys,
    }),
  )

  const outcome = summarize(verdicts)
  // eslint-disable-next-line no-console
  console.log(`[L8] privileged-reader sweep\n${outcome.text}`)
  expect(outcome.exitCode, `the privileged-reader sweep failed:\n${outcome.text}`).toBe(0)
})

/**
 * Attachments (SC3), and the regression for the mail UI that saved ciphertext
 * under the original filename.
 *
 * The assertion is on the SAVED BYTES, not on a rendered preview: a preview can
 * be produced by a path that never decrypts, which is exactly how the original
 * defect passed review.
 *
 * REAL: the ingest, the host-side seal, the STREAM chunking, the object store, the inline
 * route, the crypto worker, the browser's own save path. FAKED: the provider
 * fetch that would have carried the bytes in, and, for the fail-closed leg
 * only, a truncated response body, because we have no way to corrupt an object
 * store from a browser test and the truncation is the fault being simulated.
 */
test("L7: attachments are ciphertext at rest and open correctly in the browser", async ({
  page,
  env,
  world,
  qa,
}) => {
  test.setTimeout(600_000)
  expect(enrolled.accountId, "L7 runs on L1's enrolled mailbox").not.toBe("")

  // Three real file shapes, each with its own magic bytes.
  const pdf = Buffer.concat([
    Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n", "latin1"),
    Buffer.alloc(2048, 0x41),
    Buffer.from("\n%%EOF\n", "latin1"),
  ])
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(4096, 0x42),
  ])
  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(1024, 0x43)])
  const fixtures = [
    { filename: "invoice.pdf", mimeType: "application/pdf", bytes: pdf, magic: "%PDF" },
    { filename: "photo.png", mimeType: "image/png", bytes: png, magic: "\x89PNG" },
    { filename: "archive.zip", mimeType: "application/zip", bytes: zip, magic: "PK\x03\x04" },
  ]

  const tag = `l7${randomUUID().slice(0, 6)}`
  const before = await readMessages(env, enrolled.accountId)
  const ingest = await runIngest(env, {
    orgId: world.org.id,
    accountId: enrolled.accountId,
    actor: "system:mail:sync",
    messages: ingestFixtures(
      tag,
      1,
      enrolled.email,
      fixtures.map((f) => ({
        filename: f.filename,
        mimeType: f.mimeType,
        bytesBase64: f.bytes.toString("base64"),
        disposition: "attachment" as const,
      })),
    ),
  })
  expect(ingest.exitCode, `ingest failed:\n${ingest.stderr}`).toBe(0)
  expect(ingest.result?.error, `the ingest threw: ${ingest.result?.error}`).toBeNull()

  const after = await readMessages(env, enrolled.accountId)
  const fresh = after.filter((row) => !before.some((old) => old.id === row.id))
  expect(fresh.length, "the ingest wrote exactly one message").toBe(1)
  const messageId = fresh[0].id as string

  // ── Non-vacuity, first ────────────────────────────────────────────────────
  // Three stored objects that exist, are sealed, and are longer than the
  // plaintext they carry. A zero-byte or missing object satisfies every
  // magic-byte assertion below perfectly and proves nothing.
  const rows = await readMessageFiles(env, messageId)
  expect(
    rows.length,
    `the attachments never reached kernel.files. Ingest logs: ${JSON.stringify(ingest.result?.logs ?? [])}`,
  ).toBe(3)
  const token = await freshAccessToken(env.serverUrl, qa.admin.email, "12345678")
  const stored = new Map<string, Uint8Array>()
  for (const row of rows) {
    const fixture = fixtures.find((f) => f.filename === row.filename)
    expect(fixture, `unexpected stored file ${row.filename}`).toBeTruthy()
    expect(Number(row.enc_version), `${row.filename} was stored unsealed`).toBe(1)
    expect(Number(row.plaintext_length), `${row.filename} plaintext length`).toBe(
      fixture?.bytes.length,
    )
    expect(Number(row.chunk_count), `${row.filename} was not chunked`).toBeGreaterThan(0)
    // Task 7.4: the server cannot read a sealed attachment, so it must not
    // hold a rendering or a description of one.
    expect(row.thumbnail_key, `${row.filename} kept a thumbnail`).toBeNull()
    expect(row.analysis_summary, `${row.filename} kept an analysis summary`).toBeNull()

    const raw = await fetch(`${env.serverUrl}/api/files/${row.id}/inline?download=1`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(raw.status, `the inline route refused ${row.filename}`).toBe(200)
    const bytes = new Uint8Array(await raw.arrayBuffer())
    stored.set(row.id as string, bytes)
    expect(bytes.length, `${row.filename} is stored empty`).toBeGreaterThan(0)
    expect(bytes.length, `${row.filename} is stored at its plaintext length`).not.toBe(
      fixture?.bytes.length,
    )
    // The bytes at rest carry no recognisable header of what they are.
    const head = Buffer.from(bytes.slice(0, 8)).toString("latin1")
    for (const magic of ["%PDF", "\x89PNG", "PK\x03\x04"]) {
      expect(head.startsWith(magic), `${row.filename} is readable at rest: ${head}`).toBe(false)
    }
  }

  // No derivative job was even ENQUEUED for a sealed attachment. Asserting only
  // that the columns are null would pass on a build that enqueues the job and
  // has not run it yet.
  const enqueued: string[] = ingest.result?.enqueued ?? []
  for (const job of enqueued) {
    expect(
      /thumbnail|analysis|analyze/i.test(job),
      `a derivative job was enqueued for a sealed attachment: ${job}`,
    ).toBe(false)
  }

  // ── The browser opens them, and gets the real bytes back ──────────────────
  await loginAs(page, env, qa.admin.email, "12345678")
  await openMail(page, env)
  await openMailboxUnlock(page)
  await unlockMailboxThroughUi(page, "passphrase", TEST_PASSPHRASE)
  await expect(page.getByTestId("mailbox-unlock-host")).toBeHidden({ timeout: 120_000 })
  // Sealed rows are listed only once unlocked, so the row is opened after.
  await openConversationById(page, fresh[0].conversation_id as string)

  for (const row of rows) {
    const fixture = fixtures.find((f) => f.filename === row.filename)
    if (!fixture) continue
    const button = page.getByTestId(`attachment-download-${row.id}`)
    await expect(button, `${row.filename} has no download control`).toBeVisible({ timeout: 60_000 })
    const [download] = await Promise.all([page.waitForEvent("download"), button.click()])
    expect(download.suggestedFilename()).toBe(fixture.filename)
    const savedPath = await download.path()
    const saved = new Uint8Array(await Bun.file(savedPath).arrayBuffer())
    expect(saved.length, `${fixture.filename} saved at the wrong length`).toBe(fixture.bytes.length)
    expect(
      Buffer.from(saved).toString("latin1").startsWith(fixture.magic),
      `${fixture.filename} saved WITHOUT decrypting: the user got ciphertext under the real name`,
    ).toBe(true)
    expect(Buffer.from(saved).equals(fixture.bytes), `${fixture.filename} did not round trip`).toBe(
      true,
    )
  }

  // ── Truncation fails closed ───────────────────────────────────────────────
  // The STREAM construction exists so a short object cannot decrypt to a short
  // file. The corruption is injected at the transport, which is the only place
  // a browser test can reach, and it is exactly the fault under test.
  const victim = rows[0]
  const full = stored.get(victim.id as string)
  expect(full, "no stored bytes captured for the truncation case").toBeTruthy()
  await page.route(`**/api/files/${victim.id}/inline*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      body: Buffer.from((full as Uint8Array).slice(0, Math.floor((full as Uint8Array).length / 2))),
    })
  })
  let saved = false
  const watcher = page
    .waitForEvent("download", { timeout: 15_000 })
    .then(() => {
      saved = true
    })
    .catch(() => {})
  await page.getByTestId(`attachment-download-${victim.id}`).click()
  await watcher
  expect(
    saved,
    "a truncated attachment was saved anyway: the user gets a short file that looks like their invoice",
  ).toBe(false)
})

/**
 * Client-side search over the sealed mailbox (SC8).
 *
 * WHAT THIS SCENARIO CAN AND CANNOT PROVE, stated before the code because the
 * plan asked for something the product does not have.
 *
 * The plan's L6 is "the user searches their own mail, and the query term never
 * leaves the browser". There is no user-facing client search surface to drive:
 * `startMailboxSearchIndex` is called from `MailboxAgentHost`, and the ONLY
 * consumer of the built index is `answerClientSearch`, reached from the
 * server's `mailbox_search_request`. The mail inbox's own search box queries
 * the server, whose index deliberately holds nothing for sealed rows. So the
 * "never leaves the browser" half is not a property this build can exhibit:
 * in the one path that exists, the query originates on the server by
 * construction. That is a finding, not something to assert around.
 *
 * What IS provable, and is what SC8 rests on, is proved here: the index really
 * is built from the sealed listing in this browser, and a phrase that occurs in
 * exactly one message BODY finds exactly that message, through the real
 * request/response wiring, with the server never seeing the body.
 *
 * REAL: everything. FAKED: nothing (the model, as in L5, is Gemini Flash-Lite).
 */
test("L6: the client index is built from the sealed listing and finds a body phrase", async ({
  page,
  env,
  world,
  qa,
}) => {
  test.setTimeout(900_000)
  expect(enrolled.sealedMessageId, "L6 runs on the message L2 sealed").not.toBe("")

  await seedModelPricingAndCredits(env, world.org.id)
  const token = await freshAccessToken(env.serverUrl, qa.admin.email, "12345678")

  const listings: Array<{ url: string; status: number }> = []
  const searchPosts: Array<{ url: string; body: string }> = []
  page.on("response", (r) => {
    if (r.url().includes("/api/mailbox/sync-cursor"))
      listings.push({ url: r.url(), status: r.status() })
  })
  page.on("request", (r) => {
    if (r.url().includes("/api/agent/mailbox-search/"))
      searchPosts.push({ url: r.url(), body: r.postData() ?? "" })
  })
  await routeWebSocketToApi(page, env)

  // THE TURN, scripted on the server: one real `mail__search` for the sealed
  // phrase. The search itself is the real two-phase one — the server cannot
  // answer it, so the browser's own index has to, which is the property under
  // test. `mail__search` is deferred like every app tool, so the script loads it
  // first with `loadToolStep`, as the rest of this file does.
  const dmThread = await agentDmThreadId(env, token)
  await scriptAgentTurn(env, {
    threadId: dmThread,
    steps: [
      loadToolStep("mail__search"),
      // `body` is the free-text term itself (a string in the tool's schema): a
      // boolean there fails validation before the handler ever raises the
      // client search marker.
      { toolCalls: [{ name: "mail__search", args: { body: enrolled.sealedPhrase } }] },
      { text: L6_ANSWER },
    ],
  })

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(webUrl(env, "/"))
  await page.getByRole("button", { name: "Mail", exact: true }).click()
  await page.getByTestId("mail-inbox").waitFor({ state: "visible", timeout: 60_000 })
  // The locked mail home asks to unlock on landing; answer it there.
  await unlockMailboxThroughUi(page, "passphrase", TEST_PASSPHRASE)
  await expect(page.getByTestId("mailbox-unlock-host")).toBeHidden({ timeout: 120_000 })
  await openConversationById(page, enrolled.sealedConversationId)

  // Diagnostic first: which half is missing, the fetch or the store.
  await page.waitForTimeout(5_000)
  const banner = page.getByTestId("mail-search-index-banner")
  // eslint-disable-next-line no-console
  console.log(
    `[L6] listings ${JSON.stringify(listings)} banner ${
      (await banner.count()) > 0 ? await banner.getAttribute("data-status") : "<none>"
    }`,
  )

  // ── The index is really built, on this device ─────────────────────────────
  // The witness is the persisted shard store, not a spinner: an index that
  // reported ready and stored nothing would answer "no matches" to everything,
  // which is the one answer this design may never give by accident.
  // `expect.poll` and not `waitForFunction`: the probe is asynchronous, and
  // `waitForFunction` treats the returned Promise itself as its truthy result
  // instead of awaiting it, which reports "no shards" the instant it is called.
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () =>
            new Promise<number>((resolve) => {
              // The store the production blob store writes
              // (`createIndexedDbBlobStore` defaults, `index-blob-store.ts`).
              const open = indexedDB.open("liaison-mailbox-search-index", 1)
              open.onerror = () => resolve(-1)
              open.onsuccess = () => {
                const db = open.result
                if (!db.objectStoreNames.contains("shards")) {
                  resolve(0)
                  return
                }
                const store = db.transaction("shards").objectStore("shards")
                const req = store.count()
                req.onsuccess = () => resolve(req.result)
                req.onerror = () => resolve(-1)
              }
            }),
        ),
      {
        timeout: 180_000,
        message:
          "the client search index stored no shard: search would answer nothing to everything",
      },
    )
    .toBeGreaterThan(0)

  // The listing was fetched in the DEFAULT sealed mode. `verify` is a different
  // set: it does not filter on `enc_version`, so an index built from it would
  // hold rows this browser cannot open.
  expect(listings.length, "the client index never fetched the sealed listing").toBeGreaterThan(0)
  expect(
    listings.some((l) => !l.url.includes("mode=verify") && l.status === 200),
    `the sealed listing never answered 200: ${JSON.stringify(listings)}`,
  ).toBe(true)

  // ── A body phrase finds exactly its message ───────────────────────────────
  // The conversation is an expanded dock tab OVER the mail surface, so the
  // index that was just built in this tab is still mounted and reachable when
  // the turn asks it a question.
  const conversation = await openAgentConversation(page)
  await sendInConversation(
    page,
    conversation,
    `Search my mail for "${enrolled.sealedPhrase}" and tell me how many messages it found.`,
  )
  await waitForTurnEnd(env, { threadId: dmThread, token, contains: L6_ANSWER, timeout: 180_000 })

  expect(
    searchPosts.length,
    "the browser never answered a client search request: the client index is not reachable from a turn",
  ).toBeGreaterThan(0)
  const answered = searchPosts
    .map((p) => {
      try {
        return JSON.parse(p.body) as { messageIds?: string[]; indexComplete?: boolean }
      } catch {
        return { messageIds: [] as string[] }
      }
    })
    .filter((p) => (p.messageIds ?? []).length > 0)
  expect(
    answered.length,
    `every client search answer was empty: ${JSON.stringify(searchPosts.map((p) => p.body.slice(0, 200)))}`,
  ).toBeGreaterThan(0)
  for (const answer of answered) {
    expect(
      answer.messageIds,
      "the client index returned something other than the one message that carries the phrase",
    ).toEqual([enrolled.sealedMessageId])
    expect(answer.indexComplete, "the index answered while admitting it is incomplete").toBe(true)
  }

  // The body never reached the server's own index, which is the other half of
  // why the client index has to exist at all.
  const reindex = await runSearchReindex(env)
  expect(reindex.exitCode, `search reindex failed:\n${reindex.stderr}`).toBe(0)
  //
  // The agent DM is left out, and only it: the user typed the phrase into it
  // just above, and L5 asked the agent to quote the body there, so its kernel
  // messages carry the phrase as the conversation the user drove (the same
  // disclosure L5's audit note describes). Mail documents and every other
  // conversation still count.
  const hits = await meiliProbe(env, enrolled.sealedPhrase, {
    waitMs: 3_000,
    excludeKernelThreadIds: [dmThread],
  })
  expect(
    hits.reduce((sum, p) => sum + p.hits, 0),
    `the sealed body is searchable server-side: ${JSON.stringify(hits)}`,
  ).toBe(0)
})

/**
 * The gated send (SC13 / T-SEC-11, and review finding 24).
 *
 * Two properties, and the second is written RED on purpose.
 *
 *   1. What is STORED for a gated mail send from an encrypted mailbox is
 *      ciphertext. The row on disk must not carry the body, the subject or the
 *      quoted original, because that row outlives the send and the purge.
 *   2. Approving WITHOUT the browser's fulfilment must be refused. Nothing on
 *      the decide path enforced that when the plan was written: the handler
 *      would run with an empty body and report a successful send. A blank email
 *      that reports success is worse than a refusal.
 *
 * WHY IT IS DRIVEN THROUGH A BROWSER TURN AND NOT `run-tool`. Measured: calling
 * `mail:reply` headlessly on a sealed conversation returns a Phase 1 marker,
 * `needsPlaintext {requestKind: "mail.quote"}`, and creates NO approval, because
 * the reply cannot even resolve the subject of the message it is answering
 * without the owner's browser. That is the design working, and it means the
 * gated approval only comes into existence inside a real turn.
 *
 * REAL: the turn, the two-phase quote fulfilment, the gating,
 * `sealMailApprovalPayload`, the approval row, the decide route. FAKED:
 * nothing (the model is Gemini Flash-Lite, as in L5).
 * NOT REACHED: what the SMTP path is handed. The send executes inside the
 * spawned API process, whose only interception seam (`SandboxBridgeTestAccess.setSmtpSend`) is
 * in-process and installed by the chaos entry point, not by the e2e server;
 * and this is a Gmail account, whose send is an HTTP call rather than an SMTP
 * socket. Capturing it needs an e2e-server seam that does not exist yet, so
 * this scenario stops before the send and says so rather than pretending.
 */
test("L12: a gated send seals its approval payload, and refuses to send without the fulfilment", async ({
  page,
  env,
  world,
  qa,
}) => {
  test.setTimeout(900_000)
  expect(enrolled.sealedConversationId, "L12 replies to the conversation L2 sealed").not.toBe("")

  await seedModelPricingAndCredits(env, world.org.id)
  const token = await freshAccessToken(env.serverUrl, qa.admin.email, "12345678")
  const secret = `zephyrine-l12-${randomUUID().slice(0, 8)}-quillmark`

  await routeWebSocketToApi(page, env)

  // THE TURN, scripted on the server: one real, GATED `mail__reply`. Everything
  // the scenario asserts afterwards — the sealed payload, the approval row, the
  // refusal on the decide path — is produced by that real call.
  //
  // WHY IT STILL HAS TO GO THROUGH A BROWSER TURN (measured, and unchanged by
  // the scripting): calling `mail:reply` headlessly on a sealed conversation
  // returns a Phase 1 marker, `needsPlaintext {requestKind: "mail.quote"}`, and
  // creates NO approval, because the reply cannot resolve the subject of the
  // message it answers without the owner's unlocked browser.
  const dmThread = await agentDmThreadId(env, token)
  await scriptAgentTurn(env, {
    threadId: dmThread,
    steps: [
      loadToolStep("mail__reply"),
      {
        toolCalls: [
          {
            name: "mail__reply",
            args: { conversationId: enrolled.sealedConversationId, textBody: secret },
          },
        ],
      },
      { text: L12_ANSWER },
    ],
  })

  await loginAs(page, env, qa.admin.email, "12345678")
  await page.goto(webUrl(env, "/"))
  await page.getByRole("button", { name: "Mail", exact: true }).click()
  await page.getByTestId("mail-inbox").waitFor({ state: "visible", timeout: 60_000 })
  // The locked mail home asks to unlock on landing; answer it there.
  await unlockMailboxThroughUi(page, "passphrase", TEST_PASSPHRASE)
  await expect(page.getByTestId("mailbox-unlock-host")).toBeHidden({ timeout: 120_000 })
  await openConversationById(page, enrolled.sealedConversationId)

  const findApproval = async () =>
    await queryRows(
      env,
      `SELECT id::text, tool_name, status, tool_params, current_payload, summary
         FROM ${ks(env)}.approval_requests
        WHERE tool_name LIKE 'mail%' AND status = 'pending'
          AND (tool_params::text LIKE '%' || $1 || '%'
               OR current_payload::text LIKE '%' || $1 || '%')
        ORDER BY created_at DESC LIMIT 1`,
      [enrolled.sealedConversationId],
    )

  // The conversation floats over the mail surface, so the unlocked runtime is
  // still mounted to answer the quote fulfilment the reply needs.
  const conversation = await openAgentConversation(page)
  await sendInConversation(
    page,
    conversation,
    `Reply to conversation ${enrolled.sealedConversationId} with exactly: ${secret}`,
  )
  await waitForTurnEnd(env, { threadId: dmThread, token, contains: L12_ANSWER, timeout: 180_000 })
  const approvals = await findApproval()

  // Non-vacuity: the gated send really did land as a pending approval.
  expect(approvals.length, "the turn created no pending mail approval").toBe(1)
  const approval = approvals[0]

  // ── 1. The row on disk is ciphertext ──────────────────────────────────────
  const stored = JSON.stringify({
    tool_params: approval.tool_params,
    current_payload: approval.current_payload,
    summary: approval.summary,
  })
  expect(
    stored.includes(secret),
    "the approval row carries the reply body in the clear, and that row outlives the purge",
  ).toBe(false)
  expect(
    stored.includes(enrolled.sealedPhrase),
    "the approval row carries the quoted original in the clear",
  ).toBe(false)
  // Positive control: it is sealed, not merely empty.
  expect(
    stored.includes("mailboxSealed") || stored.includes("bodyCiphertext"),
    `the payload is neither plaintext nor sealed, so this assertion proves nothing: ${stored.slice(0, 400)}`,
  ).toBe(true)

  // ── 2. Approving with no fulfilment must not send ─────────────────────────
  const shownRes = await fetch(`${env.serverUrl}/api/approvals/${approval.id}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const payloadHash = ((await shownRes.json()) as { data?: { payloadHash?: string } }).data
    ?.payloadHash
  const decided = await fetch(`${env.serverUrl}/api/approvals/${approval.id}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ decision: "approve", payloadHash }),
  })
  const decidedBody = await decided.text()
  // eslint-disable-next-line no-console
  console.log(`[L12] decide with no fulfilment: ${decided.status} ${decidedBody.slice(0, 300)}`)
  expect(
    decided.status,
    `approving a sealed mail send with no fulfilment was accepted: ${decidedBody}`,
  ).toBeGreaterThanOrEqual(400)
  expect(decided.status, "the refusal was a server error, not a refusal").toBeLessThan(500)
  // The refusal must be ABOUT the missing plaintext. A 403 "you may not approve
  // your own request" is also a 4xx and would make this scenario green while
  // proving nothing about the fulfilment gate.
  expect(
    /mailbox|encrypt|fulfil|plaintext|unlock/i.test(decidedBody),
    `the approval was refused for an unrelated reason, so the fulfilment gate is still unproven: ${decidedBody}`,
  ).toBe(true)

  // Nothing was sent, and the approval is still there to be decided properly.
  const after = await queryRows(
    env,
    `SELECT status FROM ${ks(env)}.approval_requests WHERE id = $1`,
    [approval.id],
  )
  expect(after[0]?.status, "the approval was consumed by a send that had no body").toBe("pending")
  const outbound = await queryRows(
    env,
    `SELECT count(*)::int AS n FROM ${ms(env)}.messages
      WHERE account_id = $1 AND direction = 'outbound'`,
    [enrolled.accountId],
  )
  expect(Number(outbound[0].n), "an outbound message exists: something was sent").toBe(0)
})

/**
 * The mail HOME of a locked mailbox, then the same list unlocked in place.
 *
 * A reload relocks by design (the keys live only in the worker's memory), so
 * the home is where the reader lands locked. It must say so and ask right
 * away, a sealed row must read as locked (never "No subject"), and unlocking
 * from that prompt must put the real subjects on the list with no reload.
 *
 * REAL: the ingest seal (L2), the backfill that seals conversation rows, the
 * API list projection, the crypto worker, the unlock. FAKED: nothing.
 */
test("L13: the mail home asks to unlock, and the list shows real subjects once unlocked", async ({
  page,
  env,
  world,
  qa,
}) => {
  test.setTimeout(300_000)
  expect(enrolled.sealedConversationId, "L13 needs L2's sealed conversation").not.toBe("")

  const backfill = await runBackfill(env, { orgId: world.org.id, userId: qa.admin.id })
  expect(backfill.exitCode, `backfill failed:\n${backfill.stderr}`).toBe(0)

  // Non-vacuity: the conversation ROW is sealed, so the list cannot read its
  // subject from the server.
  const rows = await queryRows(
    env,
    `SELECT subject, subject_ciphertext IS NOT NULL AS sealed
       FROM ${ms(env)}.conversations WHERE id = $1`,
    [enrolled.sealedConversationId],
  )
  expect(rows[0]?.sealed, "the conversation row carries no sealed subject").toBe(true)
  expect(rows[0]?.subject ?? null, "the conversation row still has a plaintext subject").toBeNull()

  await loginAs(page, env, qa.admin.email, "12345678")
  await openMail(page, env, { landingPrompt: "keep" })

  // Asked on landing, before any conversation was opened.
  await expect(page.getByTestId("mailbox-unlock-host")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId("mail-inbox-locked")).toBeVisible()
  // A sealed row the browser cannot open yet is never listed blank: the unlock
  // panel stands in for it.
  const row = page.locator(`[data-conversation-id="${enrolled.sealedConversationId}"]`)
  await expect(row).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath("l13-home-locked.png") })

  await unlockMailboxThroughUi(page, "passphrase", TEST_PASSPHRASE)
  await expect(page.getByTestId("mailbox-unlock-host")).toBeHidden({ timeout: 120_000 })

  // Same page, no reload: the row now carries the decrypted subject.
  await expect(row).toContainText(enrolled.sealedSubject, { timeout: 120_000 })
  await expect(page.getByTestId("mail-inbox-locked")).toBeHidden()
  await page.screenshot({ path: test.info().outputPath("l13-home-unlocked.png") })
})
