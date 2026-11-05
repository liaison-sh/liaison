// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The image installs bin/liaison as a symlink in /usr/local/bin
// (apps/api/Dockerfile). The shim must resolve the CLI entry from its real
// location, not the link's: `liaison search reindex` failed on a deployed box
// with `Module not found "/usr/local/src/cli/index.ts"`.
import { describe, expect, it } from "bun:test"
import { mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("the liaison CLI shim", () => {
  it("loads the CLI when invoked through a symlink in another directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "liaison-shim-"))
    const link = join(dir, "liaison")
    symlinkSync(join(import.meta.dir, "liaison"), link)
    const proc = Bun.spawnSync([link, "--help"], { cwd: dir, stdout: "pipe", stderr: "pipe" })
    // The CLI may still refuse to start without its environment (JWT_SECRET,
    // ...); what matters here is that the entry and its `~/` imports resolve.
    const stderr = proc.stderr.toString()
    expect(stderr).not.toContain("Module not found")
    expect(stderr).not.toContain("Cannot find module")
  })
})
