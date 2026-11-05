// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The documented `docker compose exec app liaison ...` needs the CLI shim
// (apps/api/bin/liaison) to resolve on PATH inside the runtime image. The shim
// shipped in the image but nothing linked it anywhere PATH reaches, so the
// command failed with "executable file not found". The image is too slow to
// build in a unit test, so this pins the Dockerfile's runtime stage instead.
import { describe, expect, it } from "bun:test"
import { readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")
const SHIM_IN_IMAGE = "/app/apps/api/bin/liaison"
// oven/bun's default PATH (the image sets no PATH of its own).
const IMAGE_PATH_DIRS = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
]

/** The instructions of the final (runtime) stage, continuation lines joined. */
function runtimeStage(): string[] {
  const text = readFileSync(join(ROOT, "apps/api/Dockerfile"), "utf8").replace(/\\\n/g, " ")
  const lines = text.split("\n").map((l) => l.trim())
  const start = lines.findIndex((l) => /^FROM\s+\S+\s+AS\s+runtime$/i.test(l))
  expect(start).toBeGreaterThanOrEqual(0)
  return lines.slice(start + 1).filter((l) => l && !l.startsWith("#"))
}

describe("apps/api/Dockerfile: liaison CLI shim", () => {
  it("links the shim into a PATH directory of the runtime image", () => {
    const stage = runtimeStage()
    const link = stage.find((l) => l.startsWith("RUN") && l.includes(`ln -s ${SHIM_IN_IMAGE} `))
    expect(link).toBeDefined()
    const target = link!.split(`ln -s ${SHIM_IN_IMAGE} `)[1]!.split(/\s|&&|;/)[0]!
    const dir = target.endsWith("/liaison") ? target.slice(0, -"/liaison".length) : target
    expect(IMAGE_PATH_DIRS).toContain(dir)
  })

  it("installs the link while still root, before the image drops to the bun user", () => {
    const stage = runtimeStage()
    const linkIdx = stage.findIndex((l) => l.includes(`ln -s ${SHIM_IN_IMAGE} `))
    const userIdx = stage.findIndex((l) => /^USER\s+bun$/.test(l))
    expect(userIdx).toBeGreaterThanOrEqual(0)
    expect(linkIdx).toBeGreaterThanOrEqual(0)
    expect(linkIdx).toBeLessThan(userIdx)
  })

  it("the shim the link points at is in the copied tree and executable", () => {
    const stage = runtimeStage()
    expect(stage).toContain("COPY apps/api /app/apps/api")
    const mode = statSync(join(ROOT, "apps/api/bin/liaison")).mode
    expect(mode & 0o111).not.toBe(0)
  })
})
