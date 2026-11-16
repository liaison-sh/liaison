// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Agents never sign. Read from the source, with no server: (a) the one decide is
// imported only by the public client action routes and the portal routes, so no
// tool handler reaches it; (b) no tool's name signs, decides or accepts a client
// action; (d) no app manifest declares a write to the client actions table, and
// in the kernel only the gated create and the withdraw do.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { loadBenchCatalog } from "~/modules/agent/tools/tool-bench/catalog"

const API_SRC = join(import.meta.dir, "..", "..")
const ROOT = join(API_SRC, "..", "..", "..")

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

const DECIDE_IMPORT =
  /from\s+["'](?:~\/modules\/client-actions\/decide|\.\/decide|\.\.\/client-actions\/decide)["']/

/** Files that import the decide module and name the decide function from it. */
function decideImporters(files: string[]): string[] {
  return files
    .filter((f) => {
      const text = readFileSync(f, "utf8")
      return DECIDE_IMPORT.test(text) && /\bdecideClientAction\b/.test(text)
    })
    .map((f) => relative(API_SRC, f))
    .sort()
}

describe("agents never sign", () => {
  it("only the public client action routes and the portal routes import the one decide", () => {
    const files = [...sourceFiles(API_SRC), ...sourceFiles(join(ROOT, "bundled-apps"))]
    const allowed = new Set(["modules/client-actions/public-routes.ts", "modules/portal/routes.ts"])
    expect(decideImporters(files).filter((f) => !allowed.has(f))).toEqual([])
    expect(decideImporters(files)).toContain("modules/client-actions/public-routes.ts")
  })

  it("the import check catches a tool file that reaches the decide", () => {
    const probe = join(API_SRC, "modules", "client-actions", "tools.ts")
    const text = `import { decideClientAction } from "./decide"\n${readFileSync(probe, "utf8")}`
    expect(DECIDE_IMPORT.test(text) && /\bdecideClientAction\b/.test(text)).toBe(true)
  })

  it("no tool's name signs, decides or accepts a client action", () => {
    const names = loadBenchCatalog().map((t) => t.sdkName)
    expect(names).toContain("kernel__client_action_create")
    const actsForClient = names.filter(
      (n) =>
        /client_?action/i.test(n) &&
        /(sign|decide|decision|accept|approve)/i.test(n.replace(/^kernel__/, "")),
    )
    expect(actsForClient).toEqual([])
    // Nor any tool that names a signature of the person outside.
    expect(names.filter((n) => /(sign_for|sign_as|signature_create|decide_for)/i.test(n))).toEqual(
      [],
    )
  })

  it("no app manifest writes the client actions table; in the kernel only create and withdraw do", () => {
    const manifests = readdirSync(join(ROOT, "bundled-apps"))
      .map((a) => join(ROOT, "bundled-apps", a, "app.manifest.json"))
      .filter((p) => {
        try {
          return statSync(p).isFile()
        } catch {
          return false
        }
      })
    expect(manifests.length).toBeGreaterThan(5)
    const writers: string[] = []
    for (const p of manifests) {
      const m = JSON.parse(readFileSync(p, "utf8")) as {
        tools?: Record<string, { writesToTable?: string | string[] }>
      }
      for (const [name, t] of Object.entries(m.tools ?? {})) {
        const w = [t.writesToTable ?? []].flat().join(",")
        if (/client_actions/.test(w)) writers.push(`${relative(ROOT, p)}:${name}`)
      }
    }
    expect(writers).toEqual([])
    const kernelWriters = sourceFiles(API_SRC)
      .filter((f) =>
        /writesToTable:\s*["']kernel\.client_actions["']/.test(readFileSync(f, "utf8")),
      )
      .map((f) => relative(API_SRC, f))
    expect(kernelWriters).toEqual(["modules/client-actions/tools.ts"])
    const tools = readFileSync(join(API_SRC, "modules/client-actions/tools.ts"), "utf8")
    expect(tools.match(/writesToTable:\s*"kernel\.client_actions"/g)).toHaveLength(2)
    expect(tools).not.toMatch(/\bdecideClientAction\b/)
  })
})
