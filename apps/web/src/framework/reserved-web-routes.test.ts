// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every top-level segment of a Liaison page route is reserved as an app name: an
// app's tabs live at /<app name>, and a sandboxed app may navigate anywhere under
// it. A new page route that is not reserved fails here.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { isReservedWebRouteSegment, RESERVED_WEB_ROUTE_SEGMENTS } from "@liaison/shared"
import { describe, expect, it } from "vitest"

const SRC = resolve(__dirname, "..")

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(path)
  }
  return out
}

function firstSegment(path: string): string | null {
  const segment = path.split("/")[1] ?? ""
  return segment === "" || segment === "*" ? null : segment
}

describe("reserved web route segments", () => {
  it("App.tsx's routes are all reserved", () => {
    const app = readFileSync(join(SRC, "App.tsx"), "utf8")
    const paths = [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1] as string)
    expect(paths.length).toBeGreaterThan(5)
    const segments = new Set(paths.map(firstSegment).filter((s): s is string => s !== null))
    for (const segment of segments) {
      expect(isReservedWebRouteSegment(segment), `route segment '${segment}'`).toBe(true)
    }
  })

  it("the kernel's tab URL patterns are all reserved", () => {
    // Every tab type registered in the web client's own sources is a kernel page
    // (installed and bundled apps declare theirs in their manifests).
    const segments = new Set<string>()
    for (const file of sourceFiles(SRC)) {
      for (const m of readFileSync(file, "utf8").matchAll(/urlPattern:\s*"([^"]+)"/g)) {
        const segment = firstSegment(m[1] as string)
        if (segment) segments.add(segment)
      }
    }
    expect(segments.size).toBeGreaterThan(5)
    for (const segment of segments) {
      expect(isReservedWebRouteSegment(segment), `tab URL segment '${segment}'`).toBe(true)
    }
  })

  it("reserves nothing a first-party app is named", () => {
    const appsDir = resolve(SRC, "../../api/src/apps")
    const bundled = resolve(SRC, "../../../bundled-apps")
    const names = [...readdirSync(appsDir), ...readdirSync(bundled)]
    for (const name of names) {
      expect(RESERVED_WEB_ROUTE_SEGMENTS as readonly string[]).not.toContain(name)
    }
  })
})
