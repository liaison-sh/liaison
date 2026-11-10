// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A read-only sandboxed tool runs the part of its app's bundle its handler
// needs: every call compiles and runs the bundle it is given in a fresh
// context, so for a large app (invoicing's is close to 1 MB) the full bundle
// was most of a timeline read. An export-only bundle that does not load falls
// back to the full one.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { registerApps } from "~/modules/apps/runtime"
import * as shakeModule from "~/modules/apps/sandbox/bundle-shake"
import {
  clearExportOnlyBundleCache,
  exportOnlyBundleCacheSize,
} from "~/modules/apps/sandbox/bundle-shake"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import * as runAppModule from "~/modules/apps/sandbox/run-app"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { insertSql } from "~/seed/factories/org/test-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const SCOPES = ["invoicing:documents:read", "invoicing:documents:write"]
const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: SCOPES,
  dimensionGrants: {},
}

const read = () =>
  executeTool({
    toolName: "invoicing:activity_read",
    orgId: ORG,
    actor,
    params: { contactIds: [crypto.randomUUID()], before: null, limit: 30, prefix: "invoicing:" },
    origin: "in-app-agent",
  })

/** Register the in-repo invoicing app in ORG as installed with `provenance`. */
async function registerInvoicing(provenance: {
  _firstParty?: boolean
  _publisherSigned?: boolean
}) {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps/invoicing/app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  await registerApps(
    [
      {
        ...manifest,
        trusted: false,
        _firstParty: false,
        ...provenance,
        _format: "manifest",
        _bundlePath: join(
          REPO_ROOT,
          "bundled-apps/invoicing",
          String(manifest.version),
          "bundle.js",
        ),
      } as never,
    ],
    ORG,
  )
}

/** The bundle each runApp call of this test was given, by export name. */
function recordBundles() {
  const seen: Array<{ exportName: string; length: number }> = []
  const real = runAppModule.runApp
  const spy = spyOn(runAppModule, "runApp").mockImplementation(async (opts) => {
    seen.push({ exportName: opts.exportName, length: opts.bundleSource?.length ?? -1 })
    return real(opts)
  })
  return { seen, restore: () => spy.mockRestore() }
}

describe("read-only tools and export-only bundles", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    await sql.unsafe(
      insertSql("kernel.organizations", {
        id: ORG,
        name: "Export bundles",
        slug: `eb-${ORG.slice(0, 8)}`,
      }),
    )
    await sql.unsafe(
      insertSql("kernel.users", {
        id: USER,
        org_id: ORG,
        email: `eb-${USER.slice(0, 8)}@example.test`,
        password_hash: "h",
        name: "Reader",
        status: "active",
      }),
    )
    await sql.unsafe(
      insertSql(
        "kernel.user_scope_grants",
        SCOPES.map((scope) => ({ user_id: USER, org_id: ORG, scope })),
      ),
    )
    await initSandboxPool()
    await initWorkerPool()
    await registerInvoicing({ _firstParty: true })
  }, 120_000)

  afterAll(async () => {
    resetAppRegistries()
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`.catch(() => undefined)
    await releaseTestLock()
  })

  it("a read-only tool runs a bundle much smaller than the app's once it is built, with the same answer", async () => {
    clearExportOnlyBundleCache()
    const { seen, restore } = recordBundles()
    try {
      const first = await read()
      let later = first
      for (let i = 0; i < 50 && (seen.at(-1)?.length ?? 0) >= (seen[0]?.length ?? 0); i++) {
        await Bun.sleep(20)
        later = await read()
      }
      const full = seen[0]?.length ?? 0
      const shaken = seen.at(-1)?.length ?? 0
      expect(full).toBeGreaterThan(0)
      expect(shaken).toBeGreaterThan(0)
      expect(shaken).toBeLessThan(full / 2)
      expect(later.data).toEqual(first.data)
      expect(later.data).toEqual({ rows: [] })
    } finally {
      restore()
    }
  }, 60_000)

  it("an export-only bundle that does not load is replaced by the full bundle for that call and later ones", async () => {
    clearExportOnlyBundleCache()
    const broken = spyOn(shakeModule, "exportOnlyBundle").mockImplementation(
      () => "var nothingHere = 1;",
    )
    const fallback = spyOn(shakeModule, "useFullBundle")
    const { seen, restore } = recordBundles()
    try {
      const out = await read()
      expect(out.data).toEqual({ rows: [] })
      expect(seen.map((s) => s.length)).toEqual(["var nothingHere = 1;".length, seen[1]?.length])
      expect(seen[1]?.length ?? 0).toBeGreaterThan(1000)
      expect(fallback).toHaveBeenCalledTimes(1)
    } finally {
      restore()
      broken.mockRestore()
      fallback.mockRestore()
    }
  }, 60_000)

  it("a handler that fails after reaching the host surfaces its error as it is, and is not rerun on the full bundle", async () => {
    clearExportOnlyBundleCache()
    const failing =
      'globalThis.activityReadHandler = async function (params, ctx) {\n  await ctx.db.findMany("documents", { limit: 1 });\n  throw new Error("Bundle evaluation error: raised by a nested hop");\n};\n'
    const broken = spyOn(shakeModule, "exportOnlyBundle").mockImplementation(() => failing)
    const fallback = spyOn(shakeModule, "useFullBundle")
    const { seen, restore } = recordBundles()
    try {
      const out = await read().catch((err: unknown) => err)
      // The handler's own failure (redacted for a sandboxed app, as any handler error is),
      // from the one run: no second run of the handler on the full bundle.
      expect(out).toBeInstanceOf(Error)
      expect((out as { code?: unknown }).code).toBe("tool_error")
      expect(seen.map((s) => s.length)).toEqual([failing.length])
      expect(fallback).not.toHaveBeenCalled()
    } finally {
      restore()
      broken.mockRestore()
      fallback.mockRestore()
    }
  }, 60_000)

  it("a third-party app's read-only tool, signed by a trusted publisher, always runs its full bundle and is never trimmed on the host", async () => {
    resetAppRegistries()
    await registerInvoicing({ _publisherSigned: true })
    clearExportOnlyBundleCache()
    const { seen, restore } = recordBundles()
    try {
      for (let i = 0; i < 6; i++) {
        expect((await read()).data).toEqual({ rows: [] })
        await Bun.sleep(50)
      }
      expect(seen.length).toBe(6)
      expect(new Set(seen.map((s) => s.length)).size).toBe(1)
      expect(seen[0]?.length ?? 0).toBeGreaterThan(100_000)
      expect(exportOnlyBundleCacheSize()).toBe(0)
    } finally {
      restore()
      resetAppRegistries()
      await registerInvoicing({ _firstParty: true })
    }
  }, 60_000)
})
