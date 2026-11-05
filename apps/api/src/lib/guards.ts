// SPDX-License-Identifier: FSL-1.1-ALv2

/** A non-null, non-array object: a JSON object read from untrusted input. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
