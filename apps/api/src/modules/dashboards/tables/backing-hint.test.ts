// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The kernel's table tools name no app: the backings tables_edit offers are read from the
// registry the apps fill (`entities.<e>.tableBacking`), and the kernel's tool text carries no
// app's name or fields.

import { afterEach, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { tableBackingRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { backingHint, registerTableTools } from "~/modules/dashboards/tables/tools"

const orgId = randomUUID()

afterEach(() => {
  tableBackingRegistry.deleteByPrefix([orgId])
})

describe("tables_edit names the backings the org's apps declare", () => {
  it("lists none when no app declares one, and the one an app declares", async () => {
    registerTableTools(orgId)
    const tool = toolRegistry.get([orgId, "kernel", "tables_edit"])!
    expect(backingHint(orgId)).toBe("")
    expect(tool.description).not.toContain("Backings offered here")
    tableBackingRegistry.set([orgId, "acme", "widget"], {
      parent: "crate",
      provider: "widgetBacking",
      load: async () => ({}),
    })
    expect(backingHint(orgId)).toContain(
      '{app:"acme", entity:"widget", parentId:<its crate\'s id>}',
    )
    // Read when the catalog is built, so an app registered after the kernel tools shows.
    expect(tool.description).toContain('app:"acme"')
  })

  it("the kernel's dashboard tool sources name no app", () => {
    for (const file of ["tools.ts", join("..", "tools.ts")]) {
      const text = readFileSync(join(import.meta.dir, file), "utf8")
      expect(text).not.toMatch(/app:\s*\\?"projects\\?"/)
      expect(text).not.toContain("projects:tasks")
    }
  })
})
