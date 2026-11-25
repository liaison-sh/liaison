// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Kernel limits a parsing isolate sets on itself at startup, before it reads
// any request: no core dump (Linux) and a data-segment cap (Linux). Used by the
// PDF form isolate and the render service's child. Node builtins and bun:ffi
// only, so an isolate starts on its env allowlist alone.
import { dlopen, FFIType, ptr } from "bun:ffi"
import { readFileSync } from "node:fs"

/** RLIMIT_DATA, the same number on Linux and macOS. */
const PR_SET_DUMPABLE = 4
const RLIMIT_DATA = 2

/**
 * Linux: cap this process's data segment at its idle size plus `headroom`
 * bytes, before any request is read. The kernel then refuses the allocation
 * that would pass it, whether or not the server is alive to kill us. The
 * idle size is measured, not assumed: the runtime reserves gigabytes of
 * address space at start, and how much changes between releases. macOS does
 * not enforce the limit, so it is not set there (modules/documents/pdf-form.ts).
 */
export function capDataSegment(headroom: number): void {
  if (process.platform !== "linux" || !Number.isFinite(headroom) || headroom <= 0) return
  const idleKb = Number(/VmData:\s+(\d+)/.exec(readFileSync("/proc/self/status", "utf8"))?.[1])
  if (!Number.isFinite(idleKb) || idleKb <= 0) throw new Error("cannot read VmData")
  const cap = BigInt(idleKb * 1024 + headroom)
  // struct rlimit { rlim_t cur; rlim_t max; }, rlim_t a 64-bit unsigned.
  const limit = new BigUint64Array([cap, cap])
  const libc = dlopen("libc.so.6", {
    setrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  })
  try {
    if (libc.symbols.setrlimit(RLIMIT_DATA, ptr(limit)) !== 0) throw new Error("setrlimit failed")
  } finally {
    libc.close()
  }
}

/**
 * No core dump on Linux. SIGXCPU dumps core by default, and `ulimit -c 0` does not
 * stop a dump the host pipes to a handler (core_pattern `|...`, the kernel does not
 * apply the limit there): the isolate's memory, the customer's document included,
 * goes to that handler, and the process stays alive until it ends (15 s measured).
 */
export function refuseCoreDumps(): void {
  if (process.platform !== "linux") return
  const libc = dlopen("libc.so.6", {
    prctl: {
      args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
      returns: FFIType.i32,
    },
  })
  try {
    if (libc.symbols.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) !== 0) throw new Error("prctl failed")
  } finally {
    libc.close()
  }
}
