// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The web build id covers every byte the server serves for the shell: what
// Rollup emitted, what Vite copied from public/ (the service worker,
// _app-runtime/) and the app frame files, so a signed shell statement looked up
// by that id always describes the bytes served.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  bakeWebBuildId,
  computeWebBuildId,
  readBuildFiles,
  stampWebBuildId,
  WEB_BUILD_ID_TOKEN,
} from "./stamp-build-id"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const PAGE = `<html><meta name="liaison-web-build" content="${WEB_BUILD_ID_TOKEN}"></html>`

function dist(overrides: Record<string, string> = {}): string {
  const files: Record<string, string> = {
    "index.html": PAGE,
    "assets/index-a.js": "const x=1;",
    "liaison-sw.js": "self.addEventListener('fetch',()=>{})",
    "_app-runtime/solid-js.js": "export {}",
    "app-frame-runtime.js": "(()=>{})()",
    ...overrides,
  }
  const d = mkdtempSync(join(tmpdir(), "web-build-id-"))
  dirs.push(d)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(d, rel)), { recursive: true })
    writeFileSync(join(d, rel), text)
  }
  return d
}

describe("web build id", () => {
  it("is a content hash of the whole build, written into index.html and build-id.txt", () => {
    const d = dist()
    const expected = computeWebBuildId(readBuildFiles(d))
    const id = stampWebBuildId(d)
    expect(id).toBe(expected)
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(readFileSync(join(d, "build-id.txt"), "utf8")).toBe(`${id}\n`)
    expect(readFileSync(join(d, "index.html"), "utf8")).toContain(`content="${id}"`)
    expect(readFileSync(join(d, "assets/index-a.js"), "utf8")).toBe("const x=1;")
    // Same content elsewhere, same id: an unchanged redeploy prompts nobody.
    expect(stampWebBuildId(dist())).toBe(id)
  })

  it("changes when only a public/ file or only the app frame changes", () => {
    const base = stampWebBuildId(dist())
    const ids = [
      stampWebBuildId(dist({ "liaison-sw.js": "self.addEventListener('fetch',()=>{1})" })),
      stampWebBuildId(dist({ "_app-runtime/solid-js.js": "export const a=1" })),
      stampWebBuildId(dist({ "app-frame-runtime.js": "(()=>{1})()" })),
      stampWebBuildId(dist({ "app-frame.html": "<html>frame</html>" })),
      stampWebBuildId(dist({ "assets/index-a.js": "const x=2;" })),
    ]
    for (const id of ids) expect(id).not.toBe(base)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("refuses an index.html without the placeholder, another file carrying it, and a second stamp", () => {
    expect(() => stampWebBuildId(dist({ "index.html": "<html>" }))).toThrow(/placeholder/)
    // A chunk keeps its hashed name when its source is unchanged, so an id
    // baked into it would be served stale from the immutable cache after a
    // deploy.
    expect(() =>
      stampWebBuildId(dist({ "assets/index-a.js": `const x="${WEB_BUILD_ID_TOKEN}";` })),
    ).toThrow(/assets\/index-a\.js/)
    const d = dist()
    stampWebBuildId(d)
    expect(() => stampWebBuildId(d)).toThrow(/already has a build-id.txt/)
  })

  it("hashes the pages with the placeholder, so the id never depends on itself", () => {
    const files = readBuildFiles(dist())
    const { id, pages } = bakeWebBuildId(files)
    expect([...pages.keys()]).toEqual(["index.html"])
    expect(pages.get("index.html")).toBe(PAGE.split(WEB_BUILD_ID_TOKEN).join(id))
    expect(computeWebBuildId(files)).toBe(id)
  })
})
