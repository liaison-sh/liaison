// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The load model's replies, with no runtime dependency (node:crypto only), so
 * the deploy-under-load driver (scripts/lib/deploy-under-load.ts) and the k6
 * profile judge a turn against the very texts the box plays.
 *
 * A load org's thread plays one script, picked by a hash of the thread id
 * (load-scripts.ts): its FIRST turn answers that script's reply, and every
 * later turn of the thread answers the scripted provider's fixed line.
 */
import { createHash } from "node:crypto"

/** The catalog: one final reply per script. A stress run checks for these. */
export const LOAD_SCRIPT_REPLIES = [
  "Load reply A: the request was received and nothing was sent.",
  "Load reply B: noted, no action leaves this workspace.",
  "Load reply C: done, this is a synthetic answer.",
  "Load reply D: acknowledged by the load model.",
] as const

/** What a scripted thread answers once its script is played. */
export const SCRIPTED_FALLBACK_REPLY = "Acknowledged."

/** The catalog index of a thread's script: the first 4 bytes of sha256(thread id), mod the catalog size. */
export function loadScriptIndex(threadId: string | null | undefined): number {
  const digest = createHash("sha256")
    .update(threadId ?? "")
    .digest()
  return digest.readUInt32BE(0) % LOAD_SCRIPT_REPLIES.length
}

/** The reply a load org's turn must end with: its thread's script on turn 0, the fixed line after. */
export function expectedLoadReply(threadId: string, turnOrdinal: number): string {
  return turnOrdinal === 0
    ? LOAD_SCRIPT_REPLIES[loadScriptIndex(threadId)]!
    : SCRIPTED_FALLBACK_REPLY
}
