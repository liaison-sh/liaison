// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The personal mailbox inside the DESKTOP app's webview conditions.
//
// The desktop app (Tauri, macOS WKWebView) serves the same production build
// under the CSP in `apps/desktop/src-tauri/tauri.conf.json`. WebKit refuses
// WebAssembly under a `script-src` without 'wasm-unsafe-eval', and the mailbox
// crypto worker is a blob worker that inherits the page's CSP, so a legacy
// (Argon2id, hash-wasm) password row could not be opened in the desktop app.
// This lane runs in WebKit with that CSP, read from the shell's config at run
// time and served as the header of every HTML document, so a change to the
// shell's CSP is what the lane tests.
//
//   E2E_WEB_PREVIEW=1 PLAYWRIGHT_PROJECT=desktop-webkit \
//     bun run scripts/test-run.ts playwright \
//     --file src/tests/e2e/mailbox.desktop-webview.scenario.test.ts
//
// E2E_DESKTOP_CSP_STRIP_WASM=1 drops 'wasm-unsafe-eval' from the served CSP.
// It exists for one purpose: proving that the legacy unlock scenario fails
// without it. Never set it in a normal run.
//
// REAL: API, build, WebKit, Postgres, crypto worker, enrolment wizard, unlock
// surface, ingest seal, the legacy re-wrap. FAKED: the Gmail OAuth handoff
// after enrolment (see `enrolMailboxThroughUi`). The legacy row is built with
// the package's own `wrapWithLegacyPassphrase` (real Argon2id via hash-wasm),
// because the product no longer mints one.

import { createHash, randomBytes, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { unwrapWithPassphrase, wrapWithLegacyPassphrase } from "@liaison/mailbox-crypto/src/client"
import type { WorkerEnv } from "@liaison/test-helpers"
import type { Browser, BrowserContext, Page } from "@playwright/test"
import { expect, loginAs, test } from "./fixtures/test"
import { freshAccessToken } from "./helpers/fresh-token"
import {
  enableGmailProvider,
  enrolMailboxThroughUi,
  ingestFixtures,
  ks,
  openConversationById,
  openMail,
  readIdentities,
  readMessages,
  readRenderedBody,
  readWraps,
  runIngest,
  seedPersonalMailbox,
  TEST_PASSPHRASE,
  unlockMailboxThroughUi,
  webUrl,
} from "./helpers/mailbox-seed"

test.describe.configure({ mode: "serial" })

const TAURI_CONF = path.resolve(import.meta.dir, "../../../../desktop/src-tauri/tauri.conf.json")

/** The desktop shell's CSP, exactly as configured, unless the mutation switch is on. */
function desktopCsp(): string {
  const conf = JSON.parse(readFileSync(TAURI_CONF, "utf8")) as {
    app?: { security?: { csp?: unknown } }
  }
  const csp = conf.app?.security?.csp
  if (typeof csp !== "string" || csp.trim() === "") {
    throw new Error(`no app.security.csp string in ${TAURI_CONF}`)
  }
  if (process.env.E2E_DESKTOP_CSP_STRIP_WASM === "1") {
    return csp.replace(/\s*'wasm-unsafe-eval'/g, "")
  }
  return csp
}

/**
 * The policy a bundled document actually runs under in the shell. When `csp` is
 * set, Tauri's codegen hashes every non-empty inline `<script>` of each bundled
 * HTML file (CRLF normalised to LF) and adds the `'sha256-...'` sources to
 * `script-src` (tauri-codegen 2.x `context.rs`, `inject_script_hashes`), so the
 * configured policy alone, served as a header, would refuse scripts the real
 * window runs. This adds the same hashes for the document being served, the
 * probe included; nothing else in the policy changes.
 */
function shellCspFor(csp: string, html: string): string {
  const hashes: string[] = []
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const body = m[2] ?? ""
    if (body === "") continue
    const normalised = body.replace(/\r\n?/g, "\n")
    hashes.push(`'sha256-${createHash("sha256").update(normalised, "utf8").digest("base64")}'`)
  }
  if (hashes.length === 0) return csp
  return csp.replace(/(^|;\s*)script-src([^;]*)/, (_all, lead: string, sources: string) => {
    return `${lead}script-src${sources} ${hashes.join(" ")}`
  })
}

interface DesktopShell {
  csp: string
  /** The worker env with the web port pointing at the shell, for every UI helper. */
  env: WorkerEnv
  /** How many HTML documents were served with the header. */
  served: () => number
  close: () => Promise<void>
}

