// SPDX-License-Identifier: FSL-1.1-ALv2
//
// iOS SIMULATOR controller (D16), through `xcrun simctl`. Real APNs sandbox
// pushes reach the simulator on Apple silicon (spike T0); the NSE posts
// `received`, the app posts the final outcome (T5).
//
// Pitfalls carried over from validation/push/spike-T0.md and T5-local.md:
//  - `simctl launch --stdout=<file on an external volume>` fails the launch;
//    logs are read with `log show` instead.
//  - The notification prompt cannot be pre-granted with `simctl privacy`: a
//    fresh install needs a synthetic tap on "Allow" (MATRIX_IOS_ALLOW_CMD) or
//    a one-time manual grant, which survives reinstalls of the same bundle.
//  - Sign-in is seeded: an app-origin login's refresh token and the server
//    address go into the app's Preferences, which the shell migrates.

import type { ApiClient } from "../api"
import type { Config } from "../config"
import type { DeviceCheck, IosState, SurfaceStates } from "../types"
import {
  CapabilityGap,
  type CaseThreads,
  type DeviceCheckResult,
  run,
  type SurfaceController,
  sleep,
  until,
  waitForDevice,
} from "./common"

const SETTLE_MS = 4000

/**
 * The commands that sign a freshly installed app in: its refresh token and
 * server address, written through the SIMULATOR's defaults. A write to the
 * plist from the host is overridden by the simulator's cfprefsd cache.
 */
export function seedSessionCommands(
  simulator: string,
  bundleId: string,
  refreshToken: string,
  baseUrl: string,
): string[][] {
  const write = (key: string, value: string) => [
    "xcrun",
    "simctl",
    "spawn",
    simulator,
    "defaults",
    "write",
    bundleId,
    key,
    value,
  ]
  return [
    write("CapacitorStorage.liaison.refreshToken", refreshToken),
    write("CapacitorStorage.liaison.serverAddress", baseUrl),
  ]
}

/**
 * The command that empties what a previous install left in the simulator's
 * defaults. `simctl uninstall` does not: the seeded keys are written through
 * `simctl spawn defaults`, which the simulator keeps across an uninstall, so a
 * "fresh" install still started bound to the last run's server with the last
 * run's (long rotated) refresh token. Allowed to fail: a clean domain is the
 * goal and "does not exist" is that.
 */
export function clearDefaultsCommand(simulator: string, bundleId: string): string[] {
  return ["xcrun", "simctl", "spawn", simulator, "defaults", "delete", bundleId]
}

/** The CoreGraphics tap helper beside this file (sim-tap.swift). */
export const SIM_TAP_SCRIPT = new URL("./sim-tap.swift", import.meta.url).pathname

/**
 * Where "Allow" sits on the notification permission prompt, as fractions of
 * the device screen (iPhone 17, iOS 26.3: measured 2026-10-07).
 */
export const ALLOW_BUTTON = { x: 0.69, y: 0.592 } as const

/**
 * The command that taps "Allow" on the simulator's notification prompt: a
 * CoreGraphics click on the Simulator window (`simctl privacy` has no
 * notifications service, and an osascript System Events click hangs). An
 * uninstall resets the grant, so every fresh install needs it, and nobody is
 * there to tap it by hand.
 */
export function grantNotificationsCommand(at: { x: number; y: number } = ALLOW_BUTTON): string[] {
  return ["swift", SIM_TAP_SCRIPT, String(at.x), String(at.y)]
}

/** Taps "Allow" on the simulator's notification prompt (see the command above). */
export async function grantNotificationsOnSimulator(
  at: { x: number; y: number } = ALLOW_BUTTON,
): Promise<void> {
  await run(grantNotificationsCommand(at), { allowFail: true, timeoutMs: 60_000 })
}

export class IosSimulatorController implements SurfaceController {
  readonly name = "ios" as const
  private state: IosState | null = null
  private token: string | null = null

  constructor(
    private readonly cfg: Config["ios"],
    private readonly recipient: ApiClient,
    private readonly baseUrl: string,
  ) {}

  private simctl(args: string[], env: Record<string, string> = {}, allowFail = false) {
    return run(["xcrun", "simctl", ...args], { env, allowFail, timeoutMs: 120_000 })
  }

  async setup(): Promise<void> {
    await this.simctl(["boot", this.cfg.simulator], {}, true) // already booted is fine
    const installed = await this.simctl(
      ["get_app_container", this.cfg.simulator, this.cfg.bundleId],
      {},
      true,
    )
    if (installed.code !== 0) {
      if (!this.cfg.appPath) {
        throw new Error(
          `${this.cfg.bundleId} is not installed on simulator ${this.cfg.simulator}; set MATRIX_IOS_APP to a Debug-iphonesimulator App.app`,
        )
      }
      await this.freshInstall()
    }
    await this.launch()
    const has = await until(async () => {
      const list = await this.recipient.devices()
      return list.some((d) => d.surface === "ios")
    }, 30_000)
    if (!has) {
      throw new Error(
        "the recipient has no iOS device: sign the simulator app in (README, iOS) and allow notifications once",
      )
    }
    this.token = await this.readToken()
  }

