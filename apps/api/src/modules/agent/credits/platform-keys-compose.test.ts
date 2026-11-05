// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every model provider key the credit meter reads must reach the app container. A
// compose file that leaves one out passes every in-process test (they set
// process.env directly) and only fails on a deployed box, where the env file
// holds the key and the container never sees it.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ENV_KEY_MAP } from "./platform-key-env"

const repoRoot = join(import.meta.dir, "..", "..", "..", "..", "..", "..")

function appServiceBlock(): string {
  const src = readFileSync(join(repoRoot, "deploy", "docker-compose.yml"), "utf8")
  const start = src.indexOf("\n  app:")
  if (start < 0) throw new Error("app service not found in deploy/docker-compose.yml")
  const rest = src.slice(start + 1)
  // The next top-level service (two-space indent) ends the block.
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/)
  return next < 0 ? rest : rest.slice(0, next + 1)
}

describe("platform provider keys", () => {
  const app = appServiceBlock()
  const example = readFileSync(join(repoRoot, "deploy", ".env.example"), "utf8")

  // The model providers' keys. Exa (web search) is not a model key and is not
  // passed to the container.
  const modelKeys = Object.entries(ENV_KEY_MAP)
    .filter(([provider]) => provider !== "exa")
    .map(([, envVar]) => envVar)

  it("covers the OpenRouter key", () => {
    expect(modelKeys).toContain("OPENROUTER_API_KEY")
  })

  for (const envVar of modelKeys) {
    it(`${envVar} is passed into the app container`, () => {
      expect(app).toContain(`${envVar}: \${${envVar}`)
    })
    it(`${envVar} is listed in deploy/.env.example`, () => {
      expect(example).toMatch(new RegExp(`^${envVar}=`, "m"))
    })
  }
})
