// SPDX-License-Identifier: FSL-1.1-ALv2
//
// BL-188 — the kernel `export` tool PARTIAL-SUCCEEDS: it exports the requested apps that HAVE a local
// export handler and SKIPS the ones that don't (a pure live connector like `shopify`, which stores no
// local data), rather than hard-erroring the whole call. Only a request where NOTHING is exportable
// errors. This is what unblocks `org-data-backup-export` (appNames: invoicing + shopify).
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { exportRegistry } from "~/modules/apps/app-registries"
import * as initModule from "~/modules/apps/init"
import { handleKernelExport } from "~/modules/export/kernel-export-tool"

const ORG = "00000000-0000-0000-0000-0000000000e1"

describe("handleKernelExport — partial success [BL-188]", () => {
  afterEach(() => {
    mock.restore()
    exportRegistry.delete([ORG, "invoicing"])
  })

  function noopEnsure() {
    // The org's apps are irrelevant to the pre-flight split; stub the install so the unit test needs no DB.
    spyOn(initModule, "ensureAppsForOrg").mockImplementation(async () => {})
  }
  function registerInvoicing() {
    exportRegistry.set([ORG, "invoicing"], {
      formats: ["json", "csv"],
      handler: async (_ctx, _format) => [],
    })
  }

  it("exports apps WITH a handler and SKIPS connector apps with none", async () => {
    noopEnsure()
    registerInvoicing()
    const r = await handleKernelExport(
      { appNames: ["invoicing", "shopify"], format: "csv" },
      { orgId: ORG, userId: "u1" },
    )
    if ("error" in r) throw new Error(`expected success, got ${r.error}`)
    expect(r.apps).toEqual(["invoicing"])
    expect(r.skipped).toEqual(["shopify"])
    expect(r.downloadRef).toContain("apps=invoicing")
    expect(r.downloadRef).not.toContain("shopify")
    expect(r.format).toBe("csv")
  })

  it("errors only when NO requested app has a local export handler", async () => {
    noopEnsure()
    const r = await handleKernelExport(
      { appNames: ["shopify"], format: "csv" },
      { orgId: ORG, userId: "u1" },
    )
    expect("error" in r).toBe(true)
  })

  it("rejects when no app is selected", async () => {
    noopEnsure()
    const r = await handleKernelExport({ appNames: [] }, { orgId: ORG, userId: "u1" })
    expect("error" in r).toBe(true)
  })
})
