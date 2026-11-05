// SPDX-License-Identifier: FSL-1.1-ALv2
// Task 6 — watch channels, webhook post-verify binding, renewal, polling fallback.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHmac } from "node:crypto"
import path from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import {
  findCalendarByChannelId,
  findCalendarsForPollFallback,
  findCalendarsForWatchRenewal,
  handleGooglePushNotification,
  markCalendarPolled,
  onAccountConnected,
  recordWatchChannel,
  runCalendarImport,
  stopWatchChannelOnly,
} from "~/apps/calendar/sync"
import { withSystemDb } from "~/db/privileged"
import { loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { executeInSandbox } from "~/modules/apps/sandbox/executor"
import { getSandboxPool, initSandboxPool } from "~/modules/apps/sandbox/pool"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"

let orgId: string
let userId: string

async function registerCalendarSchema() {
  const { calendarAppManifest } = await import("~/apps/calendar/manifest-descriptor")
  const { resetAppRegistries } = await import("~/modules/apps/app-registries")
  const { registerApps } = await import("~/modules/apps/runtime")
  resetAppRegistries()
  await withSystemDb("calendar-webhook-fixture-reg", async (tx) => {
    await tx.execute(
      drizzleSql`DELETE FROM kernel.apps WHERE org_id = ${orgId}::uuid AND name = 'calendar'`,
    )
  })
  const { setDeclaredEmits } = await import("~/modules/apps/app-registries")
  setDeclaredEmits(
    "*",
    "kernel",
    new Set(["connected_account:create", "connected_account:disconnect"]),
  )
  await registerApps([calendarAppManifest as any], orgId)
}

beforeAll(async () => {
  await acquireAppSchemaJsLock("app_calendar")
  const slug = `cal-webhook-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("calendar-webhook-fixture", async (tx) => {
    const o = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug) VALUES (gen_random_uuid(), 'Calendar Webhook Org', ${slug})
      RETURNING id
    `)) as any
    orgId = (o.rows ?? o)[0].id
    const u = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`owner-${slug}@x.test`}, 'Owner', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    userId = (u.rows ?? u)[0].id
  })
  await registerCalendarSchema()
}, 120_000)

afterAll(async () => {
  await releaseAppSchemaJsLock("app_calendar")
})

async function seedCalendar(tx: any) {
  const event = {
    orgId,
    actorId: userId,
    data: {
      id: crypto.randomUUID(),
      appName: "calendar",
      ownerType: "user" as const,
      ownerId: userId,
      identifier: `webhook-${crypto.randomUUID()}@gmail.com`,
      connectionName: "google-calendar",
    },
  }
  const { accountId } = await onAccountConnected(tx, orgId, event, async () => {})
  const { calendarIds } = await runCalendarImport(
    tx,
    orgId,
    accountId,
    async () => [{ id: "gcal-wh" }],
    async () => {},
  )
  return { accountId, calendarId: calendarIds[0]! }
}

