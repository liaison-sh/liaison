// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { loadViewerAccess, NO_ACCESS, toViewerAccess } from "./access"

afterEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: clear the global host slot.
  ;(globalThis as any).__liaisonHost = undefined
  // biome-ignore lint/suspicious/noExplicitAny: clear the bound app name.
  ;(globalThis as any).__LIAISON_TEST_APP_NAME = undefined
})

describe("viewer access", () => {
  it("normalises the tool result; an error or junk grants nothing", () => {
    expect(toViewerAccess({ documents_write: true, settings_read: false, approve: true })).toEqual({
      documents_write: true,
      settings_read: false,
      approve: true,
    })
    expect(toViewerAccess({ status: "error", error: { code: "forbidden" } })).toEqual(NO_ACCESS)
    expect(toViewerAccess(null)).toEqual(NO_ACCESS)
    expect(toViewerAccess({ documents_write: "yes" })).toEqual(NO_ACCESS)
  })

  it("a failed read grants nothing and is retried on the next call", async () => {
    let calls = 0
    // biome-ignore lint/suspicious/noExplicitAny: global host slot the @liaison/host shim reads.
    ;(globalThis as any).__LIAISON_TEST_APP_NAME = "invoicing"
    // biome-ignore lint/suspicious/noExplicitAny: global host slot the @liaison/host shim reads.
    ;(globalThis as any).__liaisonHost = {
      invokeTool: async (_app: string, tool: string) => {
        calls++
        if (calls === 1) throw new Error("offline")
        expect(tool).toBe("viewer_access")
        return { documents_write: true, settings_read: true, approve: false }
      },
    }
    expect(await loadViewerAccess()).toEqual(NO_ACCESS)
    expect(await loadViewerAccess()).toEqual({ documents_write: true, settings_read: true, approve: false })
    expect(calls).toBe(2)
  })

  it("the sidebar offers writes only to a viewer holding documents:write", () => {
    const sidebar = readFileSync(join(import.meta.dir, "sidebar.tsx"), "utf-8")
    expect(sidebar).toContain("loadViewerAccess")
    expect(sidebar).toMatch(/<Show when=\{canWrite\(\)\}>\s*<NewDocCta \/>/)
    expect(sidebar).toMatch(/<Show when=\{canDecide\(\)\}>\s*<Row\s+href="\/invoicing\/pending-approval"/)
    expect(sidebar).toMatch(/<Show when=\{canWrite\(\)\}>\s*<SectionHeader label=\{tr\("Admin"\)\}/)
  })
})