/**
 * The desktop shell's document delivery, in front of the preview server: every
 * HTML document is served with the desktop CSP header, everything else passes
 * through untouched. The blob worker inherits the policy from the document, as
 * in the webview.
 *
 * WHY A PROXY AND NOT `context.route`: while request interception is on,
 * Playwright's WebKit cannot load a module worker from a blob URL the page has
 * already revoked (`WebKitBlobResource error 1`), which is exactly how the
 * crypto worker boots. The real webview has no interception, so a route would
 * fail the lane on a harness artifact.
 */
async function startDesktopShell(env: WorkerEnv): Promise<DesktopShell> {
  const csp = desktopCsp()
  const upstreamPort = env.ports[1] as number
  let served = 0
  const server = http.createServer((req, res) => {
    const headers = { ...req.headers, host: `localhost:${upstreamPort}` }
    // Plain bytes, so the probe can be placed into an HTML body.
    delete headers["accept-encoding"]
    const upstream = http.request(
      { host: "localhost", port: upstreamPort, method: req.method, path: req.url, headers },
      (up) => {
        const type = String(up.headers["content-type"] ?? "")
        if (!type.includes("text/html")) {
          res.writeHead(up.statusCode ?? 502, up.headers)
          up.pipe(res)
          return
        }
        const chunks: Buffer[] = []
        up.on("data", (chunk: Buffer) => chunks.push(chunk))
        up.on("end", () => {
          served++
          const html = Buffer.concat(chunks)
            .toString("utf8")
            .replace(/<head([^>]*)>/i, `<head$1>${PROBE_SCRIPT}`)
          const out = { ...up.headers }
          delete out["content-length"]
          delete out["content-encoding"]
          delete out["transfer-encoding"]
          out["content-security-policy"] = shellCspFor(csp, html)
          res.writeHead(up.statusCode ?? 200, out)
          res.end(html)
        })
      },
    )
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
  })
  server.on("upgrade", (_req, socket) => socket.destroy())
  await new Promise<void>((resolve) => server.listen(0, () => resolve()))
  const port = (server.address() as AddressInfo).port
  const ports = [...env.ports]
  ports[1] = port
  const shellEnv = Object.create(env, { ports: { value: ports } }) as WorkerEnv
  return {
    csp,
    env: shellEnv,
    served: () => served,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** A profile of the webview: the desktop window size, and a prompt witness. */
async function newDesktopContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    colorScheme: "dark",
  })
  // Records whether the unlock prompt ever mounted on a page, so "no unlock
  // prompt" is an observation over the whole load, not a single late look.
  await context.addInitScript(() => {
    const w = window as unknown as { __unlockPromptSeen?: boolean }
    w.__unlockPromptSeen = false
    const check = () => {
      if (document.querySelector('[data-testid="mailbox-unlock-host"]')) {
        w.__unlockPromptSeen = true
      }
    }
    new MutationObserver(check).observe(document, { childList: true, subtree: true })
  })
  return context
}

/**
 * The page's own view of the policy. Code Playwright evaluates is exempt from
 * the page CSP, so the probe is an inline script placed at the top of the
 * served document and run by the page itself: `eval` must be refused under the
 * desktop CSP, and WebAssembly compiles only while the policy carries
 * 'wasm-unsafe-eval'. It only records; it changes nothing the app reads.
 */
const PROBE_SCRIPT = `<script>(function () {
  var out = { eval: "pending", wasm: "pending" };
  try { (0, eval)("1"); out.eval = "allowed" } catch (e) { out.eval = "refused: " + e }
  try {
    new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    out.wasm = "allowed"
  } catch (e) { out.wasm = "refused: " + e }
  window.__cspProbe = out
})()</script>`

async function probePolicy(page: Page): Promise<{ eval: string; wasm: string }> {
  const probe = await page.evaluate(
    () => (window as unknown as { __cspProbe?: { eval: string; wasm: string } }).__cspProbe,
  )
  if (!probe) throw new Error("the CSP probe script did not run in this document")
  return probe
}

const wasmAllowed = process.env.E2E_DESKTOP_CSP_STRIP_WASM === "1" ? /^refused/ : /^allowed$/

/** Every console line of the running scenario, printed when it fails. */
let scenarioConsole: string[] = []

