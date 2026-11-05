// SPDX-License-Identifier: FSL-1.1-ALv2
// scripts/lib/unit-watchdog.ts
//
// A wedged `bun test` process never ends on its own: --timeout only fires while
// its event loop turns, so a process stuck in a blocking call sits there until the
// job's own limit cancels the whole run, with no report and no name to go on. Each
// unit process is watched for silence: bun prints every file as it finishes and the
// tests log, so a process that says nothing for several per-test timeouts in a row
// is wedged. It is killed, and it counts as a failure that names what it was doing.
//
// That progress is bun's default, not a promise: when it believes an AI agent is running
// it (the variables below) it prints nothing until the end, and a quiet healthy process
// then reads as wedged. A watched process runs without them (withoutQuietBunVars).

/** The variables that make `bun test` hold back its per-file progress (bun 1.4.4). */
export const QUIET_BUN_VARS = ["CLAUDECODE", "AGENT", "REPL_ID"] as const

/** A copy of `env` for a watched `bun test` process, whose progress is its proof of life. */
export function withoutQuietBunVars(env: Record<string, string>): Record<string, string> {
  const out = { ...env }
  for (const name of QUIET_BUN_VARS) delete out[name]
  return out
}

/** Silence that means wedged: five per-test timeouts, overridable for one slow test. */
export function silenceLimitMs(perTestTimeoutMs: number, override?: string): number {
  const explicit = Number(override)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  return perTestTimeoutMs * 5
}

export type SilenceWatch = {
  /** Output arrived. */
  touch(): void
  /** Stops watching; the callback will not fire after this. */
  stop(): void
}

/** Calls `onSilent` once, with the silence it measured, when no output arrived for `limitMs`. */
export function watchSilence(
  limitMs: number,
  onSilent: (silentMs: number) => void,
  pollMs = Math.min(5000, Math.max(10, Math.floor(limitMs / 4))),
): SilenceWatch {
  let last = Date.now()
  const timer = setInterval(() => {
    const silent = Date.now() - last
    if (silent < limitMs) return
    clearInterval(timer)
    onSilent(silent)
  }, pollMs)
  return {
    touch: () => {
      last = Date.now()
    },
    stop: () => clearInterval(timer),
  }
}

/** The last lines of a process's output, for a report that has nothing else to show. */
export function tailLines(text: string, count: number): string {
  return text.split("\n").filter(Boolean).slice(-count).join("\n")
}
