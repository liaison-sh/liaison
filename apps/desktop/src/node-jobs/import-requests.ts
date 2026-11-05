// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE NODE ANSWERS A SESSION IMPORT REQUEST (W3 T11; S40, S42, A42, A47).
//
// A `node_import_request` frame names a request id. The node pulls it with
// its credential (only its own node's requests are served, claimed by exactly
// one pull), runs the op through the shell's one-shot import sidecar
// (`node_import`: it reads this computer's own shared folders and Claude
// config, never a path from the request), and puts the answer back. The API
// parses the answer with the shared schema of its op. Every refusal travels
// as a code, never a message: a transcript path or a title never leaves in an
// error.

import { nodeImportOpSchema } from "@liaison/shared/node-import"

export type ImportRequestResult = { ok: true; data: unknown } | { ok: false; code: string }

export interface ImportRequestHttp {
  /**
   * The request and this pull's claim, or null when it is gone, not this
   * node's, or already claimed by another of its connections.
   */
  get(requestId: string): Promise<{ op: unknown; claim: string } | null>
  /** The answer, with the claim of the pull that got the request. */
  put(requestId: string, claim: string, result: ImportRequestResult): Promise<void>
}

export interface ImportRequestDeps {
  http: ImportRequestHttp
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
  log?: (message: string, error?: unknown) => void
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A shell refusal is a short identifier (node_follow.rs, session-import.ts); anything else is `failed`. */
const CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

function importCode(error: unknown): string {
  return typeof error === "string" && CODE_RE.test(error) ? error : "failed"
}

export function createImportRequests(
  deps: ImportRequestDeps,
): (requestId: string) => Promise<void> {
  return async (requestId: string) => {
    if (!UUID_RE.test(requestId)) return
    let pulled: { op: unknown; claim: string } | null
    try {
      pulled = await deps.http.get(requestId)
    } catch (error) {
      deps.log?.("node import request not read", error)
      return
    }
    // Gone, or claimed by another connection of this node: not ours to answer.
    if (!pulled) return
    const op = nodeImportOpSchema.safeParse(pulled.op)
    let result: ImportRequestResult
    if (!op.success) {
      result = { ok: false, code: "failed" }
    } else {
      try {
        // One `--import` sidecar at a time (the shell serializes, D47).
        result = { ok: true, data: await deps.invoke("node_import", { op: op.data }) }
      } catch (error) {
        result = { ok: false, code: importCode(error) }
      }
    }
    try {
      await deps.http.put(requestId, pulled.claim, result)
    } catch (error) {
      deps.log?.("node import answer not sent", error)
    }
  }
}
