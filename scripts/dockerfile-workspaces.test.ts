// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The API image's deps layer copies each workspace's package.json by name, on
// purpose (no whole-tree COPY, so the layer stays cacheable). That list is a
// duplicate of the root package.json's `workspaces` globs, and a duplicate
// drifts: a workspace added to the root and not to the Dockerfile makes
// `bun install --frozen-lockfile` fail inside the image with "Workspace not
// found", which no test and no local run sees, only a deploy.
import { describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")

/** Every directory the root `workspaces` globs actually resolve to. */
function workspaceDirs(): string[] {
  const globs = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).workspaces as string[]
  const out = new Set<string>()
  for (const pattern of globs) {
    if (!pattern.endsWith("/*")) {
      if (existsSync(join(ROOT, pattern, "package.json"))) out.add(pattern)
      continue
    }
    const parent = pattern.slice(0, -2)
    for (const entry of readdirSync(join(ROOT, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = `${parent}/${entry.name}`
      if (existsSync(join(ROOT, dir, "package.json"))) out.add(dir)
    }
  }
  return [...out].sort()
}

// The db-gate image has the same frozen install, filtered to its two
// workspaces, and bun still wants every workspace the lockfile lists on disk.
for (const file of ["apps/api/Dockerfile", "apps/db-gate/Dockerfile"]) {
  describe(file, () => {
    it("copies a package.json for every workspace the root declares", () => {
      const dockerfile = readFileSync(join(ROOT, file), "utf8")
      const missing = workspaceDirs().filter(
        (dir) => !dockerfile.includes(`COPY ${dir}/package.json ${dir}/`),
      )
      expect(missing).toEqual([])
    })
  })
}
