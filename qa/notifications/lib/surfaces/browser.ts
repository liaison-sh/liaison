// SPDX-License-Identifier: FSL-1.1-ALv2
//
// BROWSER controller: the installed Google Chrome (branded `chrome` channel)
// on a persistent profile, through Playwright, with notifications granted and
// the service worker subscribed to Web Push (T4).
//
// Playwright's default flags include --disable-background-networking, which
// cuts Chrome's push channel; it is dropped. If Chrome under Playwright still
// cannot hold a push subscription, the controller falls back to the spec's
// CDP route: Chrome started by hand on the same profile with a debugging
// port, and Playwright attached over CDP (spec-push.md "Fallbacks").

import { mkdirSync } from "node:fs"
import type { BrowserContext, Page } from "playwright"
import type { ApiClient } from "../api"
import type { Config, Credentials } from "../config"
import type { BrowserState, SurfaceStates } from "../types"
import { type CaseThreads, type SurfaceController, sleep, until } from "./common"

const DEVICE_ID_KEY = "liaison:deviceId"
const SETTLE_MS = 3000

/** The login page's controls, by test id: their words change with the browser's language. */
export const LOGIN_SELECTORS = {
  /** A demo box's /login is the visitor front page: its own email field starts a demo, not a sign-in. */
  demoSignInInstead: '[data-testid="demo-sign-in-instead"]',
  passwordToggle: '[data-testid="password-login-toggle"]',
  passwordSubmit: '[data-testid="password-login-submit"]',
} as const

/** Whether the server lists this browser device with a Web Push subscription. */
export function serverHoldsPush(
  devices: Array<{ deviceId: string; surface: string; detail?: unknown }>,
  deviceId: string | null,
): boolean {
  if (!deviceId) return false
  return devices.some(
    (d) =>
      d.deviceId === deviceId &&
      d.surface === "browser" &&
      (d.detail as { webPush?: boolean } | undefined)?.webPush === true,
  )
}

export class BrowserController implements SurfaceController {
  readonly name = "web" as const
  private context: BrowserContext | null = null
  private chrome: ReturnType<typeof Bun.spawn> | null = null
  private deviceId: string | null = null
  private registered = false
  private blank: Page | null = null
  private readonly unemulated = new WeakSet<Page>()
  private notes: string[] = []
  mode: "playwright" | "cdp" = "playwright"

  constructor(
    private readonly cfg: Config["web"],
    private readonly webUrl: string,
    private readonly creds: Credentials,
    private readonly recipient: ApiClient,
  ) {}

  private async open(mode: "playwright" | "cdp"): Promise<void> {
    const { chromium } = await import("playwright")
    mkdirSync(this.cfg.profileDir, { recursive: true })
    if (mode === "playwright") {
      this.context = await chromium.launchPersistentContext(this.cfg.profileDir, {
        channel: "chrome",
        headless: false,
        ignoreDefaultArgs: ["--disable-background-networking"],
        viewport: { width: 1280, height: 800 },
      })
    } else {
      this.chrome = Bun.spawn(
        [
          this.cfg.chromePath,
          `--user-data-dir=${this.cfg.profileDir}`,
          `--remote-debugging-port=${this.cfg.cdpPort}`,
          "--no-first-run",
          "--no-default-browser-check",
          "about:blank",
        ],
        { stdout: "ignore", stderr: "ignore" },
      )
      const browser = await until(
        async () => chromium.connectOverCDP(`http://127.0.0.1:${this.cfg.cdpPort}`),
        20_000,
        500,
      )
      if (!browser) throw new Error("Chrome did not open its debugging port")
      const ctx = browser.contexts()[0]
      if (!ctx) throw new Error("Chrome over CDP has no default context")
      this.context = ctx
    }
    this.mode = mode
    const origin = new URL(this.webUrl).origin
    await this.context.grantPermissions(["notifications"], { origin })
  }

  private async close(): Promise<void> {
    await this.context?.close().catch(() => {})
    this.context = null
    this.chrome?.kill()
    this.chrome = null
  }

  private ctx(): BrowserContext {
    if (!this.context) throw new Error("browser not open")
    return this.context
  }

  private appPages(): Page[] {
    const origin = new URL(this.webUrl).origin
    return this.ctx()
      .pages()
      .filter((p) => p.url().startsWith(origin))
  }

  /** One Liaison tab, signed in, on `path`. */
  private async appPage(path = "/"): Promise<Page> {
    let page = this.appPages()[0]
    if (!page) page = await this.ctx().newPage()
    await this.realVisibility(page)
    await page.goto(`${this.webUrl}${path}`, { waitUntil: "domcontentloaded" })
    const shell = await page
      .waitForSelector("[data-shell]", { timeout: 15_000 })
      .then(() => true)
      .catch(() => false)
    if (!shell) {
      await this.signIn(page)
      await page.goto(`${this.webUrl}${path}`, { waitUntil: "domcontentloaded" })
      await page.waitForSelector("[data-shell]", { timeout: 30_000 })
    }
    this.deviceId =
      (await page.evaluate((k) => localStorage.getItem(k), DEVICE_ID_KEY)) ?? this.deviceId
    return page
  }