describe("calendar watch channels + webhook", () => {
  it("recordWatchChannel persists channelId/resourceId/expiration from the events.watch response", async () => {
    await withSystemDb("calendar-record-channel", async (tx) => {
      const { calendarId } = await seedCalendar(tx as any)
      const expiration = new Date(Date.now() + 3_600_000).toISOString()
      await recordWatchChannel(tx as any, orgId, calendarId, {
        channelId: "chan-abc",
        resourceId: "res-abc",
        expiration,
      })
      const found = await findCalendarByChannelId(tx as any, orgId, "chan-abc", "res-abc")
      expect(found?.id).toBe(calendarId)
    })
  })

  it("unknown channelId/resourceId -> no calendar found (post-verify handler drops with 200, no enumeration signal)", async () => {
    await withSystemDb("calendar-unknown-channel", async (tx) => {
      const found = await findCalendarByChannelId(
        tx as any,
        orgId,
        "does-not-exist",
        "also-not-real",
      )
      expect(found).toBeUndefined()
    })
  })

  it("a known channel notification enqueues exactly one incremental-sync job per calendar (debounced across rapid repeats)", async () => {
    await withSystemDb("calendar-debounce", async (tx) => {
      const { calendarId } = await seedCalendar(tx as any)
      await recordWatchChannel(tx as any, orgId, calendarId, {
        channelId: "chan-debounce",
        resourceId: "res-debounce",
        expiration: new Date(Date.now() + 3_600_000).toISOString(),
      })
      const jobs: Array<{
        jobName: string
        payload: Record<string, unknown>
        opts?: Record<string, unknown>
      }> = []
      const enqueueJob = async (
        jobName: string,
        payload: Record<string, unknown>,
        opts?: Record<string, unknown>,
      ) => {
        jobs.push({ jobName, payload, opts })
      }
      // N rapid notifications for the same channel.
      await handleGooglePushNotification(
        tx as any,
        orgId,
        "chan-debounce",
        "res-debounce",
        enqueueJob,
      )
      await handleGooglePushNotification(
        tx as any,
        orgId,
        "chan-debounce",
        "res-debounce",
        enqueueJob,
      )
      await handleGooglePushNotification(
        tx as any,
        orgId,
        "chan-debounce",
        "res-debounce",
        enqueueJob,
      )
      const incrementalJobs = jobs.filter((j) => j.jobName === "calendar-incremental-sync")
      expect(incrementalJobs.length).toBe(3)
      // Debounce is via a stable jobId so BullMQ collapses duplicates — assert the SAME jobId
      // is used every time (the actual collapse happens at the queue layer, not here).
      const jobIds = incrementalJobs.map((j) => j.opts?.jobId)
      expect(new Set(jobIds).size).toBe(1)
      expect(jobIds[0]).toBe(`calendar-incremental:${calendarId}`)
    })
  })

  it("an unknown channel notification enqueues nothing", async () => {
    await withSystemDb("calendar-unknown-enqueue", async (tx) => {
      const jobs: any[] = []
      await handleGooglePushNotification(
        tx as any,
        orgId,
        "chan-unknown-x",
        "res-unknown-x",
        async (jobName, payload, opts) => {
          jobs.push({ jobName, payload, opts })
        },
      )
      expect(jobs.length).toBe(0)
    })
  })

  it("renewal: only calendars with watchExpiration < now + 12h are selected; a calendar exactly at the 12h boundary is NOT selected (exclusive <)", async () => {
    await withSystemDb("calendar-renewal-boundary", async (tx) => {
      const { calendarId: nearId } = await seedCalendar(tx as any)
      const { calendarId: boundaryId } = await seedCalendar(tx as any)
      const { calendarId: farId } = await seedCalendar(tx as any)

      const nearExpiry = new Date(Date.now() + 6 * 3_600_000).toISOString() // within window
      const boundaryExpiry = new Date(Date.now() + 12 * 3_600_000).toISOString() // exactly at boundary
      const farExpiry = new Date(Date.now() + 48 * 3_600_000).toISOString() // outside window

      await recordWatchChannel(tx as any, orgId, nearId, {
        channelId: "c-near",
        resourceId: "r-near",
        expiration: nearExpiry,
      })
      await recordWatchChannel(tx as any, orgId, boundaryId, {
        channelId: "c-boundary",
        resourceId: "r-boundary",
        expiration: boundaryExpiry,
      })
      await recordWatchChannel(tx as any, orgId, farId, {
        channelId: "c-far",
        resourceId: "r-far",
        expiration: farExpiry,
      })

      const needingRenewal = await findCalendarsForWatchRenewal(tx as any, orgId, 12)
      const ids = needingRenewal.map((c) => c.id)
      expect(ids).toContain(nearId)
      expect(ids).not.toContain(boundaryId)
      expect(ids).not.toContain(farId)
    })
  })

  it("stopWatchChannelOnly clears channel fields without touching syncToken or deleting events", async () => {
    await withSystemDb("calendar-stop-channel-only", async (tx) => {
      const { calendarId } = await seedCalendar(tx as any)
      await recordWatchChannel(tx as any, orgId, calendarId, {
        channelId: "chan-old",
        resourceId: "res-old",
        expiration: new Date(Date.now() + 1000).toISOString(),
      })
      await tx.execute(
        drizzleSql`UPDATE app_calendar.calendars SET sync_token = 'keep-me' WHERE id = ${calendarId}::uuid`,
      )
      await stopWatchChannelOnly(tx as any, orgId, calendarId, "chan-old")
      const [row] = (await tx.execute(drizzleSql`
        SELECT watch_channel_id, sync_token FROM app_calendar.calendars WHERE id = ${calendarId}::uuid
      `)) as any
      const r = (row.rows ?? row)[0] ?? (Array.isArray(row) ? row[0] : row)
      expect(r.watch_channel_id).toBe(null)
      expect(r.sync_token).toBe("keep-me")
    })
  })

  it("poll fallback targets only calendars whose lastPolledAt is older than the threshold", async () => {
    await withSystemDb("calendar-poll-fallback", async (tx) => {
      const { calendarId: staleId } = await seedCalendar(tx as any)
      const { calendarId: freshId } = await seedCalendar(tx as any)
      await tx.execute(drizzleSql`
        UPDATE app_calendar.calendars SET last_polled_at = now() - interval '1 hour' WHERE id = ${staleId}::uuid
      `)
      await tx.execute(drizzleSql`
        UPDATE app_calendar.calendars SET last_polled_at = now() - interval '5 minutes' WHERE id = ${freshId}::uuid
      `)
      const stale = await findCalendarsForPollFallback(tx as any, orgId, 30)
      const ids = stale.map((c) => c.id)
      expect(ids).toContain(staleId)
      expect(ids).not.toContain(freshId)

      await markCalendarPolled(tx as any, orgId, staleId)
      const [row] = (await tx.execute(drizzleSql`
        SELECT last_polled_at FROM app_calendar.calendars WHERE id = ${staleId}::uuid
      `)) as any
      const r = (row.rows ?? row)[0] ?? (Array.isArray(row) ? row[0] : row)
      expect(new Date(r.last_polled_at).getTime()).toBeGreaterThan(Date.now() - 60_000)
    })
  })
})

