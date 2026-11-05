// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A `kernel.files` row with no object behind it: the metadata a file reader resolves (app,
// parent, size, encryption version) for a test that fakes the storage read. Written privileged,
// as the upload and mail import paths write it.

import { withSystemDb } from "~/db/privileged"
import { files } from "~/db/schema/kernel"

export type FileRowSeed = typeof files.$inferInsert

/** Insert one file row and return its id. */
export async function seedFileRow(row: FileRowSeed): Promise<string> {
  const [inserted] = await withSystemDb("seed-file-row", (tx) =>
    tx.insert(files).values(row).returning({ id: files.id }),
  )
  if (!inserted) throw new Error(`seed: file row ${row.id ?? "(new)"} was not inserted`)
  return inserted.id
}
