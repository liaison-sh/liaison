// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The BullMQ job ids builds before the queue classes minted for a logical job
// id. They used the logical id AS the BullMQ id (BullMQ forbids ':' in custom
// ids, so an id holding one was wrapped as `job-<base64url>`). Current builds
// deduplicate on the logical id instead (jobs.ts), but jobs queued by an older
// build, and an older build after a rollback, still use this form: the boot
// migration decodes it, `removeAppJob` still looks it up, and the rollback
// script encodes it again. Dependency free.

/** The BullMQ id an older build used for `logicalId`. */
export function encodeLegacyJobId(logicalId: string): string {
  if (!logicalId.includes(":")) return logicalId
  return `job-${Buffer.from(logicalId).toString("base64url")}`
}

/**
 * The logical id an older build encoded into a BullMQ job id, or undefined for
 * an auto-generated (numeric) id, which carried none.
 */
export function decodeLegacyJobId(bullId: string | undefined): string | undefined {
  if (!bullId || /^\d+$/.test(bullId)) return undefined
  if (bullId.startsWith("job-")) {
    const decoded = Buffer.from(bullId.slice(4), "base64url").toString("utf8")
    // Only trust a round trip: a plain id that merely starts with "job-" stays itself.
    if (encodeLegacyJobId(decoded) === bullId) return decoded
  }
  return bullId
}
