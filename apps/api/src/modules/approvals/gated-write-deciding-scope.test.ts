// SPDX-License-Identifier: FSL-1.1-ALv2
//
// GUARD: a write that can park an approval is never decided by a mere read scope.
//
// A credit note staged on a turn that had read customer data parked as a disclosure decision
// (scope-taint.ts, rule 8h), decided by the read scope the turn held. Its tool is not `gated` but
// `conditionalGate` (its handler parks the call itself, and runs it once any approval of the call
// was granted), so a person who could only read contacts approved it and the credit note issued.
//
// For every tool that can ask for an approval (`gated`, `conditionalGate`, `gatedWhen`), in the
// kernel, the in-tree apps and every bundled app's manifest:
//   - its deciding scope is not a read scope, unless the tool itself requires that very scope
//     (the person in a conversation lifting its own outside-text mark), and
//   - a tool whose own code parks approvals (`gated`, `conditionalGate`) is never decided by the
//     turn's taint alone (`taintMayDecideAlone`, the predicate execute-tool's rule 8h uses).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { decidingScopeForToolDef, taintMayDecideAlone } from "~/modules/approvals/authority"
import { initializedOrgRuntimes, toolRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createTestOrg } from "~/tests/helpers/org"

type ToolDef = {
  gated?: boolean
  conditionalGate?: boolean
  gatedWhen?: unknown
  approveScope?: string
  requiredScopes?: readonly string[]
}

const BUNDLED = join(import.meta.dir, "..", "..", "..", "..", "..", "bundled-apps")

/** `app:resource:read`, `app:read`: a scope that only reads. */
const isReadScope = (scope: string): boolean => scope.split(":").at(-1) === "read"

/** Why `tool` breaks the rule, or null. */
function offence(app: string, name: string, tool: ToolDef): string | null {
  const parksOwn = tool.gated === true || tool.conditionalGate === true
  if (!parksOwn && tool.gatedWhen === undefined) return null
  const deciding = decidingScopeForToolDef(tool, app)
  if (isReadScope(deciding) && !(tool.requiredScopes ?? []).includes(deciding)) {
    return `${app}:${name} is decided by the read scope ${deciding}`
  }
  if (parksOwn && taintMayDecideAlone(tool)) {
    return `${app}:${name} parks its own approvals but a tainted turn's read scopes may decide it`
  }
  return null
}

describe("a write that can park an approval is decided by its own deciders, never a read scope", () => {
  let orgId: string

  beforeAll(async () => {
    orgId = (await createTestOrg()).id
    await ensureAppsForOrg(orgId)
  })

  afterAll(() => {
    initializedOrgRuntimes.delete(orgId)
  })

  it("the predicate keeps every self-gating tool out of the disclosure-only path", () => {
    expect(taintMayDecideAlone({})).toBe(true)
    expect(taintMayDecideAlone({ gated: true })).toBe(false)
    expect(taintMayDecideAlone({ conditionalGate: true })).toBe(false)
  })

  it("registered tools (kernel and in-tree apps)", () => {
    const offenders: string[] = []
    let checked = 0
    for (const [[, app, name], tool] of toolRegistry.entriesOf(orgId)) {
      const def = tool as ToolDef
      if (def.gated !== true && def.conditionalGate !== true && def.gatedWhen === undefined)
        continue
      checked++
      const why = offence(app, name, def)
      if (why) offenders.push(why)
    }
    expect(checked).toBeGreaterThan(0)
    expect(offenders).toEqual([])
  })

  it("bundled apps' manifests", () => {
    const offenders: string[] = []
    let checked = 0
    for (const app of readdirSync(BUNDLED)) {
      let manifest: { name: string; tools?: Record<string, ToolDef> }
      try {
        manifest = JSON.parse(readFileSync(join(BUNDLED, app, "app.manifest.json"), "utf8"))
      } catch {
        continue
      }
      for (const [name, tool] of Object.entries(manifest.tools ?? {})) {
        if (tool.gated !== true && tool.conditionalGate !== true) continue
        checked++
        const why = offence(manifest.name, name, tool)
        if (why) offenders.push(why)
      }
    }
    // Invoicing alone declares its credit notes, quotes and purchase orders this way.
    expect(checked).toBeGreaterThan(20)
    expect(offenders).toEqual([])
  })
})
