// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A double-prefixed api path is a 404 that no type checks and no unit test of
// the calling module can see: `api.get("/api/files/...")` is appended to
// `env.API_BASE`, which is already "/api", so the request goes to
// "/api/api/files/...". It shipped in the approval card's sealed-attachment
// fetches, where the only symptom was that an approved gated send with a sealed
// attachment always refused.
//
// So this is a source-level oracle rather than a per-call-site test: every call
// site is one line, and there is no useful test to write for each of them.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = `${join(process.cwd(), "src")}/`

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === "tests") continue
      sourceFiles(path, out)
      continue
    }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(path)
  }
  return out
}

/**
 * `api.get("/api/...")`, `api.rawGet('/api/...')`, and friends, with or without a
 * type argument: `api.get<View>("/api/...")` slipped past (the Drive picker card
 * fetched "/api/api/google-drive/picker", so it never drew).
 */
const DOUBLE_PREFIX =
  /\b(?:get|rawGet|getEnvelope|post|patch|put|delete)(?:<[^>()]*(?:<[^>()]*>[^>()]*)*>)?\(\s*[`'"]\/api\//

/**
 * Clients built on the server ORIGIN, not on `/api`: their paths carry `/api`
 * themselves. host-services' tool client has `baseUrl` = the origin (or "").
 */
const ORIGIN_CLIENTS = new Set(["framework/host-services.ts"])

describe("api client paths", () => {
  it("are kernel relative, never prefixed with /api a second time", () => {
    const offenders: string[] = []
    for (const file of sourceFiles(ROOT)) {
      if (ORIGIN_CLIENTS.has(file.slice(ROOT.length))) continue
      const source = readFileSync(file, "utf8")
      for (const [index, line] of source.split("\n").entries()) {
        if (DOUBLE_PREFIX.test(line)) {
          offenders.push(`${file.slice(ROOT.length)}:${index + 1}: ${line.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("finds the pattern it is looking for", () => {
    // Non-vacuity: the matcher really does catch a double-prefixed call.
    expect(DOUBLE_PREFIX.test("const x = await api.get(`/api/files/${id}/metadata`)")).toBe(true)
    expect(DOUBLE_PREFIX.test("const x = await api.get(`/files/${id}/metadata`)")).toBe(false)
    expect(DOUBLE_PREFIX.test('setState(await api.get<View>("/api/google-drive/picker"))')).toBe(
      true,
    )
    expect(DOUBLE_PREFIX.test('await api.post<{ url: string }>("/api/google-drive/x", {')).toBe(
      true,
    )
    expect(DOUBLE_PREFIX.test('await api.get<View>("/google-drive/picker")')).toBe(false)
  })
})
