// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A workspace package with no typecheck script is invisible to the root gate,
// which is how a new package silently stops being typechecked at all.
import { expect, it } from "bun:test"
import path from "node:path"

it("tsc --noEmit exits 0 for the sidecar package", () => {
  const result = Bun.spawnSync(["bun", "run", "typecheck"], {
    cwd: path.resolve(import.meta.dir),
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.stdout.toString() + result.stderr.toString()).not.toContain("error TS")
  expect(result.exitCode).toBe(0)
}, 180_000)
