// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The sidecar compile generates one entry module per target triple into
// sidecar/.entries. They are gitignored build inputs, nobody edits them, and
// they are written the way a generator writes: the lint gate must not have an
// opinion about them, or `biome check` fails on any tree that has been built.
import { afterEach, expect, it } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..", "..")
const fixture = path.join(import.meta.dir, "sidecar", ".entries", "entry-biome-fixture.ts")

afterEach(() => rmSync(fixture, { force: true }))

it("the lint config excludes the generated sidecar entry modules", () => {
  const config = JSON.parse(readFileSync(path.join(root, "biome.json"), "utf8")) as {
    files: { includes: string[] }
  }
  expect(config.files.includes).toContain("!apps/desktop/sidecar/.entries/**")
})

it("biome check passes over apps/desktop with a generated entry module present", () => {
  mkdirSync(path.dirname(fixture), { recursive: true })
  writeFileSync(fixture, 'import {main} from "../index";\nprocess.exit(await main(null))\n')
  const result = Bun.spawnSync(["bunx", "biome", "check", "apps/desktop"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(result.stdout.toString() + result.stderr.toString()).not.toContain(
    "entry-biome-fixture.ts",
  )
  expect(result.exitCode).toBe(0)
}, 60_000)
