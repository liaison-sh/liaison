// SPDX-License-Identifier: FSL-1.1-ALv2

/** A canonical uuid, any case. Guard every `${id}::uuid` cast with it: a malformed
 *  value otherwise raises 22P02 and aborts the whole transaction. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True for a well-formed uuid string. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value)
}
