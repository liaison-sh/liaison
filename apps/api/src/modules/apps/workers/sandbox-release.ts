// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The app's half of the release handshake with the instance's sandbox service
// (@liaison/sandbox-supervisor release.ts): both come from one image, so the
// sandbox container must be recreated with the app after an upgrade. Every
// request to the service carries this process's release; the service refuses
// one of another release (409 `sandbox_release_mismatch`, a run then fails
// with that message) and its own health check turns unhealthy.
//
//   probeSandbox    the `sandbox` dependency of /healthz (only when the
//                   service is configured): ok (same release, and the service
//                   reaches this process's bridge-only listener),
//                   release_mismatch, bridge_unreachable, error or timeout
//   checkSandboxAtBoot  one probe at start; a mismatch or an unreachable
//                   service is logged as an error, naming the fix

import {
  RELEASE_HEADER,
  RELEASE_MISMATCH_CODE,
  releaseMismatchMessage,
  sandboxRelease,
} from "@liaison/sandbox-supervisor"
import { rootLogger } from "~/lib/logger"
import { readSandboxConfig } from "./config"

const log = rootLogger.child({ module: "app-sandbox-release" })

export { RELEASE_HEADER as SANDBOX_RELEASE_HEADER, RELEASE_MISMATCH_CODE }

/** This process's release, as the sandbox service compares it. */
export function appSandboxRelease(): string {
  return sandboxRelease()
}

/**
 * ok: the service answers with this release and reaches this process's
 * bridge-only listener; bridge_unreachable: it cannot call this process back
 * (the process is not on the sandbox network, or the firewall drops it).
 */
export type SandboxProbe = "ok" | "release_mismatch" | "bridge_unreachable" | "error" | "timeout"

/** Ask the sandbox service's /health with this release. Null when no service is configured. */
export async function probeSandbox(
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ status: SandboxProbe; release?: string; message?: string } | null> {
  const config = readSandboxConfig(null)
  if (!config) return null
  const doFetch = opts.fetchImpl ?? fetch
  try {
    const res = await doFetch(`${config.loaderUrl}/health?bridge=1`, {
      headers: { [RELEASE_HEADER]: appSandboxRelease() },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 2_000),
    })
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean
      release?: string
      bridge?: string
      error?: { code?: string; message?: string }
      code?: string
      message?: string
    } | null
    const code = body?.error?.code ?? body?.code
    if (code === RELEASE_MISMATCH_CODE) {
      return {
        status: "release_mismatch",
        message:
          body?.error?.message ?? body?.message ?? releaseMismatchMessage("?", appSandboxRelease()),
      }
    }
    if (res.ok && body?.ok === true && body.bridge === "unreachable") {
      return {
        status: "bridge_unreachable",
        message: "the sandbox service cannot reach this process's bridge listener",
      }
    }
    if (res.ok && body?.ok === true) {
      return { status: "ok", ...(body.release ? { release: body.release } : {}) }
    }
    return { status: "error", message: `HTTP ${res.status}` }
  } catch (err) {
    const timedOut = (err as Error)?.name === "TimeoutError"
    return { status: timedOut ? "timeout" : "error", message: (err as Error)?.message }
  }
}

/** One handshake at start: log loudly when the service runs another release or is unreachable. */
export async function checkSandboxAtBoot(): Promise<void> {
  const r = await probeSandbox({ timeoutMs: 5_000 })
  if (!r) return
  if (r.status === "ok") {
    log.info({ release: appSandboxRelease() }, "Sandbox service answers with this release")
  } else if (r.status === "release_mismatch") {
    log.error(
      { release: appSandboxRelease(), detail: r.message },
      "Sandbox service runs another release; app runs on it are refused until it is recreated",
    )
  } else {
    log.error(
      { status: r.status, detail: r.message },
      "Sandbox service unreachable at start; app runs on it fail until it answers",
    )
  }
}
