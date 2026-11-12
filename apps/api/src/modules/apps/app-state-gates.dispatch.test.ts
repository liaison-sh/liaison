// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S19 / A6 / A24-3: background work of an app turned Off for the workspace
// stops at its dispatch chokepoint, from the persisted state, and resumes on
// re-enable with no restart:
//  - a queued or due job is skipped at processJob (the scheduler stays) and a
//    new enqueue is refused with app_disabled,
//  - an event handler does not run for the Off org's events (and still runs
//    for another org's, since subscriptions are channel-global),
//  - a PDF render of the app's template is refused, an OAuth callback refused,
//  - fail-closed: an unreadable state throws (BullMQ retries) instead of running.
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { sql } from "~/db"
import * as privileged from "~/db/privileged"
import {
  enqueueAppJob,
  JobsTestAccess,
  jobsSkippedAppDisabledCount,
  registerJobWorker,
} from "~/infra/jobs/jobs"
import { redis } from "~/lib/redis"
import { OAuthAppDisabledError, receiveOAuthCallback } from "~/modules/apps/connections/service"
import { setOrgAppStatus } from "~/modules/apps/org-app-service"
import { AppDisabledError, forgetOrgApps } from "~/modules/apps/org-apps"
import { gateEventOnAppState } from "~/modules/apps/runtime"
import { appSettingsPath } from "~/modules/apps/settings-paths"
import { cleanupSeededOrg, seedOrgWithTicketsApp } from "~/modules/mcp/test-helpers"
import { PdfRenderError } from "~/modules/pdf/pool"
import { renderPdf } from "~/modules/pdf/render"

const orgs: string[] = []
afterEach(async () => {
  for (const o of orgs.splice(0)) {
    forgetOrgApps(o)
    await cleanupSeededOrg(o)
  }
})

describe("Off app: dispatch chokepoints", () => {
  it("a job of an Off app is skipped at its start (scheduler kept); enqueue refused; re-enable runs it", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const handler = mock(async (_payload: unknown) => {})
    registerJobWorker("test", "p3GateTick", handler, { txMode: "session" })

    await setOrgAppStatus(seed.orgId, "test", "disabled")
    forgetOrgApps(seed.orgId) // a cold worker process
    const skippedBefore = jobsSkippedAppDisabledCount()
    await JobsTestAccess.processJob("test", "p3GateTick", { orgId: seed.orgId })
    expect(handler).not.toHaveBeenCalled()
    expect(jobsSkippedAppDisabledCount()).toBe(skippedBefore + 1)
    await expect(enqueueAppJob("test", "p3GateTick", { orgId: seed.orgId })).rejects.toBeInstanceOf(
      AppDisabledError,
    )

    await setOrgAppStatus(seed.orgId, "test", "active")
    await JobsTestAccess.processJob("test", "p3GateTick", { orgId: seed.orgId })
    expect(handler).toHaveBeenCalledTimes(1)
  }, 60_000)

  it("fail-closed: an unreadable state throws at processJob (retried), the handler does not run", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const handler = mock(async (_payload: unknown) => {})
    registerJobWorker("test", "p3GateTickFail", handler, { txMode: "session" })
    forgetOrgApps(seed.orgId)
    const spy = spyOn(privileged, "withPrivilegedDb").mockImplementationOnce(async () => {
      throw new Error("database unreachable")
    })
    try {
      await expect(
        JobsTestAccess.processJob("test", "p3GateTickFail", { orgId: seed.orgId }),
      ).rejects.toThrow()
    } finally {
      spy.mockRestore()
    }
    expect(handler).not.toHaveBeenCalled()
  }, 60_000)

  it("an event handler does not run for the Off org's events, and runs again once On", async () => {
    const seed = await seedOrgWithTicketsApp()
    const other = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId, other.orgId)
    const inner = mock(async (_event: unknown) => {})
    const handler = gateEventOnAppState("test", seed.orgId, inner)

    await setOrgAppStatus(seed.orgId, "test", "disabled")
    await handler({ orgId: seed.orgId, app: "test", entity: "items", action: "created" })
    expect(inner).not.toHaveBeenCalled()
    // The other org, where the app is On, is served by its own registration.
    const otherInner = mock(async (_event: unknown) => {})
    const otherHandler = gateEventOnAppState("test", other.orgId, otherInner)
    await otherHandler({ orgId: other.orgId, app: "test", entity: "items", action: "created" })
    expect(otherInner).toHaveBeenCalledTimes(1)

    await setOrgAppStatus(seed.orgId, "test", "active")
    await handler({ orgId: seed.orgId, app: "test", entity: "items", action: "created" })
    expect(inner).toHaveBeenCalledTimes(1)
  }, 60_000)

  it("an org's registration never runs for another org's events, so an event runs its handler once", async () => {
    const seed = await seedOrgWithTicketsApp()
    const other = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId, other.orgId)
    const seen: string[] = []
    const handlers = [seed.orgId, other.orgId].map((orgId) =>
      gateEventOnAppState("test", orgId, async () => {
        seen.push(orgId)
      }),
    )
    const event = { orgId: other.orgId, app: "test", entity: "items", action: "created" }
    for (const handler of handlers) await handler(event)
    expect(seen).toEqual([other.orgId])
  }, 60_000)

  it("a PDF render of an Off app's template is refused with app_disabled", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    await setOrgAppStatus(seed.orgId, "test", "disabled")
    const err = await renderPdf(null, {
      orgId: seed.orgId,
      callingAppId: "test",
      template_kind: "invoice",
      data: {},
    }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(PdfRenderError)
    expect((err as PdfRenderError).code).toBe("app_disabled")
  }, 60_000)

  it("an OAuth callback for an Off app connects nothing and says why", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    await setOrgAppStatus(seed.orgId, "test", "disabled")
    const state = `p3-off-${crypto.randomUUID()}`
    await redis.set(
      `oauth:state:${state}`,
      JSON.stringify({
        orgId: seed.orgId,
        userId: seed.ownerId,
        appName: "test",
        connectionName: "conn",
        codeVerifier: "v",
        tokenUrl: "https://example.invalid/token",
      }),
      "EX",
      60,
    )
    const refusal = await receiveOAuthCallback("provider-code", state).catch((e: unknown) => e)
    expect(refusal).toBeInstanceOf(OAuthAppDisabledError)
    // The browser goes back to the app's own settings location, never a former path.
    expect((refusal as OAuthAppDisabledError).settingsPath).toBe(
      appSettingsPath(seed.orgId, "test"),
    )
  }, 60_000)

  it("the persisted row is what decides: a status written elsewhere is seen after a cold load", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const handler = mock(async (_payload: unknown) => {})
    registerJobWorker("test", "p3GateTickRow", handler, { txMode: "session" })
    await sql`UPDATE kernel.apps SET status = 'removed' WHERE org_id = ${seed.orgId} AND name = 'test'`
    forgetOrgApps(seed.orgId)
    await JobsTestAccess.processJob("test", "p3GateTickRow", { orgId: seed.orgId })
    expect(handler).not.toHaveBeenCalled()
  }, 60_000)
})
