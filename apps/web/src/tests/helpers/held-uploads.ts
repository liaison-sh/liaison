// SPDX-License-Identifier: FSL-1.1-ALv2
import { vi } from "vitest"
import type * as FileService from "~/modules/files/file-service"
import type { FileRow } from "~/modules/files/file-service"

/**
 * Uploads a test finishes or fails by hand. Every pick runs through the REAL
 * `uploadFile`, so it registers as in flight exactly as in the app; the
 * presign and the storage PUT answer at once and the confirm step waits for
 * the test: `finish[i](row)` lands the i-th pick, `fail[i](err)` fails it.
 *
 * Install with
 *   vi.mock("~/modules/files/file-service", (orig) => withHeldUploads(orig))
 * where `withHeldUploads` comes from a dynamic import of this module inside
 * the factory.
 */
export const heldUploads = {
  finish: [] as Array<(row: FileRow) => void>,
  fail: [] as Array<(err: Error) => void>,
  /** Paths the upload deleted (a cancelled upload's late row). */
  deleted: [] as string[],
  reset(): void {
    heldUploads.finish = []
    heldUploads.fail = []
    heldUploads.deleted = []
  },
}

const heldUploadApi = {
  delete: async (url: string) => {
    heldUploads.deleted.push(url)
  },
  post: (url: string) =>
    url === "/files/confirm"
      ? new Promise<FileRow>((resolve, reject) => {
          heldUploads.finish.push(resolve)
          heldUploads.fail.push(reject)
        })
      : Promise.resolve({
          uploadUrl: "https://storage.example.com/put",
          fileToken: "tok",
          storageKey: "k",
        }),
}

export async function withHeldUploads(
  importOriginal: <T>() => Promise<T>,
): Promise<typeof FileService> {
  const actual = await importOriginal<typeof FileService>()
  // The storage PUT: answered, and nothing else in these tests fetches.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 200 })),
  )
  return {
    ...actual,
    uploadFile: ((_api, file, parent, options) =>
      actual.uploadFile(
        heldUploadApi as unknown as Parameters<typeof actual.uploadFile>[0],
        file,
        parent,
        options,
      )) as typeof actual.uploadFile,
  }
}

/** A row for a landed pick. */
export function landedRow(id: string, filename: string, parent: Partial<FileRow> = {}): FileRow {
  return {
    id,
    filename,
    sizeBytes: 1,
    mimeType: filename.endsWith(".png") ? "image/png" : "application/pdf",
    thumbnailKey: null,
    ...parent,
  }
}

/** Past the hold's next-task send, so "was not sent" is a real claim. */
export const nextTask = (): Promise<void> => new Promise((r) => setTimeout(r, 20))
