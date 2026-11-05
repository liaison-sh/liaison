// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison export --full` writes the whole instance (every org's rows, files and
// search documents) into one tarball. It is a backup: only its owner may read it.
// A stand-in pg_dump writes the dump file, so no database is involved.
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { exportFull } from "~/cli/export-full"

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

describe("liaison export --full: file mode", () => {
  test("the tarball is readable by its owner only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "liaison-export-mode-"))
    dirs.push(dir)
    const fakePgDump = join(dir, "pg_dump")
    // Writes a one-line dump to the path after --file.
    writeFileSync(
      fakePgDump,
      '#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "--file" ]; then echo "-- dump" > "$2"; fi; shift; done\n',
    )
    chmodSync(fakePgDump, 0o755)
    const out = join(dir, "backup.tar.gz")
    const res = await exportFull({
      output: out,
      dbUrl: "postgres://unused@127.0.0.1:1/unused",
      pgDumpResolver: () => fakePgDump,
      storageObjectsIter: async function* () {},
      meili: {
        isHealthy: async () => false,
        listIndexUids: async () => [],
        getIndexDocuments: async () => [],
      },
    })
    expect(res.exitCode).toBe(0)
    // No group or other permission bits, whatever the process umask.
    expect((statSync(out).mode & 0o077).toString(8)).toBe("0")
  })
})
