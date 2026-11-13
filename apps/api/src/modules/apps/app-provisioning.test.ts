// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Declarative provisioning: `config apply --dry-run` and `config verify` are
// drift checks an operator may run from CI. They must write nothing, and that is
// enforced by the bridge (a read-only run), not promised by the app's handler.
import { afterEach, describe, expect, it } from "bun:test"
import { READ_ONLY_RUN_BLOCKED_CODE } from "~/modules/agent/runtime/read-only-run"
import {
  AppProvisioningTestAccess,
  type ProvisionExecutor,
  provisionBridge,
  runAppProvisioning,
  runAppProvisioningVerify,
} from "~/modules/apps/app-provisioning"
import { appSurfaceRegistry } from "~/modules/apps/app-surface"

const ORG = "00000000-0000-0000-0000-0000000f7a01"
const APP = "provtest"

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
    return undefined
  } catch (err) {
    return (err as { code?: string }).code
  }
}

describe("provisioning dry runs cannot write", () => {
  it("a dry-run bridge refuses an insert and a data-store write", async () => {
    const bridge = (await provisionBridge(APP, ORG, true)) as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >
    expect(await codeOf(bridge.db_insert!("things", JSON.stringify({ title: "x" })))).toBe(
      READ_ONLY_RUN_BLOCKED_CODE,
    )
    expect(await codeOf(bridge.store_set!("k", JSON.stringify({ v: 1 })))).toBe(
      READ_ONLY_RUN_BLOCKED_CODE,
    )
  })

  it("an applying run's bridge is not read-only", async () => {
    const bridge = (await provisionBridge(APP, ORG, false)) as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >
    expect(await codeOf(bridge.store_set!("k", JSON.stringify({ v: 1 })))).not.toBe(
      READ_ONLY_RUN_BLOCKED_CODE,
    )
  })

  describe("the executor is told which runs are read-only", () => {
    const seen: Array<{ exportName: string; readOnly: boolean }> = []
    const executor: ProvisionExecutor = async ({ exportName, readOnly }) => {
      seen.push({ exportName, readOnly })
      return exportName === "verify" ? { ok: true } : { changed: [] }
    }
    afterEach(() => {
      AppProvisioningTestAccess.setExecutor(null)
      appSurfaceRegistry.delete([ORG, APP])
      seen.length = 0
    })

    it("dry run and verify are read-only; apply is not", async () => {
      appSurfaceRegistry.set([ORG, APP], {
        appName: APP,
        bundlePath: "/nonexistent",
        provisioning: { schema: { type: "object" }, handler: "provision", verify: "verify" },
      } as never)
      AppProvisioningTestAccess.setExecutor(executor)
      await runAppProvisioning({ orgId: ORG, appName: APP, config: {}, dryRun: true })
      await runAppProvisioning({ orgId: ORG, appName: APP, config: {}, dryRun: false })
      await runAppProvisioningVerify({ orgId: ORG, appName: APP, config: {} })
      expect(seen).toEqual([
        { exportName: "provision", readOnly: true },
        { exportName: "provision", readOnly: false },
        { exportName: "verify", readOnly: true },
      ])
    })
  })
})
