// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What every surface controller offers the runner, and the small process
// helpers they share.

import type { ApiClient } from "../api"
import type { Controller, DeviceCheck, SurfaceStates } from "../types"

export interface CaseThreads {
  /** The sender <-> recipient 1:1 room (DMs). */
  dm: string
  /** The titled room (replies, @mentions, mute). */
  group: string
}

export interface DeviceCheckResult {
  ok: boolean
  detail: string
  evidence: string[]
}

export interface SurfaceController {
  readonly name: Controller
  /** Launch, sign in, register; throws with what is missing. */
  setup(): Promise<void>
  apply(states: SurfaceStates, threads: CaseThreads): Promise<void>
  /** A3: `received` from this state counts as shown. */
  receivedIsShown(states: SurfaceStates): boolean
  /** The runner's own device ids per surface, to pin receipts to. */
  pinnedDevices(): Record<string, string[]>
  deviceCheck?(check: DeviceCheck, recipient: ApiClient): Promise<DeviceCheckResult>
  /** What the last `apply` could not make exactly true, for the report. */
  takeNotes?(): string[]
  teardown(): Promise<void>
}

/** A state the controller cannot reach on this build or machine. Not a defect. */
export class CapabilityGap extends Error {}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export async function run(
  cmd: string[],
  opts: { env?: Record<string, string>; timeoutMs?: number; allowFail?: boolean } = {},
): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(opts.env ?? {}) },
  })
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 60_000)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  if (code !== 0 && !opts.allowFail) {
    throw new Error(`${cmd.join(" ")} exited ${code}: ${stderr.trim() || stdout.trim()}`)
  }
  return { code, stdout, stderr }
}

/** Polls `fn` until it answers truthy or the time is up. */
export async function until<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  everyMs = 1000,
): Promise<T | null> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() >= end) return null
    await sleep(everyMs)
  }
}

/**
 * M5: wait for a device of `surface` registered (or seen) after `since` in the
 * recipient's device list (S3), which is what Settings shows.
 */
export async function waitForDevice(
  recipient: ApiClient,
  surface: string,
  since: number,
  withinMs: number,
): Promise<DeviceCheckResult> {
  const started = Date.now()
  const hit = await until(
    async () => {
      const list = await recipient.devices()
      return (
        list.find(
          (d) =>
            d.surface === surface &&
            typeof d.lastSeenAt === "string" &&
            Date.parse(d.lastSeenAt) >= since - 2000,
        ) ?? null
      )
    },
    withinMs,
    2000,
  )
  const secs = Math.round((Date.now() - started) / 1000)
  return hit
    ? {
        ok: true,
        detail: `${surface} device ${hit.deviceId} in the list after ${secs}s`,
        evidence: [`device:${hit.deviceId}`],
      }
    : { ok: false, detail: `no ${surface} device registered within ${secs}s`, evidence: [] }
}
