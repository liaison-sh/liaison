// SPDX-License-Identifier: FSL-1.1-ALv2
// Client-side helpers for bug report attachments — selection caps mirrored
// from the API route (apps/api/src/modules/bug-reports/routes.ts) and a
// chunked base64 encoder (spreading a whole file into String.fromCharCode
// blows the call stack on multi-MB files).

export const MAX_ATTACHMENTS = 5
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
// The API's body limit is 25 MB and base64 inflates 3 bytes to 4 chars, so cap
// the combined selection below the decoded equivalent (with headroom for the
// description + client logs riding in the same JSON body).
export const MAX_TOTAL_ATTACHMENT_BYTES = 18 * 1024 * 1024

// The largest file a report may forward to the Liaison team (7 MiB raw, the
// control-plane contract's MAX_FORWARD_ATTACHMENT_BYTES): larger files stay on
// the local report only.
export const MAX_FORWARD_ATTACHMENT_BYTES = 7 * 1024 * 1024

export type AttachmentRejection = "too_many" | "file_too_large" | "total_too_large"

/** Merge newly picked files into the current selection, enforcing the caps.
 *  Returns the resulting selection plus the reasons anything was rejected. */
export function mergeSelection(
  current: File[],
  picked: File[],
): { files: File[]; rejections: AttachmentRejection[] } {
  const files = [...current]
  const rejections = new Set<AttachmentRejection>()
  let total = files.reduce((sum, f) => sum + f.size, 0)
  for (const file of picked) {
    if (files.length >= MAX_ATTACHMENTS) {
      rejections.add("too_many")
      continue
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      rejections.add("file_too_large")
      continue
    }
    if (total + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
      rejections.add("total_too_large")
      continue
    }
    files.push(file)
    total += file.size
  }
  return { files, rejections: [...rejections] }
}

export async function encodeFileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ""
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
