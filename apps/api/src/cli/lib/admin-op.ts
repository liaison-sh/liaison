// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Shared runtime-narrowing helpers for reading `runAdminOp` results.
 *
 * `runAdminOp` returns `unknown` — these helpers narrow it safely with no `as`
 * casts. Each caller uses whichever combination it needs:
 *
 * - `readAdminErrorCode`  — used when the caller pattern-matches on the code
 *   string (e.g. `inbox_email_taken` for idempotent success).
 * - `readAdminErrorMessage` — used when the caller only needs a human-readable
 *   message to surface in a thrown Error.
 */

/** Read a property off an unknown value without a cast (`in`-narrowed). */
export function prop(obj: unknown, key: string): unknown {
  if (typeof obj !== "object" || obj === null || !(key in obj)) return undefined
  return Reflect.get(obj, key)
}

/**
 * Return the admin-op error **code** if `result` is the error variant, else
 * null. Use when you need to pattern-match on `code` (e.g. `inbox_email_taken`).
 */
export function readAdminErrorCode(result: unknown): string | null {
  const err = prop(result, "error")
  if (typeof err !== "object" || err === null) return null
  const code = prop(err, "code")
  return typeof code === "string" ? code : "unknown_error"
}

/**
 * Return the admin-op error **message** if `result` is the error variant, else
 * null. Use when you only need a human-readable string to throw.
 */
export function readAdminErrorMessage(result: unknown): string | null {
  const err = prop(result, "error")
  if (typeof err !== "object" || err === null) return null
  const message = prop(err, "message")
  return typeof message === "string" ? message : "unknown error"
}

/**
 * Read the `{ key, keyPrefix }` shape that `apiKeysCreate` returns,
 * runtime-narrowed (no cast). Returns null if the shape is unexpected.
 */
export function readMintedKey(result: unknown): { key: string; keyPrefix: string } | null {
  const key = prop(result, "key")
  const keyPrefix = prop(result, "keyPrefix")
  if (typeof key !== "string" || typeof keyPrefix !== "string") return null
  return { key, keyPrefix }
}