function collectConsole(page: Page, sink: string[]): void {
  scenarioConsole = sink
  page.on("console", (message) => sink.push(`[${message.type()}] ${message.text()}`))
  page.on("pageerror", (error) => sink.push(`[pageerror] ${String(error)}`))
  page.on("requestfailed", (request) =>
    sink.push(
      `[requestfailed] ${request.url().slice(0, 160)} ${request.failure()?.errorText ?? ""}`,
    ),
  )
  page.on("response", (response) => {
    if (response.status() >= 400)
      sink.push(`[http ${response.status()}] ${response.url().slice(0, 160)}`)
  })
  page.on("worker", (worker) =>
    worker.on("console", (message) => sink.push(`[worker ${message.type()}] ${message.text()}`)),
  )
}

const wasmLines = (sink: string[]) =>
  sink.filter((line) => /webassembly|wasm|content security|csp|refused/i.test(line))

const state: {
  shell: DesktopShell | null
  context: BrowserContext | null
  sealedConversationId: string
  sealedPhrase: string
} = { shell: null, context: null, sealedConversationId: "", sealedPhrase: "" }

test.beforeAll(({ browserName }) => {
  expect(browserName, "the desktop webview is WebKit").toBe("webkit")
  expect(
    process.env.E2E_WEB_PREVIEW,
    "the mailbox lanes run against a production build: set E2E_WEB_PREVIEW=1",
  ).toBe("1")
})

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires the fixture object pattern
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    // eslint-disable-next-line no-console
    console.log(
      `[${testInfo.title.slice(0, 2)}] console on failure:\n${scenarioConsole.join("\n")}`,
    )
  }
  scenarioConsole = []
})

test.afterAll(async () => {
  await state.context?.close().catch(() => {})
  await state.shell?.close().catch(() => {})
})

test("D1: a fresh user enrols under the desktop CSP and reads sealed mail", async ({
  browser,
  env,
  world,
  qa,
}) => {
  test.setTimeout(300_000)
  const mailbox = await seedPersonalMailbox(env, world.org.id, qa.admin.id, {
    messages: 2,
    tag: `d1${randomUUID().slice(0, 6)}`,
  })
  await enableGmailProvider(env, await freshAccessToken(env.serverUrl, qa.admin.email, "12345678"))
  expect(
    (await readIdentities(env, qa.admin.id)).filter((row) => row.status === "active").length,
    "the user starts with no keyring",
  ).toBe(0)

  const shell = await startDesktopShell(env)
  state.shell = shell
  const ui = shell.env
  const context = await newDesktopContext(browser)
  state.context = context
  const page = await context.newPage()
  const consoleLines: string[] = []
  collectConsole(page, consoleLines)

  await loginAs(page, ui, qa.admin.email, "12345678")
  expect(shell.served(), "the desktop CSP header was served on the login document").toBeGreaterThan(
    0,
  )
  const probe = await probePolicy(page)
  // eslint-disable-next-line no-console
  console.log(`[D1] in-page CSP probe: ${JSON.stringify(probe)}`)
  expect(probe.eval, "the page runs under the desktop CSP").toMatch(/^refused/)
  expect(probe.wasm, "WebAssembly under the served policy").toMatch(wasmAllowed)

  await enrolMailboxThroughUi(page, ui)
  // The enrolment helper intercepts the OAuth handoff with `page.route`. The
  // webview intercepts nothing, and while any route is on, Playwright's WebKit
  // cannot boot a module worker from a revoked blob URL: drop it.
  await page.unrouteAll({ behavior: "wait" })
  const wraps = await readWraps(env, qa.admin.id)
  expect(
    wraps.map((row) => row.wrap_type),
    "exactly the mailbox password wrap",
  ).toEqual(["passphrase"])
  expect((wraps[0].kdf_params as { kdf?: string }).kdf).toBe("pbkdf2-sha256")

  // A SEALED message, so reading it needs the keyring this enrolment made.
  const before = await readMessages(env, mailbox.accountId)
  const tag = `d1s${randomUUID().slice(0, 6)}`
  const ingest = await runIngest(env, {
    orgId: world.org.id,
    accountId: mailbox.accountId,
    actor: "system:mail:sync",
    messages: ingestFixtures(tag, 1, mailbox.email),
  })
  expect(ingest.exitCode, `ingest harness failed:\n${ingest.stderr}`).toBe(0)
  expect(ingest.result?.error, "the ingest threw").toBeNull()
  const fresh = (await readMessages(env, mailbox.accountId)).filter(
    (row) => !before.some((old) => old.id === row.id),
  )
  expect(fresh.length, "the ingest wrote one row").toBe(1)
  expect(fresh[0].text_body, "the ingested row is sealed").toBeNull()
  expect(fresh[0].text_body_ciphertext).not.toBeNull()
  state.sealedConversationId = fresh[0].conversation_id as string
  state.sealedPhrase = `zephyrine-${tag}-inbound-0-quillmark`

  // Setup ends with the mailbox OPEN: the wizard unlocks the worker's session
  // with the password just chosen (the PBKDF2 path in WebKit's blob worker
  // under the desktop CSP), and that unlock is what persists the session. So
  // the next load reads sealed mail with NO unlock prompt at all: asking for
  // the password that was just set is the defect this step pins.
  await openMail(page, ui, { landingPrompt: "keep" })
  await openConversationById(page, state.sealedConversationId)
  await expect
    .poll(async () => readRenderedBody(page), {
      timeout: 60_000,
      message: `the sealed body did not render after setup. console:\n${wasmLines(consoleLines).join("\n")}`,
    })
    .toContain(state.sealedPhrase)
  const promptSeen = await page.evaluate(
    () => (window as unknown as { __unlockPromptSeen?: boolean }).__unlockPromptSeen,
  )
  expect(promptSeen, "setup ended locked: the user was asked for the password just set").toBe(false)
  await expect(page.getByTestId("mailbox-locked-notice").filter({ visible: true })).toHaveCount(0)
  // eslint-disable-next-line no-console
  console.log(
    `[D1] after setup, no prompt (seen=${promptSeen}); sealed body rendered: ${(await readRenderedBody(page)).slice(0, 80)}`,
  )
  await page.close()
})