  /** Launch (or bring to front) with the debug hooks the matrix reads. */
  private async launch(extra: Record<string, string> = {}): Promise<void> {
    await this.simctl(["launch", this.cfg.simulator, this.cfg.bundleId], {
      SIMCTL_CHILD_LIAISON_DEBUG_SELF_REGISTER_PUSH: "1",
      ...extra,
    })
    await sleep(SETTLE_MS)
  }

  private async terminate(): Promise<void> {
    await this.simctl(["terminate", this.cfg.simulator, this.cfg.bundleId], {}, true)
    await sleep(1000)
  }

  private async toBackground(): Promise<void> {
    await this.simctl(["launch", this.cfg.simulator, this.cfg.backgroundApp])
    await sleep(2000)
  }

  /** The APNs token the debug hook logs at launch (AppDelegate, DEBUG only). */
  private async readToken(): Promise<string | null> {
    const r = await this.simctl(
      [
        "spawn",
        this.cfg.simulator,
        "log",
        "show",
        "--last",
        "10m",
        "--style",
        "compact",
        "--predicate",
        'eventMessage CONTAINS "LIAISON_DEBUG_PUSH token="',
      ],
      {},
      true,
    )
    const matches = [...r.stdout.matchAll(/LIAISON_DEBUG_PUSH token=([0-9a-f]+)/g)]
    return matches.length > 0 ? (matches[matches.length - 1]?.[1] ?? null) : null
  }

  async apply(states: SurfaceStates, threads: CaseThreads): Promise<void> {
    const next = states.ios
    if (!next) return
    switch (next) {
      case "foreground_other":
        // A cold start lands on Home, never on a conversation.
        await this.terminate()
        await this.launch()
        break
      case "foreground_thread":
        if (!this.cfg.openRouteHook) {
          throw new CapabilityGap(
            "no way to open a thread on the simulator from the runner: the build needs the LIAISON_DEBUG_OPEN_ROUTE launch hook (MATRIX_IOS_OPEN_ROUTE=1), or run this cell with --await-human",
          )
        }
        await this.terminate()
        await this.launch({ SIMCTL_CHILD_LIAISON_DEBUG_OPEN_ROUTE: `/threads/${threads.dm}` })
        break
      case "background":
        if (this.state !== "foreground_other" && this.state !== "foreground_thread") {
          await this.launch()
        }
        await this.toBackground()
        break
      case "killed":
        await this.terminate()
        await this.toBackground()
        break
    }
    this.state = next
  }

  receivedIsShown(states: SurfaceStates): boolean {
    return states.ios === "background" || states.ios === "killed"
  }

  pinnedDevices(): Record<string, string[]> {
    return {}
  }

  async deviceCheck(check: DeviceCheck, recipient: ApiClient): Promise<DeviceCheckResult> {
    const since = Date.now()
    switch (check.action) {
      case "fresh_install":
        await this.freshInstall()
        await this.launch()
        await this.tapAllow()
        break
      case "fail_next_register": {
        await this.invalidateServerSide()
        await this.terminate()
        await this.launch({ SIMCTL_CHILD_LIAISON_DEBUG_FAIL_NEXT_REGISTER: "1" })
        break
      }
      case "invalidate_token":
        await this.invalidateServerSide()
        await this.toBackground()
        await this.launch()
        break
    }
    const result = await waitForDevice(recipient, "ios", since, check.withinMs)
    this.state = "foreground_other"
    this.token = (await this.readToken()) ?? this.token
    return result
  }

  /** What APNs answering 410 does on the server: the token row goes. */
  private async invalidateServerSide(): Promise<void> {
    this.token = (await this.readToken()) ?? this.token
    if (!this.token) {
      throw new Error("no APNs token in the simulator log: launch once with the debug hook")
    }
    await this.recipient.deleteIosToken(this.token)
  }

  private async tapAllow(): Promise<void> {
    await sleep(3000)
    // An uninstall resets the grant: without a tap the prompt waits for a human.
    if (this.cfg.allowCmd) await run(["/bin/sh", "-c", this.cfg.allowCmd], { allowFail: true })
    else await grantNotificationsOnSimulator()
  }

  /** Uninstall, install, and seed a signed-in session (T5-local.md). */
  private async freshInstall(): Promise<void> {
    if (!this.cfg.appPath) throw new CapabilityGap("MATRIX_IOS_APP is not set (fresh install)")
    await this.simctl(["uninstall", this.cfg.simulator, this.cfg.bundleId], {}, true)
    await run(clearDefaultsCommand(this.cfg.simulator, this.cfg.bundleId), { allowFail: true })
    await this.simctl(["install", this.cfg.simulator, this.cfg.appPath])
    const { refreshToken } = await this.recipient.login({ Origin: "capacitor://localhost" })
    if (!refreshToken) throw new Error("the app-origin login answered no refresh token")
    for (const cmd of seedSessionCommands(
      this.cfg.simulator,
      this.cfg.bundleId,
      refreshToken,
      this.baseUrl,
    )) {
      await run(cmd)
    }
  }

  async teardown(): Promise<void> {
    // The app stays installed and signed in for the next run.
  }
}
