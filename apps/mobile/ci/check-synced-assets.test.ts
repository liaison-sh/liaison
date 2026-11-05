// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { applyMobileCsp } from "../scripts/boot-injection"

const SCRIPT = path.join(import.meta.dir, "check-synced-assets.ts")

const UNDER_POLICY = applyMobileCsp("<html><head></head></html>").html

function tree(contents: string, indexHtml = UNDER_POLICY): string {
  const dir = mkdtempSync(path.join(tmpdir(), "synced-assets-"))
  writeFileSync(path.join(dir, "index.html"), indexHtml)
  writeFileSync(path.join(dir, "app.js"), contents)
  return dir
}

async function run(dir: string): Promise<number> {
  const proc = Bun.spawn(["bun", SCRIPT, "--dir", dir], { stdout: "pipe", stderr: "pipe" })
  return await proc.exited
}

describe("the synced asset check", () => {
  it("passes a tree with no host path in it", async () => {
    expect(await run(tree('const base="/api/threads"\n'))).toBe(0)
  })

  it("fails a tree carrying the building machine's own directory", async () => {
    // The whole point: this is invisible on the machine that built it.
    expect(await run(tree('const p="/Users/someone/liaison/apps/web/src/main.tsx"\n'))).toBe(1)
  })

  it("fails a page without the phone's policy", async () => {
    expect(await run(tree("", "<html><head></head></html>"))).toBe(1)
  })

  it("fails a page under the policy that still carries an inline script", async () => {
    const inline = UNDER_POLICY.replace("</head>", "<script>1</script></head>")
    expect(await run(tree("", inline))).toBe(1)
  })
})
