// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One render child: spawned per request by runner.ts with a minimal env, it
// answers exactly one request over IPC and is then killed. Before each page it
// tells the parent, which holds the page deadline; the parent also holds the
// file deadline and the memory ceiling, and kills it outright on either.
//
// argv[2]: bytes of data segment allowed above the idle footprint (Linux).
import { capDataSegment, refuseCoreDumps } from "../../lib/isolate-limits"
import { exitWhenOrphaned } from "../../lib/orphan-exit"
import type { PdfRenderRequest } from "./protocol"
import { intakeUpload, renderCodeOf, sealMerge } from "./readings"

exitWhenOrphaned()
refuseCoreDumps()
capDataSegment(Number(process.argv[2]))

const onPage = (n: number) => process.send?.({ type: "page", n })

async function run(req: PdfRenderRequest): Promise<unknown> {
  if (req.op === "intake")
    return intakeUpload(new Uint8Array(Buffer.from(req.pdf, "base64")), onPage)
  return sealMerge(
    new Uint8Array(Buffer.from(req.frozen, "base64")),
    new Uint8Array(Buffer.from(req.signaturePages, "base64")),
    onPage,
  )
}

let taken = false
process.on("message", (msg: unknown) => {
  const req = msg as PdfRenderRequest
  if (taken || !req || (req.op !== "intake" && req.op !== "seal_merge")) return
  taken = true
  void run(req).then(
    (result) => process.send?.({ type: "result", response: { ok: true, result } }),
    (err) => process.send?.({ type: "result", response: { ok: false, ...renderCodeOf(err) } }),
  )
})

process.send?.({ type: "ready" })