test("D2: after a restart the mailbox is readable with no unlock prompt", async () => {
  test.setTimeout(180_000)
  const context = state.context
  const shell = state.shell
  expect(context, "D2 reuses D1's browser profile").not.toBeNull()
  expect(state.sealedConversationId).not.toBe("")
  if (!context || !shell) return
  const ui = shell.env

  // The same profile (same IndexedDB), a new page, a full load and a reload.
  const page = await context.newPage()
  const consoleLines: string[] = []
  collectConsole(page, consoleLines)
  // Each load settles (the shell is up) before the next: a reload that cancels
  // the boot's token refresh in flight is a different test.
  await page.goto(webUrl(ui, "/"))
  await page.waitForSelector("[data-shell]", { timeout: 60_000 })
  await page.reload()
  await page.waitForSelector("[data-shell]", { timeout: 60_000 })
  expect((await probePolicy(page)).eval, "the page runs under the desktop CSP").toMatch(/^refused/)
  await openMail(page, ui, { landingPrompt: "keep" })
  await openConversationById(page, state.sealedConversationId)
  await expect
    .poll(async () => readRenderedBody(page), {
      timeout: 60_000,
      message: `the sealed body did not render after the restart. console:\n${wasmLines(consoleLines).join("\n")}`,
    })
    .toContain(state.sealedPhrase)
  const promptSeen = await page.evaluate(
    () => (window as unknown as { __unlockPromptSeen?: boolean }).__unlockPromptSeen,
  )
  expect(promptSeen, "the unlock prompt appeared although the unlock lasts until logout").toBe(
    false,
  )
  await expect(page.getByTestId("mailbox-locked-notice").filter({ visible: true })).toHaveCount(0)
  // eslint-disable-next-line no-console
  console.log(
    `[D2] after restart, no prompt (seen=${promptSeen}); body: ${(await readRenderedBody(page)).slice(0, 80)}`,
  )
  await page.close()
})

