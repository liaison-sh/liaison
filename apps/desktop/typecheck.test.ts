// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shell package's own TypeScript surfaces: its tests, the sidecar
// preparation script the Rust build depends on, and the sidecar package's
// sources. apps/desktop/sidecar is a workspace in its own right (it has a real
// runtime dependency to resolve) and runs its own typecheck, but the glob that
// picks it up is a single explicit entry in the root package.json: this
// assertion is the belt, so dropping that entry cannot silently stop the
// sidecar sources from being typechecked at all.
import { expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

it("the shell package's tsconfig covers the sidecar sources", () => {
  const config = JSON.parse(
    readFileSync(path.resolve(import.meta.dir, "tsconfig.json"), "utf8"),
  ) as { include: string[] }
  expect(config.include).toContain("sidecar/**/*.ts")
})

it("the shell package's tsconfig covers the overlay sources", () => {
  const config = JSON.parse(
    readFileSync(path.resolve(import.meta.dir, "tsconfig.json"), "utf8"),
  ) as { include: string[] }
  // Both, because the overlay is Solid JSX and the modules beside it are not:
  // a glob that covered only one half would leave the other untypechecked.
  expect(config.include).toContain("src/**/*.tsx")
  expect(config.include).toContain("src/**/*.ts")
})

it("tsc --noEmit exits 0 for the desktop shell package", () => {
  const result = Bun.spawnSync(["bun", "run", "typecheck"], {
    cwd: path.resolve(import.meta.dir),
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.stdout.toString() + result.stderr.toString()).not.toContain("error TS")
  expect(result.exitCode).toBe(0)
}, 180_000)