  /**
   * Playwright emulates focus, so every page reads `visible` even behind
   * another tab; a background tab must be a real hidden one (M2, A6).
   */
  private async realVisibility(page: Page): Promise<void> {
    if (this.unemulated.has(page)) return
    this.unemulated.add(page)
    const cdp = await this.ctx()
      .newCDPSession(page)
      .catch(() => null)
    await cdp?.send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {})
  }

  private async signIn(page: Page): Promise<void> {
    await page.goto(`${this.webUrl}/login`, { waitUntil: "domcontentloaded" })
    await page
      .locator(`${LOGIN_SELECTORS.demoSignInInstead}, ${LOGIN_SELECTORS.passwordToggle}`)
      .first()
      .waitFor({ timeout: 20_000 })
      .catch(() => {})
    const demoEntry = page.locator(LOGIN_SELECTORS.demoSignInInstead).first()
    if (await demoEntry.isVisible().catch(() => false)) await demoEntry.click()
    const email = page.locator('input[type="email"]').first()
    await email.waitFor({ timeout: 20_000 })
    await email.fill(this.creds.email)
    const password = page.locator('input[type="password"]').first()
    if (!(await password.isVisible().catch(() => false))) {
      const toggle = page.locator(LOGIN_SELECTORS.passwordToggle).first()
      await toggle.waitFor({ timeout: 10_000 }).catch(() => {})
      if (await toggle.isVisible().catch(() => false)) await toggle.click()
    }
    await password.waitFor({ timeout: 10_000 })
    await password.fill(this.creds.password)
    const submit = page.locator(LOGIN_SELECTORS.passwordSubmit)
    if (await submit.isVisible().catch(() => false)) await submit.click()
    else await password.press("Enter")
    await page.waitForSelector("[data-shell]", { timeout: 30_000 })
  }

  /** Settings > Notifications > browser notifications on (T7w), then check the SW. */
  private async register(): Promise<boolean> {
    const page = await this.appPage("/settings/notifications")
    this.deviceId =
      (await page.evaluate((k) => localStorage.getItem(k), DEVICE_ID_KEY)) ?? this.deviceId
    // Offered only while the SERVER does not list this browser with Web Push.
    // isVisible() does not wait, so the button is waited for, then clicked.
    if (!serverHoldsPush(await this.recipient.devices(), this.deviceId)) {
      const enable = page.locator('[data-testid="notif-browser-enable"]')
      if (
        await enable.waitFor({ state: "visible", timeout: 15_000 }).then(
          () => true,
          () => false,
        )
      ) {
        await enable.click()
        await page
          .waitForSelector('[data-testid="notif-browser-result"]', { timeout: 20_000 })
          .catch(() => {})
      }
    }
    const subscribed = await until(async () => {
      // A string: this file is typechecked without the DOM library.
      const local = await page.evaluate<boolean>(`(async () => {
          const reg = await navigator.serviceWorker?.getRegistration()
          return !!(await reg?.pushManager.getSubscription())
        })()`)
      return local && serverHoldsPush(await this.recipient.devices(), this.deviceId)
    }, 20_000)
    this.registered = !!subscribed
    return this.registered
  }

  async setup(): Promise<void> {
    const modes: Array<"playwright" | "cdp"> =
      this.cfg.mode === "auto" ? ["playwright", "cdp"] : [this.cfg.mode]
    const failures: string[] = []
    for (const mode of modes) {
      try {
        await this.open(mode)
        if (await this.register()) return
        failures.push(`${mode}: no Web Push subscription after enabling`)
      } catch (err) {
        failures.push(`${mode}: ${(err as Error).message}`)
      }
      await this.close()
    }
    throw new Error(
      `Chrome could not hold a Web Push subscription (${failures.join("; ")}); the browser cells go to the QA board as human cells`,
    )
  }

  /**
   * A real background tab: a tab opened from the page itself lands in the same
   * window and covers it (a Playwright `newPage` may get its own window, which
   * leaves ours visible). Checked, because the M2/A6 cells depend on it.
   */
  private async hideBehindTab(page: Page): Promise<void> {
    const [cover] = await Promise.all([
      this.ctx().waitForEvent("page", { timeout: 10_000 }),
      page.evaluate(`window.open("about:blank", "_blank")`),
    ])
    await cover.bringToFront()
    await this.realVisibility(cover)
    const hidden = await until(
      async () => (await page.evaluate<string>("document.visibilityState")) === "hidden",
      5000,
      250,
    )
    // Seen on the Minimac (display asleep or remote): Chrome reports every tab
    // visible, even minimized. A case on Home does not depend on it, so the
    // cell still runs and the report says what the tab really was.
    if (!hidden) this.notes.push("background tab: Chrome still reported it visible")
  }

  private async blankFront(): Promise<void> {
    if (!this.blank || this.blank.isClosed()) this.blank = await this.ctx().newPage()
    await this.blank.bringToFront()
  }

  async apply(states: SurfaceStates, threads: CaseThreads): Promise<void> {
    const next: BrowserState | undefined = states.browser
    if (!next) return
    if (next !== "unregistered" && !this.registered) await this.register()
    switch (next) {
      case "focused_elsewhere":
        await (await this.appPage("/")).bringToFront()
        break
      case "on_thread":
        await (await this.appPage(`/threads/${threads.dm}`)).bringToFront()
        break
      case "background_tab":
        await this.hideBehindTab(await this.appPage("/"))
        break
      case "no_tab":
      case "unregistered":
        await this.blankFront()
        for (const p of this.appPages()) await p.close()
        if (next === "unregistered" && this.deviceId) {
          await this.recipient.deleteBrowserDevice(this.deviceId).catch(() => {})
          this.registered = false
        }
        break
    }
    await sleep(SETTLE_MS)
  }

  takeNotes(): string[] {
    const out = this.notes
    this.notes = []
    return out
  }

  receivedIsShown(): boolean {
    return false
  }

  pinnedDevices(): Record<string, string[]> {
    return this.deviceId ? { browser_tab: [this.deviceId], browser_push: [this.deviceId] } : {}
  }

  async teardown(): Promise<void> {
    if (!this.registered) await this.register().catch(() => {})
    // A Chrome started by hand for CDP goes with it.
    await this.close()
  }
}
