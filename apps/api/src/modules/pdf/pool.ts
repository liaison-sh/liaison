// SPDX-License-Identifier: FSL-1.1-ALv2
//
// PDF render pool. Tracks in-flight renders per-org and per-app, enforces
// concurrency caps, and applies a hard deadline. The template runs in the
// QuickJS app sandbox (no host code execution — see ./sandbox-render.ts) and
// its emitted draw-command list is replayed against pdf-lib on the host. The
// per-org / per-app caps + 30s deadline this pool enforces are the only
// guarantees the rest of the system relies on.

import { runLimits } from "~/modules/apps/run-limits"
import type { ReplayDrawCommandsOptions } from "./replay"
import { runTemplateToPdf } from "./sandbox-render"

export const MAX_INFLIGHT_PER_ORG = 10
// Phase 17 fix C6 — spec §K2 caps concurrent renders at 5 per app (default).
// The previous value (50) was 10x the spec — relaxing the rate-limit by an
// order of magnitude. The per-org cap (10) is unchanged.
export const MAX_INFLIGHT_PER_APP = 5
export const DEFAULT_DEADLINE_MS = runLimits("pdf-template").wallMs

const inflightPerOrg = new Map<string, number>()
const inflightPerApp = new Map<string, number>()

export class PdfRenderError extends Error {
  readonly code: PdfRenderErrorCode
  constructor(code: PdfRenderErrorCode, message?: string) {
    super(message ?? code)
    this.code = code
    this.name = "PdfRenderError"
  }
}

export type PdfRenderErrorCode =
  | "render_overloaded"
  | "render_failed"
  | "render_timeout"
  | "template_not_found"
  // The calling app is turned Off for the org (S19): its templates render nothing.
  | "app_disabled"
  | "output_too_large"

function bump(map: Map<string, number>, k: string): void {
  map.set(k, (map.get(k) ?? 0) + 1)
}

function drop(map: Map<string, number>, k: string): void {
  const next = (map.get(k) ?? 0) - 1
  if (next <= 0) map.delete(k)
  else map.set(k, next)
}

export interface EnqueueArgs {
  orgId: string
  appId: string
  /** Sandbox-executable template bundle text (sets `globalThis.renderTemplate`). */
  source: string
  data: unknown
  deadlineMs?: number
  /** Forwarded to `replayDrawCommands` — resolves `embedImage` file ids. */
  replay?: ReplayDrawCommandsOptions
  /** The asking app run's execution token (sandbox-render.ts). */
  nestedParentKey?: string
}

/**
 * Run a template source under the pool's concurrency guards.
 *
 * Throws `PdfRenderError("render_overloaded")` if the per-org or per-app
 * in-flight cap is already at its limit (no queue — callers are expected
 * to back off or retry).
 */
export async function enqueue(args: EnqueueArgs): Promise<Uint8Array> {
  const { orgId, appId, source, data } = args
  const deadline = args.deadlineMs ?? DEFAULT_DEADLINE_MS

  if ((inflightPerOrg.get(orgId) ?? 0) >= MAX_INFLIGHT_PER_ORG) {
    throw new PdfRenderError("render_overloaded", "org inflight cap exceeded")
  }
  if ((inflightPerApp.get(appId) ?? 0) >= MAX_INFLIGHT_PER_APP) {
    throw new PdfRenderError("render_overloaded", "app inflight cap exceeded")
  }

  bump(inflightPerOrg, orgId)
  bump(inflightPerApp, appId)
  try {
    const work = runTemplateToPdf({
      orgId,
      appName: appId,
      bundleSource: source,
      data,
      replay: args.replay,
      ...(args.nestedParentKey ? { nestedParentKey: args.nestedParentKey } : {}),
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new PdfRenderError("render_timeout", "render exceeded deadline")),
        deadline,
      )
    })
    try {
      const bytes = await Promise.race([work, timeout])
      return bytes
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch (err) {
    if (err instanceof PdfRenderError) throw err
    throw new PdfRenderError("render_failed", (err as Error)?.message ?? String(err))
  } finally {
    drop(inflightPerOrg, orgId)
    drop(inflightPerApp, appId)
  }
}
