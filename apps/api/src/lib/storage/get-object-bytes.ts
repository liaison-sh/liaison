// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  getObjectBuffer as defaultGetObjectBuffer,
  headObject as defaultHeadObject,
  type HeadResult,
} from "~/infra/storage/object-storage"
import { filesLogger as log } from "~/lib/logger"
import { FileServiceError } from "~/modules/files/service"

export interface GetObjectBytesResult {
  bytes: Buffer
  contentType: string
  contentLength: number
}

/**
 * Injectable storage seam. Production callers omit `deps` and get the real
 * `~/infra/storage/object-storage` functions. Tests pass fakes here instead of
 * `mock.module(...)` — `mock.module` registers a PROCESS-WIDE override that
 * bun:test never restores, and since every *.test.ts shares one process it
 * would poison later suites (it previously zeroed out `getObjectBuffer` for
 * `modules/pdf/render.test.ts`). A `deps` seam keeps the fake local.
 */
export interface GetObjectBytesDeps {
  headObject?: typeof defaultHeadObject
  getObjectBuffer?: typeof defaultGetObjectBuffer
}

/**
 * Privileged read of an object from storage with a maxBytes cap.
 *
 * Used by the authenticated inline route (`GET /api/files/:id/inline`) and the
 * sandbox attachment-bytes bridge (`files_getAttachmentBytes`). The caller is
 * responsible for RLS-checking the file row first; this helper only enforces
 * the size cap and reads bytes from the bucket.
 */
export async function getObjectBytes(
  key: string,
  opts: { maxBytes: number },
  deps: GetObjectBytesDeps = {},
): Promise<GetObjectBytesResult> {
  const headObject = deps.headObject ?? defaultHeadObject
  const getObjectBuffer = deps.getObjectBuffer ?? defaultGetObjectBuffer
  let head: HeadResult
  try {
    head = await headObject(key)
  } catch (err) {
    // Log the key for ops triage but never include it in the thrown error —
    // the message bubbles to clients and the key is sensitive internal state.
    log.warn({ err, key }, "headObject failed in getObjectBytes")
    throw new FileServiceError("FILE_VERIFY_FAILED", "Object not available")
  }
  // Reject early when Content-Length is known and already over budget.
  // A zero or missing Content-Length is treated as unknown — we still stream
  // with the hard cap below rather than trusting the header.
  if (head.contentLength > 0 && head.contentLength > opts.maxBytes) {
    throw new FileServiceError("FILE_TOO_LARGE", `Object exceeds maxBytes=${opts.maxBytes}`)
  }
  // Stream the body and enforce the hard byte ceiling on actual received bytes.
  // This catches objects whose Content-Length was absent, zero, or dishonest.
  let bytes: Buffer
  try {
    bytes = await getObjectBuffer(key, undefined, { maxBytes: opts.maxBytes })
  } catch (err) {
    if (err instanceof Error && err.message.includes("exceeds maxBytes")) {
      throw new FileServiceError("FILE_TOO_LARGE", `Object exceeds maxBytes=${opts.maxBytes}`)
    }
    throw err
  }
  return {
    bytes,
    contentType: head.contentType,
    contentLength: bytes.byteLength,
  }
}