test("D3: a legacy Argon2id password row unlocks and is re-wrapped under PBKDF2", async ({
  browser,
  env,
  qa,
}) => {
  test.setTimeout(300_000)
  expect(state.sealedConversationId, "D3 reads D1's sealed conversation").not.toBe("")

  // Turn the user's only password row into the pre-PBKDF2 format: the same
  // Account Key, wrapped with the package's real legacy construction.
  const rows = (await env.db.sql.unsafe(
    `SELECT id::text, wrapped_account_key, kdf_params FROM ${ks(env)}.user_key_wraps
      WHERE user_id = $1 AND wrap_type = 'passphrase'`,
    [qa.admin.id],
  )) as Array<{ id: string; wrapped_account_key: Uint8Array; kdf_params: Record<string, unknown> }>
  expect(rows.length, "one password row to convert").toBe(1)
  const current = rows[0]
  const accountKey = await unwrapWithPassphrase({
    wrap: {
      wrapType: "passphrase",
      wrappedAccountKey: new Uint8Array(current.wrapped_account_key),
      kdfParams: {
        salt: new Uint8Array(Buffer.from(String(current.kdf_params.salt), "base64")),
        kdf: current.kdf_params.kdf as "pbkdf2-sha256",
        iterations: current.kdf_params.iterations as number,
      },
    },
    passphrase: TEST_PASSPHRASE,
    userId: qa.admin.id,
  })
  const salt = new Uint8Array(randomBytes(16))
  const legacy = await wrapWithLegacyPassphrase({
    accountKey,
    passphrase: TEST_PASSPHRASE,
    salt,
    userId: qa.admin.id,
  })
  accountKey.fill(0)
  await env.db.sql.unsafe(
    `UPDATE ${ks(env)}.user_key_wraps SET wrapped_account_key = $2, kdf_params = $3::jsonb WHERE id = $1::uuid`,
    [
      current.id,
      Buffer.from(legacy.wrappedAccountKey),
      JSON.stringify({ salt: Buffer.from(salt).toString("base64") }),
    ],
  )
  const legacyWraps = (await readWraps(env, qa.admin.id)).filter(
    (row) => row.wrap_type === "passphrase",
  )
  expect(legacyWraps.length).toBe(1)
  expect(
    (legacyWraps[0].kdf_params as { kdf?: string }).kdf,
    "the only password row is legacy",
  ).toBeUndefined()

  // A new profile: nothing persisted, so the unlock is load-bearing.
  const shell = state.shell
  expect(shell, "D3 runs behind D1's desktop shell").not.toBeNull()
  if (!shell) return
  const ui = shell.env
  const context = await newDesktopContext(browser)
  const consoleLines: string[] = []
  try {
    const page = await context.newPage()
    collectConsole(page, consoleLines)
    const servedBefore = shell.served()
    await loginAs(page, ui, qa.admin.email, "12345678")
    expect(shell.served(), "the desktop CSP header was served").toBeGreaterThan(servedBefore)
    const probe = await probePolicy(page)
    expect(probe.eval, "the page runs under the desktop CSP").toMatch(/^refused/)
    expect(probe.wasm, "WebAssembly under the served policy").toMatch(wasmAllowed)
    // eslint-disable-next-line no-console
    console.log(`[D3] served CSP script-src: ${/script-src[^;]*/.exec(shell.csp)?.[0]}`)
    // A locked mailbox hides its sealed rows behind the Unlock panel.
    await openMail(page, ui)
    await page.getByTestId("mailbox-locked-notice.unlock").filter({ visible: true }).first().click()
    await unlockMailboxThroughUi(page, "passphrase", TEST_PASSPHRASE)
    const refusal = page.getByTestId("mailbox-unlock.refusal")
    if (await refusal.isVisible().catch(() => false)) {
      throw new Error(
        `the legacy unlock was refused: "${await refusal.innerText()}"\nconsole:\n${wasmLines(consoleLines).join("\n")}`,
      )
    }
    await expect(page.getByTestId("mailbox-unlock-host")).toBeHidden({ timeout: 120_000 })
    await openConversationById(page, state.sealedConversationId)
    await expect
      .poll(async () => readRenderedBody(page), {
        timeout: 60_000,
        message: `the legacy password did not open the mailbox. console:\n${wasmLines(consoleLines).join("\n")}`,
      })
      .toContain(state.sealedPhrase)

    // The silent migration: the legacy row is replaced by a PBKDF2 row.
    await expect
      .poll(
        async () =>
          (await readWraps(env, qa.admin.id))
            .filter((row) => row.wrap_type === "passphrase")
            .map((row) => ({
              legacyRow: row.id === current.id,
              kdf: (row.kdf_params as { kdf?: string }).kdf ?? null,
              iterations: (row.kdf_params as { iterations?: number }).iterations ?? null,
            })),
        { timeout: 60_000, message: "the legacy row was not re-wrapped under PBKDF2" },
      )
      .toEqual([{ legacyRow: false, kdf: "pbkdf2-sha256", iterations: 600_000 }])
    // eslint-disable-next-line no-console
    console.log(
      `[D3] legacy unlock read: ${(await readRenderedBody(page)).slice(0, 80)}; wraps now: ${JSON.stringify(
        (await readWraps(env, qa.admin.id)).map((row) => ({
          type: row.wrap_type,
          kdf: row.kdf_params,
        })),
      ).replace(/"salt":"[^"]*",?/g, "")}`,
    )
  } finally {
    await context.close()
  }
})
