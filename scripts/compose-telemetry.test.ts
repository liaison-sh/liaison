// SPDX-License-Identifier: FSL-1.1-ALv2
// A self-hosted box must not report usage to a third party on its own. The
// bundled Meilisearch sends anonymous analytics to its vendor unless told not
// to, so every compose file that runs it turns that off.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..")

/** The compose files at the repo root and under deploy/. */
function composeFiles(): string[] {
  const isCompose = (name: string) => /^docker-compose(\.[\w-]+)?\.ya?ml$/.test(name)
  return [
    ...readdirSync(REPO_ROOT).filter(isCompose),
    ...readdirSync(join(REPO_ROOT, "deploy"))
      .filter(isCompose)
      .map((name) => `deploy/${name}`),
  ]
}

/** Each top-level service's block of lines, keyed by service name. */
function serviceBlocks(relativePath: string): Record<string, string> {
  const lines = readFileSync(join(REPO_ROOT, relativePath), "utf8").split("\n")
  const out: Record<string, string> = {}
  let inServices = false
  let current: string | null = null
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inServices = /^services:\s*$/.test(line)
      current = null
      continue
    }
    if (!inServices) continue
    const header = /^ {2}([\w-]+):(?:\s+&[\w-]+)?\s*$/.exec(line)
    if (header) {
      current = header[1]!
      out[current] = ""
      continue
    }
    if (current) out[current] += `${line}\n`
  }
  return out
}

describe("compose telemetry", () => {
  const files = composeFiles()

  it("finds the root and deployment compose files", () => {
    expect(files).toContain("docker-compose.yml")
    expect(files).toContain("deploy/docker-compose.yml")
  })

  for (const file of files) {
    const meili = Object.entries(serviceBlocks(file)).filter(([, block]) =>
      /^\s+image:\s*["']?getmeili\/meilisearch[:@]/m.test(block),
    )
    for (const [service, block] of meili) {
      it(`${file} runs ${service} with analytics off`, () => {
        expect(block).toMatch(/^\s+MEILI_NO_ANALYTICS:\s*["']?true["']?\s*$/m)
      })
    }
  }

  it("the deployment compose file runs Meilisearch", () => {
    const services = Object.values(serviceBlocks("deploy/docker-compose.yml"))
    expect(services.some((block) => /getmeili\/meilisearch/.test(block))).toBe(true)
  })
})
