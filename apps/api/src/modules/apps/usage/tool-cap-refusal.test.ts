// SPDX-License-Identifier: FSL-1.1-ALv2
// A sandboxed tool refused at an app day cap answers the typed refusal (429,
// APP_RUNS_LIMIT_REACHED, {limit, used}) through the tool envelope and the
// error executeTool raises for REST, never the redacted `tool_error`.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db/connection"
import { redis } from "~/lib/redis"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { registerApps } from "~/modules/apps/runtime"
import { appDayKey, utcDay } from "~/modules/org/caps"
import { seedOrgRow, seedUserRow } from "~/seed/factories/org/rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import testManifest from "../../../../test-support/apps/test/app.manifest.json"
import { AppDayCapTestAccess } from "./app-day-cap"

const ORG = randomUUID()
let userId = ""

beforeAll(async () => {
  await acquireTestLock()
  await sql.unsafe(`DROP SCHEMA IF EXISTS "app_test" CASCADE`)
  await seedOrgRow({ id: ORG, name: "Cap refusal org", slug: `cap-refusal-${ORG.slice(0, 8)}` })
  userId = await seedUserRow({
    orgId: ORG,
    email: `cap-refusal-${ORG.slice(0, 8)}@test.com`,
    passwordHash: "hash",
    name: "Cap Refusal",
    status: "active",
  })
  // An installed (untrusted) app: its handler is sandboxed, so its own errors are redacted.
  const manifest = {
    ...testManifest,
    trusted: false,
    _format: "manifest",
    _bundlePath: new URL("../../../../test-support/apps/test/handler-bundle.ts", import.meta.url)
      .pathname,
  }
  await registerApps([manifest as never], ORG)
  AppDayCapTestAccess.setReader(async () => ({
    appRunsPerDay: 1,
    appBridgeCallsPerDay: null,
    appCpuMsPerDay: null,
  }))
  await redis.set(appDayKey("appRunsPerDay", ORG, utcDay(Date.now())), "1", "EX", 600)
})

afterAll(async () => {
  AppDayCapTestAccess.setReader(null)
  await redis.del(appDayKey("appRunsPerDay", ORG, utcDay(Date.now())))
  resetAppRegistries()
  await sql.unsafe(`DROP SCHEMA IF EXISTS "app_test" CASCADE`)
  await sql`DELETE FROM kernel.apps WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE id = ${userId}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await releaseTestLock()
})

describe("a sandboxed tool at an app day cap", () => {
  it("answers 429 APP_RUNS_LIMIT_REACHED with {limit, used}, not tool_error", async () => {
    const { executeTool } = await import("~/modules/apps/execute-tool")
    const err = await executeTool({
      toolName: "test:listItems",
      orgId: ORG,
      actor: {
        actorType: "user",
        userId,
        orgId: ORG,
        scopes: ["test:items:read"],
        dimensionGrants: {},
      },
      params: {},
    }).then(
      () => null,
      (e: unknown) => e as Error & { status?: number; code?: string; details?: unknown },
    )
    expect(err).toBeInstanceOf(Error)
    expect(err?.status).toBe(429)
    expect(err?.code).toBe("APP_RUNS_LIMIT_REACHED")
    expect(err?.message).toContain("1 app runs")
    expect(err?.details).toEqual({ limit: 1, used: 1, retryable: false })
  })
})
