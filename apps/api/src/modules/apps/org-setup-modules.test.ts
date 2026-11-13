// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An org's first touch must not evaluate modules on the event loop: the modules
// its setup imports are loaded by the server's boot (loadOrgSetupModules), before
// the process takes a job or turns ready. A module the setup starts importing
// without joining that list would block the first org's job or request again.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const INIT = readFileSync(join(import.meta.dir, "init.ts"), "utf8")
const INDEX = readFileSync(join(import.meta.dir, "../../index.ts"), "utf8")

/** The body of a top-level function of init.ts, up to the next top-level declaration. */
function body(name: string): string {
  const start = INIT.search(new RegExp(`^(export )?(async )?function ${name}\\b`, "m"))
  if (start < 0) throw new Error(`init.ts has no function ${name}`)
  const rest = INIT.slice(start + 1)
  const end = rest.search(/^(export |async |function |const |let |interface |type |\/\*\*)/m)
  return end < 0 ? rest : rest.slice(0, end)
}

const imports = (src: string): string[] =>
  [...src.matchAll(/import\("([^"]+)"\)/g)].map((m) => m[1] as string)

describe("the modules of an org's setup", () => {
  const loaded = new Set(imports(body("loadOrgSetupModules")))

  it("every module the setup imports is loaded before the first org's setup", () => {
    const setup = ["awaitOrgApps", "orgRegistration", "setUpOrg", "initAppsForOrg"].flatMap((fn) =>
      imports(body(fn)),
    )
    expect(setup.length).toBeGreaterThan(5)
    expect(setup.filter((m) => !loaded.has(m))).toEqual([])
  })

  it("the server's boot loads them before it hosts jobs and before it turns ready", () => {
    const load = INDEX.indexOf("await loadOrgSetupModules()")
    expect(load).toBeGreaterThan(0)
    expect(load).toBeLessThan(INDEX.indexOf("hostJobWorkers()"))
    expect(load).toBeLessThan(INDEX.indexOf("markBootComplete()"))
    expect(load).toBeLessThan(INDEX.indexOf("registerOutboxSingleton()"))
  })

  it("they load without setting any org up", async () => {
    const { loadOrgSetupModules } = await import("./init")
    const { initializedOrgRuntimes } = await import("./app-registries")
    const before = initializedOrgRuntimes.size
    await loadOrgSetupModules()
    expect(initializedOrgRuntimes.size).toBe(before)
  })
})
