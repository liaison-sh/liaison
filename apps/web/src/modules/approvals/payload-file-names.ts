// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * FILE NAMES IN AN APPROVAL'S EXACT PAYLOAD.
 *
 * A reply that carries attachments stores them as Liaison file ids
 * (`attachments: ["0f3c…", …]`), and the card's "Exact payload" printed those
 * ids, while the summary line above it named the same files. A reviewer had
 * to trust that the two lists matched. The payload rows now show each file's
 * name; the id stays on the value (its tooltip and `data-file-id`) for audit,
 * and the stored payload is never touched.
 *
 * Names come from `GET /files/:id/metadata`, read under the viewer's own RLS:
 * a file the reviewer cannot see keeps its id, exactly as before.
 */
import { createResource } from "solid-js"
import type { ApiClient } from "~/lib/api-client"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A payload path that holds a file id: `attachments[0]`, `x.attachments[2]`,
 *  or the single `attachmentSessionId` a reply may pass a file id in. */
const FILE_ID_PATH = /(^|\.)(attachments\[\d+\]|attachmentSessionId)$/

/** The file ids among flattened `[path, value]` payload rows, deduplicated. */
export function payloadFileIds(rows: ReadonlyArray<readonly [string, string]>): string[] {
  const ids = new Set<string>()
  for (const [path, value] of rows) {
    if (FILE_ID_PATH.test(path) && UUID.test(value)) ids.add(value)
  }
  return [...ids]
}

/**
 * File id to file name, for the ids the viewer can read; undefined until the
 * names arrive. Never suspends: the card shows the ids meanwhile rather than
 * blanking behind a Suspense boundary for a tooltip's worth of data.
 */
export function createPayloadFileNames(
  api: () => ApiClient | undefined,
  rows: () => ReadonlyArray<readonly [string, string]>,
): () => Map<string, string> | undefined {
  // A primitive source: the payload memo re-runs often, the ids rarely.
  const [names] = createResource(
    () => {
      const ids = payloadFileIds(rows())
      return api() && ids.length > 0 ? ids.join(",") : false
    },
    async (key) => {
      const out = new Map<string, string>()
      const client = api()
      if (!client) return out
      const ids = key.split(",")
      const settled = await Promise.allSettled(
        ids.map((id) =>
          client.get<{ filename?: unknown }>(`/files/${encodeURIComponent(id)}/metadata`, {
            suppressGlobalError: true,
          }),
        ),
      )
      settled.forEach((result, i) => {
        const id = ids[i]
        if (!id || result.status !== "fulfilled") return
        const name = result.value?.filename
        if (typeof name === "string" && name !== "") out.set(id, name)
      })
      return out
    },
  )
  // `latest` before the first value would read the resource and suspend.
  return () => (names.state === "ready" || names.state === "refreshing" ? names.latest : undefined)
}
