// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHICH PROCESS A PID IS, not only whether one exists.
//
// The Claude sign-in's watchdog (claude-auth.ts) kills a process it did not
// start and waits on one it cannot signal. A bare pid is not enough for either:
// Windows reuses pids quickly, so a CLI that exited could be replaced by an
// unrelated program within one poll (and that program killed), and a sidecar
// killed outright could have its pid taken by something that lives for hours
// (and the watchdog, and the CLI, with it). So a process is named by its pid
// AND its start time, read the way each OS keeps it:
//
//   Linux    `/proc/<pid>/stat`, field 22 (start time in clock ticks since boot)
//   macOS    `ps -o stat=,lstart= -p <pid>` (start to the second; macOS hands
//            out pids in increasing order, so a reuse inside that second does
//            not happen in practice)
//   Windows  kernel32 `GetProcessTimes` creation time, 100 ns resolution, on a
//            handle that is also asked `GetExitCodeProcess` (a process that
//            exited but whose object is still held open is not alive)
//
// A zombie is not alive. Anything that cannot be read is null: no process the
// watchdog may touch.

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

/** The identity of a LIVE process, or null for none (or one that cannot be read). */
export type IdentityReader = (pid: number) => string | null

/** Whitespace free, so it survives a command line on every OS. */
function normalize(value: string): string | null {
  const flat = value.trim().replace(/\s+/g, "_")
  return flat.length > 0 ? flat : null
}

/**
 * The start time out of `/proc/<pid>/stat`. The command name (field 2) is in
 * parentheses and may itself hold spaces and parentheses, so the fields are
 * counted from the LAST closing one: state is field 3, start time field 22.
 */
export function parseLinuxStat(stat: string): string | null {
  const close = stat.lastIndexOf(")")
  if (close === -1) return null
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/)
  const state = fields[0]
  const start = fields[19]
  if (!state || !start || state === "Z" || state === "X") return null
  return normalize(`linux:${start}`)
}

/** `ps -o stat=,lstart=`: state then the start date, or nothing for no process. */
export function parsePsLine(printed: string): string | null {
  const line = printed.trim()
  if (!line) return null
  const [state, ...start] = line.split(/\s+/)
  if (!state || state.startsWith("Z") || start.length === 0) return null
  return normalize(`ps:${start.join(" ")}`)
}

function linuxReader(): IdentityReader {
  return (pid) => {
    try {
      return parseLinuxStat(readFileSync(`/proc/${pid}/stat`, "utf8"))
    } catch {
      return null
    }
  }
}

function psReader(): IdentityReader {
  return (pid) => {
    const result = spawnSync("ps", ["-o", "stat=,lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
    })
    if (result.status !== 0 || typeof result.stdout !== "string") return null
    return parsePsLine(result.stdout)
  }
}

/** Windows: `STILL_ACTIVE` and `PROCESS_QUERY_LIMITED_INFORMATION`. */
const STILL_ACTIVE = 259
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

function windowsReader(): IdentityReader | null {
  try {
    // Loaded only here: nothing else in the sidecar needs a foreign function.
    const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi")
    const { symbols } = dlopen("kernel32.dll", {
      OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
      GetExitCodeProcess: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
      GetProcessTimes: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.bool,
      },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
    })
    return (pid) => {
      const handle = symbols.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
      if (!handle) return null
      try {
        const code = new Uint32Array(1)
        if (!symbols.GetExitCodeProcess(handle, ptr(code)) || code[0] !== STILL_ACTIVE) return null
        const times = new BigUint64Array(4)
        const ok = symbols.GetProcessTimes(
          handle,
          ptr(times, 0),
          ptr(times, 8),
          ptr(times, 16),
          ptr(times, 24),
        )
        return ok ? normalize(`win:${times[0]}`) : null
      } finally {
        symbols.CloseHandle(handle)
      }
    }
  } catch {
    return null
  }
}

/** This OS's reader, or null when there is no reliable one here. */
export function identityReader(
  platform: NodeJS.Platform = process.platform,
): IdentityReader | null {
  if (platform === "linux") return linuxReader()
  if (platform === "win32") return windowsReader()
  if (platform === "darwin" || platform === "freebsd" || platform === "openbsd") return psReader()
  return null
}
