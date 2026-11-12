// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The contract harness enumerates the entry kinds app pages and provisioning
// add (a page's routes, the provisioning handler and its verify handler) and
// judges them like any other entry, on QuickJS and on the Workers-shaped
// executor, under their own row of the limit table.
import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pageFixtureManifest } from "~/modules/apps/__fixtures__/page-app/descriptor"
import { runLimits } from "~/modules/apps/run-limits"
import { contractEntries } from "./entries"
import { type AppUnderContract, runAppContract } from "./harness"
import { quickJsContractExecutor } from "./quickjs-isolate"
import { workerCoreContractExecutor } from "./worker-core-isolate"

describe("contract entries: routes and provisioning", () => {
  it("lists a page's route and both provisioning handlers with their kinds", () => {
    const entries = contractEntries(pageFixtureManifest as unknown as Record<string, unknown>)
    const of = (prefix: string) => entries.filter((e) => e.entry.startsWith(prefix))
    expect(of("route:")).toEqual([
      { entry: "route:greet", kind: "route", exportName: "greetRoute" },
    ])
    expect(of("provision:")).toEqual([
      { entry: "provision:handler", kind: "provision", exportName: "provision" },
      { entry: "provision:verify", kind: "provision", exportName: "verifySetup" },
    ])
    expect(runLimits("route").wallMs).toBeGreaterThan(0)
    expect(runLimits("provision").wallMs).toBe(60_000)
  })

  const entries = [
    { entry: "route:greet", kind: "route", exportName: "greetRoute" },
    { entry: "provision:handler", kind: "provision", exportName: "provision" },
  ] as const
  const judge = async (source: AppUnderContract["source"], dir: string, onWorkers: boolean) => {
    const out = await runAppContract(
      { app: "pagefx", dir, entries: [...entries], source, surface: [], fixtures: {} },
      onWorkers ? workerCoreContractExecutor : quickJsContractExecutor,
    )
    return Object.fromEntries(out.map((r) => [r.entry, r.reasons]))
  }

  it("judges a route entry and a cached provisioning handler on QuickJS", async () => {
    const script = `
async function greetRoute(p) { return { greeting: "Hello " + (p.body && p.body.name) } }
var seen = 0;
async function provision(p) { seen++; return { changed: seen > 1 ? ["again"] : [] } }
globalThis.greetRoute = greetRoute; globalThis.provision = provision;`
    const v = await judge({ script }, "/nonexistent", false)
    expect(v["route:greet"]).toEqual([])
    expect(v["provision:handler"]).toEqual(["module-state"])
  })

  it("judges the same on the Workers-shaped executor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "contract-entries-"))
    try {
      const modulePath = join(dir, "app.mjs")
      writeFileSync(
        modulePath,
        `let seen = 0
export async function greetRoute(p) { return { greeting: "Hello " + (p.body && p.body.name) } }
export async function provision() { seen++; return { changed: seen > 1 ? ["again"] : [] } }
`,
      )
      const v = await judge({ modulePath }, dir, true)
      expect(v["route:greet"]).toEqual([])
      expect(v["provision:handler"]).toEqual(["module-state"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
