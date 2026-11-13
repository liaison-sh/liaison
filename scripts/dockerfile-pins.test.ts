// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a server image is built from is fixed by content, not by name. A tag
// (`oven/bun:1.4.2`, `docker/dockerfile:1.7`) is whatever its publisher points
// it at today, and both the BuildKit frontend and the base image run code in
// every build, so each is pinned by digest with the tag beside it for the
// reader. And the dependencies come from the reviewed lockfile only: an install
// that falls back to a fresh resolution when the frozen one fails ships
// versions nobody reviewed.
//
// The same holds for the self-host compose files: every image a deployment
// pulls (postgres, redis, meilisearch, seaweedfs, busybox) runs in production
// beside the app, so each is `repo:tag@sha256:<digest>` too. The app's own
// image is the one exception: it is `${LIAISON_IMAGE:-...}`, set per release.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")
const DOCKERFILES = ["apps/api/Dockerfile", "apps/db-gate/Dockerfile"]
const DIGEST = /@sha256:[0-9a-f]{64}$/

for (const file of DOCKERFILES) {
  const text = readFileSync(join(ROOT, file), "utf8")
  const lines = text.split("\n")
  // Instructions joined across line continuations, so a RUN spread over
  // several lines is read whole.
  const instructions = text.replace(/\\\n/g, " ").split("\n")
  const stages = new Set<string>()

  describe(file, () => {
    it("pins every external base image by digest, with its tag", () => {
      const froms = lines.filter((line) => /^FROM\s/i.test(line))
      expect(froms.length).toBeGreaterThan(0)
      for (const line of froms) {
        const [, image, alias] = line.match(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i) ?? []
        if (image && stages.has(image)) {
          if (alias) stages.add(alias)
          continue
        }
        expect(image, line).toMatch(/^[a-z0-9./-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/)
        if (alias) stages.add(alias)
      }
    })

    it("pins the BuildKit frontend by digest when it names one", () => {
      const syntax = lines.find((line) => /^#\s*syntax=/.test(line))
      if (syntax === undefined) return
      expect(syntax.replace(/^#\s*syntax=/, "").trim()).toMatch(DIGEST)
    })

    it("installs from the frozen lockfile and never falls back to a fresh resolution", () => {
      const installs = instructions.filter((line) => /\bbun\s+(install|i)\b/.test(line))
      expect(installs.length).toBeGreaterThan(0)
      for (const line of installs) {
        for (const command of line.split(/\|\||&&|;/)) {
          if (!/\bbun\s+(install|i)\b/.test(command)) continue
          expect(command, `${file}: ${command.trim()}`).toContain("--frozen-lockfile")
        }
      }
    })
  })
}

const COMPOSE_FILES = readdirSync(join(ROOT, "deploy"))
  .filter((name) => /^docker-compose.*\.ya?ml$/.test(name))
  .map((name) => `deploy/${name}`)

describe("self-host compose images", () => {
  it("covers the deployment compose file", () => {
    expect(COMPOSE_FILES).toContain("deploy/docker-compose.yml")
  })

  for (const file of COMPOSE_FILES) {
    it(`${file} pins every image by digest, with its tag`, () => {
      const images = readFileSync(join(ROOT, file), "utf8")
        .split("\n")
        .map((line) => /^\s+image:\s*(\S+)\s*$/.exec(line)?.[1])
        .filter((image): image is string => image !== undefined)
      for (const image of images) {
        // The app image, set per release by LIAISON_IMAGE (the sandbox service
        // names it through the YAML alias).
        if (image.startsWith("${LIAISON_IMAGE") || image === "*liaison-image") continue
        expect(image, `${file}: ${image}`).toMatch(
          /^[a-z0-9./-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/,
        )
      }
    })
  }
})
