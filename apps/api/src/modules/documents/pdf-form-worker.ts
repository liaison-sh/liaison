// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The PDF form isolate: one process per request, spawned by pdf-form.ts with a
// minimal env (no host secrets) and killed by it on a deadline or a memory
// ceiling. It answers exactly one request over IPC and is then killed.
//
// argv[2]: bytes of data segment allowed above the idle footprint (Linux).
//
// Imports stay dependency free on purpose: no env parsing, no logger, no DB,
// so the process starts on the env allowlist alone.
import { dlopen, FFIType, ptr } from "bun:ffi"
import { readFileSync } from "node:fs"
import { exitWhenOrphaned } from "../../lib/orphan-exit"
import { type PdfFormRequest, runPdfFormRequest } from "./pdf-form-core"

// The death pipe on fd 0 (and a parent-pid poll): a server killed mid-request
// never leaves this process parsing on its own.
exitWhenOrphaned()

/** RLIMIT_DATA, the same number on Linux and macOS. */
const PR_SET_DUMPABLE = 4
const RLIMIT_DATA = 2

/**
 * Linux: cap this process's data segment at its idle size plus `headroom`
 * bytes, before any request is read. The kernel then refuses the allocation
 * that would pass it, whether or not the server is alive to kill us. The
 * idle size is measured, not assumed: the runtime reserves gigabytes of
 * address space at start, and how much changes between releases. macOS does
 * not enforce the limit, so it is not set there (pdf-form.ts).
 */
function capDataSegment(headroom: number): void {
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
function refuseCoreDumps(): void {
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

refuseCoreDumps()
capDataSegment(Number(process.argv[2]))

function isRequest(msg: unknown): msg is PdfFormRequest {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "op" in msg &&
    typeof msg.op === "string" &&
    "pdf" in msg &&
    typeof msg.pdf === "string"
  )
}

let taken = false
process.on("message", (msg: unknown) => {
  if (taken || !isRequest(msg)) return
  taken = true
  void runPdfFormRequest(msg).then((response) => {
    process.send?.({ type: "result", response })
  })
})

process.send?.({ type: "ready" })
