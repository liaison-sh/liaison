// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Whether this server can ask for a signature, and why not, in the words a person reads. The
// hosted edition offers no signature unless its operator turned it on; a signature with no
// timestamp authority would seal nothing that could be dated, so a send that needs one
// refuses. The screens read this before anyone prepares a document; the operator's detail
// (which setting) goes to the log and the self-hosting docs, never to the person.
import { isManagedEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "client-action-signing" })

export type SigningState =
  | { available: true }
  | { available: false; reason: "not_offered" | "no_timestamp" }

export function signingState(): SigningState {
  if (isManagedEdition() && !env.LIAISON_MANAGED_SIGNING_ENABLED) {
    return { available: false, reason: "not_offered" }
  }
  if (!env.LIAISON_TSA_URL) return { available: false, reason: "no_timestamp" }
  return { available: true }
}

/** Why a signature cannot be asked on this server, or null. Only `sign` needs one. */
export function signingUnavailable(kind: string): { code: string; message: string } | null {
  if (kind !== "sign") return null
  const state = signingState()
  if (state.available) return null
  if (state.reason === "not_offered") {
    return {
      code: "SIGNING_NOT_AVAILABLE",
      message: "Signatures are not offered on this hosted service. Nothing was sent.",
    }
  }
  log.warn(
    "a send for signature was refused: no timestamp authority is configured (LIAISON_TSA_URL)",
  )
  return {
    code: "TIMESTAMP_NOT_CONFIGURED",
    message:
      "Signatures are off on this server: it has no timestamp service to date a signature. Nothing was sent. Whoever runs this server can turn signatures on.",
  }
}
