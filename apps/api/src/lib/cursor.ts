// SPDX-License-Identifier: FSL-1.1-ALv2
export function encodeKeysetCursor(payload: Record<string, unknown>): string {
  return `keyset:${Buffer.from(JSON.stringify(payload)).toString("base64url")}`
}

export function decodeKeysetCursor(cursor: string): Record<string, unknown> {
  if (!cursor.startsWith("keyset:")) throw new Error("invalid_cursor")
  try {
    return JSON.parse(Buffer.from(cursor.slice("keyset:".length), "base64url").toString("utf8"))
  } catch {
    throw new Error("invalid_cursor")
  }
}
