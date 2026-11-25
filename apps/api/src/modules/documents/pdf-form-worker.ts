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
import { capDataSegment, refuseCoreDumps } from "../../lib/isolate-limits"
import { exitWhenOrphaned } from "../../lib/orphan-exit"
import { type PdfFormRequest, runPdfFormRequest } from "./pdf-form-core"

// The death pipe on fd 0 (and a parent-pid poll): a server killed mid-request
// never leaves this process parsing on its own.
exitWhenOrphaned()

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
