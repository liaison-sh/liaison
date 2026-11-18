// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Agents never sign. Read from the source, with no server: (a) the one decide is
// imported only by the public client action routes and the portal routes, so no
// tool handler reaches it; (b) no tool's name signs, decides or accepts a client
// action; (c) a decision is written in exactly two files, the one decide and the
// demo decide, and the demo decide is reached only from the services world's
// acceptance step; (d) no app manifest declares a write to the client actions
// table, and in the kernel only the gated create and the withdraw do.
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

/** A raw UPDATE of the client actions table whose SET clause writes `decided_at`. */
const DECISION_WRITE_SQL = /UPDATE\s+[^;`]*?client_actions\b[\s\S]*?\bSET\b([\s\S]*?)\bWHERE\b/g
/** The same through the query builder: `.update(clientActions).set({ ... decidedAt`. */
const DECISION_WRITE_ORM = /\.update\(\s*clientActions\s*\)\s*\.set\(\s*\{[^}]*\bdecidedAt\b/g

function decisionWrites(text: string): number {
  let n = 0
  for (const m of text.matchAll(DECISION_WRITE_SQL)) if (/\bdecided_at\s*=/.test(m[1] ?? "")) n++
  n += [...text.matchAll(DECISION_WRITE_ORM)].length
  return n
}

/** Files (relative to the api source, or to the repo for bundled apps) that write a decision. */
function decisionWriters(files: string[]): string[] {
  return files
    .filter((f) => decisionWrites(readFileSync(f, "utf8")) > 0)
    .map((f) => (f.startsWith(API_SRC) ? relative(API_SRC, f) : relative(ROOT, f)))
    .sort()
}

const DEMO_DECIDE_IMPORT =
  /from\s+["'](?:~\/modules\/client-actions\/demo-decide|\.\/demo-decide|\.\.\/client-actions\/demo-decide|[./]*modules\/client-actions\/demo-decide)["']/

describe("who writes a decision", () => {
  const files = () => [...sourceFiles(API_SRC), ...sourceFiles(join(ROOT, "bundled-apps"))]

  it("only the one decide and the demo decide write a decision", () => {
    expect(decisionWriters(files())).toEqual([
      "modules/client-actions/decide.ts",
      "modules/client-actions/demo-decide.ts",
    ])
  })

  it("the decision scan catches a raw update and a query-builder update in another file", () => {
    const raw =
      "await tx.execute(sql`UPDATE kernel.client_actions SET decision = 'signed', decided_at = now() WHERE id = $1`)"
    const orm = "await tx.update(clientActions).set({ decision: 'signed', decidedAt: new Date() })"
    const rotate =
      "await tx.execute(sql`UPDATE kernel.client_actions SET sent_at = NULL WHERE decided_at IS NULL`)"
    expect(decisionWrites(raw)).toBe(1)
    expect(decisionWrites(orm)).toBe(1)
    expect(decisionWrites(rotate)).toBe(0)
  })

  it("the demo decide is imported only by the services world's acceptance step", () => {
    const importers = files()
      .filter((f) => DEMO_DECIDE_IMPORT.test(readFileSync(f, "utf8")))
      .map((f) => relative(API_SRC, f))
      .sort()
    expect(importers).toEqual(["modules/demo/worlds/studio/cr-accepted.ts"])
  })

  it("decide.ts exports no other function that writes a decision", () => {
    const text = readFileSync(join(API_SRC, "modules/client-actions/decide.ts"), "utf8")
    expect(decisionWrites(text)).toBe(1)
    const start = text.indexOf("export async function decideClientAction(")
    expect(start).toBeGreaterThan(-1)
    const next = text.indexOf("\nexport ", start + 1)
    const body = text.slice(start, next === -1 ? undefined : next)
    expect(decisionWrites(body)).toBe(1)
    // And the demo decide writes one, in its one exported function.
    const demo = readFileSync(join(API_SRC, "modules/client-actions/demo-decide.ts"), "utf8")
    expect(decisionWrites(demo)).toBe(1)
    const exported = [...demo.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1])
    expect(exported).toEqual(["decideDemoClientAction"])
  })
})
