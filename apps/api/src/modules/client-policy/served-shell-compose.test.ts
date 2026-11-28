// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The operator's served-shell switch (LIAISON_SERVED_SHELL, docs/self-hosting/docker.md)
// must reach the app container. Compose passes only the keys its app block lists, so a
// key missing there is silently ignored on a Docker deploy: an operator who writes
// LIAISON_SERVED_SHELL=false in .env still serves the shell. An unset key must also stay
// "on": the env parser reads the empty string as false, so the default is written out.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const repoRoot = join(import.meta.dir, "..", "..", "..", "..", "..")

function appServiceBlock(): string {
  const src = readFileSync(join(repoRoot, "deploy", "docker-compose.yml"), "utf8")
  const start = src.indexOf("\n  app:")
  if (start < 0) throw new Error("app service not found in deploy/docker-compose.yml")
  const rest = src.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/)
  return next < 0 ? rest : rest.slice(0, next + 1)
}

describe("LIAISON_SERVED_SHELL in the Docker deploy", () => {
  it("is passed into the app container, on when unset", () => {
    expect(appServiceBlock()).toContain("LIAISON_SERVED_SHELL: $" + "{LIAISON_SERVED_SHELL:-true}")
  })
})
