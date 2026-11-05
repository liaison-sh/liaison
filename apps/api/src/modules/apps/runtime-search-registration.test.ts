// SPDX-License-Identifier: FSL-1.1-ALv2
//
// C2 regression guard (deep-review 2026-05-28). The original "dead search"
// bug was that the install loop never wired a manifest's `search.handler` into
// the kernel fanout, so the global-search UI silently surfaced no external
// hits. The later C2 fix added that wiring in `registerSingleApp`
// (runtime.ts) — `makeSandboxSearchHandler` + `registerExternalSearchHandler`
// on install, `unregisterExternalSearchHandler` on teardown — but no test
// exercised the install loop itself: runtime.test.ts only covers DDL, and
// external-handlers.test.ts only registers handlers by hand.
//
// This test drives the REAL `registerApps` / `teardownAppRegistrations` loop
// with a manifest-format descriptor that declares a `search` block, and
// asserts the install loop registers an external-search handler for the org
// (and removes it on teardown). It spies on the registry's register/unregister
// surface so it does not need to stand up the QuickJS sandbox — the assertion
// is about the wiring, not the bundle execution (bundle dispatch is covered by
// external-handlers.test.ts).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { sql } from "~/db"
import { resetAppRegistries } from "~/modules/apps/app-registries"
// HERMETICITY (mock.module global-leak class): spread the REAL module so the
// stub is COMPLETE (other importers — search/service.test, external-handlers.test,
// runtime-teardown.test — keep every real export), and re-install the real
// module in `afterAll`. See `mock-module-hygiene.test.ts` for the guard.
import * as realExternalHandlers from "~/modules/search/external-handlers"

// Capture register/unregister calls. We preserve the real module surface
// (fanoutExternal, key, etc.) and only intercept the two functions the install
// loop calls, so other importers keep working.
const registerCalls: Array<{ orgId: string; app: string }> = []
const unregisterCalls: Array<{ orgId: string; app: string }> = []

// Eager snapshot: `realExternalHandlers` is a LIVE namespace view, so
// mock.module patches it in place — spreading it inside the restore factory
// would re-install the mock. Snapshot the real exports BEFORE the mock.
const realExternalHandlersModule = { ...realExternalHandlers }

mock.module("~/modules/search/external-handlers", () => ({
  ...realExternalHandlersModule,
  registerExternalSearchHandler: (orgId: string, app: string) => {
    registerCalls.push({ orgId, app })
  },
  unregisterExternalSearchHandler: (orgId: string, app: string) => {
    unregisterCalls.push({ orgId, app })
  },
}))

const { registerApps, teardownAppRegistrations } = await import("~/modules/apps/runtime")

const TEST_ORG_ID = "00000000-0000-0000-0000-0000000c2001"
const APP_NAME = "search-reg-test"
// A bundle path is required to reach the search-registration branch
// (`isManifestFormat && bundlePath`). The handler is never loaded in this test
// (register is mocked), so the file only needs to exist as a path string.
const BUNDLE_PATH = `${import.meta.dir}/../../../test-support/apps/test-bridge-a/handlers.ts`

function manifestDescriptor() {
  return {
    name: APP_NAME,
    version: "1.0.0",
    _format: "manifest",
    _bundlePath: BUNDLE_PATH,
    trusted: true,
    search: { handler: "searchHandler", entities: ["order"], timeoutMs: 4000 },
  } as unknown as Parameters<typeof registerApps>[0][number]
}

describe("registerApps — external search handler install/teardown wiring (C2)", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${TEST_ORG_ID}, 'Search Reg Org', 'search-reg-org')
      ON CONFLICT (id) DO NOTHING`
  })

  beforeEach(() => {
    registerCalls.length = 0
    unregisterCalls.length = 0
    resetAppRegistries()
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.apps WHERE name = ${APP_NAME}`
    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_search_reg_test" CASCADE`)
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG_ID}`
    // Re-install the real module so the overrides do not leak to later files.
    mock.module("~/modules/search/external-handlers", () => realExternalHandlersModule)
  })

  it("registers an external-search handler for the org when the manifest declares a `search` block", async () => {
    await registerApps([manifestDescriptor()], TEST_ORG_ID)
    expect(registerCalls).toContainEqual({ orgId: TEST_ORG_ID, app: APP_NAME })
  })

  it("teardown unregisters the org's external-search handler", async () => {
    await registerApps([manifestDescriptor()], TEST_ORG_ID)
    await teardownAppRegistrations(TEST_ORG_ID, APP_NAME)
    expect(unregisterCalls).toContainEqual({ orgId: TEST_ORG_ID, app: APP_NAME })
  })

  it("does NOT register a search handler when the manifest omits the `search` block", async () => {
    const noSearch = {
      name: APP_NAME,
      version: "1.0.0",
      _format: "manifest",
      _bundlePath: BUNDLE_PATH,
      trusted: true,
    } as unknown as Parameters<typeof registerApps>[0][number]
    await registerApps([noSearch], TEST_ORG_ID)
    expect(registerCalls).toHaveLength(0)
  })
})
