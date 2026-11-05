// SPDX-License-Identifier: FSL-1.1-ALv2
//
// DESKTOP controller: a debug build of apps/desktop (dev-signed, F7), launched
// with the DOM driver armed (`LIAISON_DEBUG_DRIVER`, driver.rs) and the
// background window mode (`LIAISON_DEBUG_BACKGROUND=1`, no focus steal).
//
// The driver evaluates `<id>.js` dropped in the directory and answers
// `<id>.json`. The matrix reaches the shell's debug-only commands (A2, T6:
// `hide_to_tray`, `show_window`, `set_reported_notification_permission`)
// from such a script through the page's Tauri invoke, and moves the route
// (A2: "on the thread" is the route, not focus) with the router's own history.
// Quit and kill are process control.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Config } from "../config"
import type { DesktopState, SurfaceStates } from "../types"
import { type CaseThreads, run, type SurfaceController, sleep, until } from "./common"

/** Presence of a closed connection goes at once; a killed one lingers (A6). */
const AFTER_QUIT_MS = 3000

export const DESKTOP_COMMANDS = {
  hideToTray: "hide_to_tray",
  showWindow: "show_window",
  setPermission: "set_reported_notification_permission",
} as const

/** The driver script that calls one shell command and answers its result. */
export function invokeScript(command: string, args: Record<string, unknown> = {}): string {
  return `const t = window.__TAURI_INTERNALS__;
if (!t || typeof t.invoke !== "function") throw new Error("no Tauri invoke in this page");
return await t.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)});`
}

/** The driver script that moves the route without reloading the page. */
export function routeScript(path: string): string {
  return `history.pushState(null, "", ${JSON.stringify(path)});
window.dispatchEvent(new PopStateEvent("popstate"));
await new Promise((r) => setTimeout(r, 1500));
return location.pathname;`
}

export class DesktopController implements SurfaceController {
  readonly name = "desktop" as const
  private exe: string | null = null
  private state: DesktopState | null = null
  private seq = 0

  constructor(private readonly cfg: Config["desktop"]) {}

  private async executable(): Promise<string> {
    if (this.exe) return this.exe
    if (!this.cfg.appPath) throw new Error("MATRIX_DESKTOP_APP is not set")
    const name = (
      await run([
        "defaults",
        "read",
        join(this.cfg.appPath, "Contents", "Info"),
        "CFBundleExecutable",
      ])
    ).stdout.trim()
    this.exe = join(this.cfg.appPath, "Contents", "MacOS", name)
    return this.exe
  }

  private async running(): Promise<boolean> {
    const exe = await this.executable()
    return (await run(["pgrep", "-f", exe], { allowFail: true })).code === 0
  }

  /** Evaluate a script in the main window through the debug driver. */
  async exec(source: string, timeoutMs = 20_000): Promise<unknown> {
    this.seq += 1
    const id = `m${Date.now()}_${this.seq}`
    const js = join(this.cfg.driverDir, `${id}.js`)
    const out = join(this.cfg.driverDir, `${id}.json`)
    writeFileSync(js, source)
    try {
      const answer = await until(
        async () => (existsSync(out) ? readFileSync(out, "utf8") : null),
        timeoutMs,
        250,
      )
      if (!answer) throw new Error(`desktop driver: no answer to ${id} in ${timeoutMs} ms`)
      const parsed = JSON.parse(answer) as { ok: boolean; value: unknown }
      if (!parsed.ok) throw new Error(`desktop driver: ${String(parsed.value)}`)
      return parsed.value
    } finally {
      for (const f of [js, out, join(this.cfg.driverDir, `${id}.req`)]) rmSync(f, { force: true })
    }
  }

  async launch(): Promise<void> {
    if (await this.running()) return
    mkdirSync(this.cfg.driverDir, { recursive: true })
    const exe = await this.executable()
    const child = Bun.spawn([exe], {
      stdout: "ignore",
      stderr: "ignore",
      env: {
        ...process.env,
        LIAISON_DEBUG_DRIVER: this.cfg.driverDir,
        LIAISON_DEBUG_BACKGROUND: "1",
      },
    })
    // The app outlives this runner: a later run finds it already up.
    child.unref()
    const ready = await until(
      async () =>
        (await this.exec("return !!document.querySelector('[data-shell-ready]')", 5000)) === true,
      90_000,
      2000,
    )
    if (!ready) {
      throw new Error(
        "the desktop app did not reach a signed-in shell: sign it in once as the recipient (README, desktop)",
      )
    }
    // The hello carries the permission; give the socket a moment.
    await sleep(2000)
  }

  async setup(): Promise<void> {
    await this.launch()
  }

  private async quit(): Promise<void> {
    if (!(await this.running())) return
    await run(["osascript", "-e", `tell application id "${this.cfg.bundleId}" to quit`], {
      allowFail: true,
      timeoutMs: 15_000,
    })
    const gone = await until(async () => !(await this.running()), 15_000)
    if (!gone) await run(["pkill", "-TERM", "-f", await this.executable()], { allowFail: true })
    await sleep(AFTER_QUIT_MS)
  }

  private async kill(): Promise<void> {
    await this.launch()
    await run(["pkill", "-KILL", "-f", await this.executable()], { allowFail: true })
    await sleep(500)
  }

  async apply(states: SurfaceStates, threads: CaseThreads): Promise<void> {
    const next = states.desktop
    if (!next) return
    const prev = this.state
    if (next === "quit") await this.quit()
    else if (next === "killed") await this.kill()
    else {
      await this.launch()
      if (prev === "tray" && next !== "tray")
        await this.exec(invokeScript(DESKTOP_COMMANDS.showWindow))
      if (prev === "permission_denied" && next !== "permission_denied") {
        await this.exec(invokeScript(DESKTOP_COMMANDS.setPermission, { permission: "granted" }))
      }
      if (next === "on_thread") await this.exec(routeScript(`/threads/${threads.dm}`))
      else await this.exec(routeScript("/"))
      if (next === "tray") await this.exec(invokeScript(DESKTOP_COMMANDS.hideToTray))
      if (next === "permission_denied") {
        await this.exec(invokeScript(DESKTOP_COMMANDS.setPermission, { permission: "denied" }))
      }
      await sleep(1500)
    }
    this.state = next
  }

  receivedIsShown(): boolean {
    return false
  }

  pinnedDevices(): Record<string, string[]> {
    return {}
  }

  async teardown(): Promise<void> {
    // Leave it running and visible, permission as the OS says.
    if (this.state === "tray")
      await this.exec(invokeScript(DESKTOP_COMMANDS.showWindow)).catch(() => {})
    if (this.state === "permission_denied") {
      await this.exec(
        invokeScript(DESKTOP_COMMANDS.setPermission, { permission: "granted" }),
      ).catch(() => {})
    }
  }
}