// --- The sandboxed webhook AUTH boundary (verifyGooglePush + onGooglePush). This is the only
// unauthenticated HTTP route into the app; the verify seam does the X-Goog-Channel-Token
// constant-time compare against the org secret. Driven through the real QuickJS bundle. ---
describe("verifyGooglePush (sandboxed webhook auth boundary)", () => {
  let bundleSource: string
  const SECRET = "cal-webhook-secret-123"
  // The channel token is per channel: HMAC(org push secret, channel id).
  const tokenFor = (channelId: string, secret = SECRET) =>
    createHmac("sha256", secret).update(channelId, "utf8").digest("base64")

  beforeAll(async () => {
    await initSandboxPool()
    bundleSource = await loadBundle(path.resolve(import.meta.dir, "handlers.ts"))
  })

  function verifyBridge(secret: string | null): Record<string, any> {
    return {
      getUserId: () => "system:calendar:verify",
      getOrgId: () => "org-1",
      config_get: async (key: string) => (key === "calendarPushSecret" ? secret : null),
      crypto_timingSafeEqual: async (a: string, b: string) => a === b,
      crypto_hmacSha256Base64: async (key: string, body: string) =>
        createHmac("sha256", key).update(body, "utf8").digest("base64"),
      log_info: () => {},
      log_warn: () => {},
      log_error: () => {},
    }
  }

  async function runVerify(
    headers: Record<string, string>,
    secret: string | null = SECRET,
  ): Promise<any> {
    return executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "verifyGooglePush",
      params: { headers, method: "POST", body: "" },
      bridge: verifyBridge(secret),
    })
  }

  it("correct token + channel id -> valid:true with replayKey channelId:messageNumber", async () => {
    const result = await runVerify({
      "x-goog-channel-token": tokenFor("chan-77"),
      "x-goog-channel-id": "chan-77",
      "x-goog-message-number": "42",
    })
    expect(result.valid).toBe(true)
    expect(result.replayKey).toBe("chan-77:42")
  })

  it("the raw org secret, and another channel's token, no longer authenticate", async () => {
    for (const token of [SECRET, tokenFor("chan-OTHER")]) {
      const result = await runVerify({
        "x-goog-channel-token": token,
        "x-goog-channel-id": "chan-77",
        "x-goog-message-number": "42",
      })
      expect(result.valid).toBe(false)
      expect(result.status).toBe(403)
    }
  })

  it("wrong token -> valid:false, status 403 (verify rejects, nothing downstream runs)", async () => {
    const result = await runVerify({
      "x-goog-channel-token": "not-the-secret",
      "x-goog-channel-id": "chan-77",
      "x-goog-message-number": "42",
    })
    expect(result.valid).toBe(false)
    expect(result.status).toBe(403)
  })

  it("missing channel id (token correct) -> valid:false, status 401", async () => {
    const result = await runVerify({
      "x-goog-channel-token": tokenFor(""),
      "x-goog-message-number": "42",
    })
    expect(result.valid).toBe(false)
    expect(result.status).toBe(401)
  })

  it("secret not configured -> valid:false, status 500", async () => {
    const result = await runVerify(
      { "x-goog-channel-token": tokenFor("chan-77"), "x-goog-channel-id": "chan-77" },
      null,
    )
    expect(result.valid).toBe(false)
    expect(result.status).toBe(500)
  })

  it("the X-Goog-Resource-State: sync handshake header does not change verify's result (valid when token ok)", async () => {
    const result = await runVerify({
      "x-goog-channel-token": tokenFor("chan-sync"),
      "x-goog-channel-id": "chan-sync",
      "x-goog-message-number": "1",
      "x-goog-resource-state": "sync",
    })
    expect(result.valid).toBe(true)
    expect(result.replayKey).toBe("chan-sync:1")
  })

  it("onGooglePush delegates to calendar_handleWebhook with the raw headers", async () => {
    const handled: string[] = []
    await executeInSandbox({
      pool: getSandboxPool(),
      bundleSource,
      exportName: "onGooglePush",
      params: {},
      extraArgs: [{ "x-goog-channel-id": "chan-9", "x-goog-resource-id": "res-9" }],
      bridge: {
        getUserId: () => "system:calendar:webhook",
        getOrgId: () => "org-1",
        calendar_handleWebhook: async (headersJson: string) => {
          handled.push(headersJson)
        },
        log_info: () => {},
        log_warn: () => {},
        log_error: () => {},
      },
    })
    expect(handled.length).toBe(1)
    const parsed = JSON.parse(handled[0]!)
    expect(parsed["x-goog-channel-id"]).toBe("chan-9")
    expect(parsed["x-goog-resource-id"]).toBe("res-9")
  })
})
