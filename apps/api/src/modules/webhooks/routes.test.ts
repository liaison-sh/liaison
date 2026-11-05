// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { app } from "~/app"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { ticketsAppManifest } from "~/apps/tickets/manifest-descriptor"
import { sql } from "~/db/connection"
import * as jobsModule from "~/infra/jobs/jobs"
import { createAppQueue } from "~/infra/jobs/jobs"
import { webhooksLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import {
  resetAppRegistries,
  setDeclaredEmits,
  webhookHandlers,
} from "~/modules/apps/app-registries"
import * as appsInitModule from "~/modules/apps/init"
import type { AppDescriptor } from "~/modules/apps/runtime"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"

const REPLAY_PREFIX = "webhook:replay:"
const TEST_ORG = "00000000-0000-0000-0000-000000000311"

/** Keys created during tests — cleaned up in afterAll */
const redisKeysToClean: string[] = []

function trackReplayKey(
  orgId: string,
  appName: string,
  endpointName: string,
  replayKey: string,
): void {
  const replayHash = createHash("sha256").update(replayKey).digest("hex")
  redisKeysToClean.push(`${REPLAY_PREFIX}${orgId}:${appName}:${endpointName}:${replayHash}`)
}

beforeAll(async () => {
  await initSandboxPool()
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${TEST_ORG}, 'Webhook Test Org', 'webhook-test-org')
    ON CONFLICT (id) DO NOTHING`
})

beforeEach(() => {
  resetAppRegistries()
  setDeclaredEmits(
    "*",
    "kernel",
    new Set(["connected_account:create", "connected_account:disconnect", "contact:merge"]),
  )
})

afterEach(async () => {
  // Don't DROP shared schemas — registerApps is idempotent and a DROP
  // would race with concurrent suites reading the same schema. Only
  // unregister this test's app row so the next test can re-register.
  await sql`DELETE FROM kernel.apps WHERE org_id = ${TEST_ORG} AND name IN ('mail', 'tickets')`
  resetAppRegistries()
})

afterAll(async () => {
  for (const key of redisKeysToClean) {
    await redis.del(key)
  }

  await shutdownSandboxPool()
  await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG}`
})

describe("webhook routes", () => {
  // ── Unknown endpoint ──────────────────────────────────────────────
  it("returns 404 for unknown webhook endpoint", async () => {
    const res = await app.request("/webhooks/fake-org/fake-app/fake-endpoint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    expect(res.status).toBe(404)
  })

  // ── Method not allowed ────────────────────────────────────────────
  it("returns 405 for GET request", async () => {
    const res = await app.request("/webhooks/fake-org/fake-app/fake-endpoint")
    expect(res.status).toBe(405)
    const body = (await res.json()) as any
    expect(body.error.code).toBe("METHOD_NOT_ALLOWED")
  })

  // ── Payload too large (content-length header) ─────────────────────
  // Body-limit middleware fires before route handler, so oversized payloads
  // get 413 regardless of whether the handler is registered.
  it("rejects oversized payload with 413", async () => {
    const largeBody = "x".repeat(10 * 1024 * 1024 + 1) // > 10MB global webhook limit
    const res = await app.request("/webhooks/fake-org/fake-app/fake-endpoint", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "content-length": String(largeBody.length) },
      body: largeBody,
    })
    expect(res.status).toBe(413)
  })

  // ── Replay protection (provider delivery IDs) ─────────────────────
  it("replay key prevents duplicate delivery within TTL", async () => {
    const replayHash = `test-replay-hash-${Date.now()}`
    const key = `${REPLAY_PREFIX}testapp:testendpoint:${replayHash}`
    redisKeysToClean.push(key)

    const set1 = await redis.set(key, "1", "EX", 300, "NX")
    expect(set1).toBe("OK")

    const set2 = await redis.set(key, "1", "EX", 300, "NX")
    expect(set2).toBeNull()
  })

  it("replay key expires after TTL", async () => {
    const replayHash = `test-replay-ttl-${Date.now()}`
    const key = `${REPLAY_PREFIX}testapp:testendpoint:${replayHash}`
    redisKeysToClean.push(key)

    await redis.set(key, "1", "EX", 300, "NX")
    const ttl = await redis.ttl(key)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(300)
  })

  // ── Module-level worker registration ──────────────────────────────
  it("retry-webhook worker is registered at module load", async () => {
    // Importing the webhooks module should not throw
    expect(() => require("~/modules/webhooks/routes")).not.toThrow()
  })

  // S3: an inbound webhook may be the first touch of an org this process never
  // registered (created after boot, or by another process): it is set up
  // before the route looks up the org's handler. Only an existing org is.
  // The setup itself (`setUpOrg`) is observed, not the ensure entry: the
  // entry (`awaitOrgApps`) is what skips a missing org and a non-org segment,
  // so stubbing it would stub out the very guard this test asserts.
  it("a webhook for an org this process never registered sets it up first", async () => {
    const ensured: string[] = []
    const spy = spyOn(appsInitModule, "setUpOrg").mockImplementation(async (orgId) => {
      ensured.push(orgId)
      return { failedApps: [] }
    })
    try {
      const post = (orgId: string) =>
        app.request(`/webhooks/${orgId}/no-such-app/no-such-endpoint`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      expect((await post(TEST_ORG)).status).toBe(404)
      expect(ensured).toEqual([TEST_ORG])
      // A missing org and a non-org path segment are never set up.
      expect((await post(randomUUID())).status).toBe(404)
      expect((await post("fake-org")).status).toBe(404)
      expect(ensured).toEqual([TEST_ORG])
    } finally {
      spy.mockRestore()
    }
  })

  it("accepts Gmail push when query token matches org app config", async () => {
    await registerApps(
      [mailAppManifest as unknown as AppDescriptor, ticketsAppManifest as unknown as AppDescriptor],
      TEST_ORG,
    )
    await sql`
      UPDATE kernel.apps
      SET config = ${JSON.stringify({ gmailPushSecret: "push-secret" })}::jsonb
      WHERE org_id = ${TEST_ORG} AND name = 'mail'
    `

    const [{ id: accountId }] = (await sql`
      INSERT INTO app_mail.accounts (
        org_id,
        connected_account_id,
        owner_type,
        owner_id,
        provider,
        email_address,
        sync_status
      )
      VALUES (
        ${TEST_ORG},
        '00000000-0000-0000-0000-000000000312',
        'user',
        '00000000-0000-0000-0000-000000000313',
        'gmail',
        'test@gmail.com',
        'idle'
      )
      ON CONFLICT (org_id, email_address) DO UPDATE SET
        connected_account_id = EXCLUDED.connected_account_id,
        sync_status = EXCLUDED.sync_status
      RETURNING id
    `) as Array<{ id: string }>

    const messageId = `pubsub-msg-${Date.now()}`
    trackReplayKey(TEST_ORG, "mail", "gmail-push", messageId)

    const res = await app.request(`/webhooks/${TEST_ORG}/mail/gmail-push?token=push-secret`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          data: Buffer.from(
            JSON.stringify({ emailAddress: "test@gmail.com", historyId: "123" }),
          ).toString("base64"),
          messageId,
        },
      }),
    })

    expect(res.status).toBe(200)

    // The webhook handler enqueues the sync job asynchronously; poll the queue
    // until it appears rather than racing a fixed sleep (which flakes under load).
    const queue = createAppQueue("mail")
    let queuedSyncJob: Awaited<ReturnType<typeof queue.getJobs>>[number] | undefined
    for (let attempt = 0; attempt < 50 && !queuedSyncJob; attempt++) {
      const jobs = await queue.getJobs(["waiting", "active", "completed", "delayed", "prioritized"])
      queuedSyncJob = jobs.find(
        (job) =>
          job.name === "gmail-incremental-sync" &&
          job.data?.accountId === accountId &&
          job.data?.historyId === "123",
      )
      if (!queuedSyncJob) await new Promise((resolve) => setTimeout(resolve, 100))
    }

    expect(queuedSyncJob?.data).toEqual(
      expect.objectContaining({
        orgId: TEST_ORG,
        accountId,
        historyId: "123",
      }),
    )
    // Generous timeout: the job-enqueue poll alone runs up to 5s, which collides
    // with the default 5s test timeout under any setup latency.
  }, 20000)

  it("rejects Gmail push when token is missing or wrong", async () => {
    await registerApps(
      [mailAppManifest as unknown as AppDescriptor, ticketsAppManifest as unknown as AppDescriptor],
      TEST_ORG,
    )
    await sql`
      UPDATE kernel.apps
      SET config = ${JSON.stringify({ gmailPushSecret: "push-secret" })}::jsonb
      WHERE org_id = ${TEST_ORG} AND name = 'mail'
    `

    const baseBody = (messageId: string) =>
      JSON.stringify({
        message: {
          data: Buffer.from(
            JSON.stringify({ emailAddress: "test@gmail.com", historyId: "789" }),
          ).toString("base64"),
          messageId,
        },
      })

    const missingToken = await app.request(`/webhooks/${TEST_ORG}/mail/gmail-push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: baseBody(`missing-token-${Date.now()}`),
    })
    // The mail/gmail-push verifier returns an explicit `{ ok:false, status:401 }`
    // for a missing/wrong token, which the route surfaces verbatim (the
    // `reject` branch). The 403 default only applies when the verifier result is
    // unparseable (e.g. a Shopify HMAC mismatch) — see the dedicated 403 test.
    expect(missingToken.status).toBe(401)

    const wrongToken = await app.request(
      `/webhooks/${TEST_ORG}/mail/gmail-push?token=wrong-secret`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: baseBody(`wrong-token-${Date.now()}`),
      },
    )
    expect(wrongToken.status).toBe(401)
  })

  // ── Subscription handshake: Meta-style GET ?hub.mode=subscribe ──
  it("answers the hub.challenge handshake only against the configured verify token", async () => {
    await registerApps(
      [mailAppManifest as unknown as AppDescriptor, ticketsAppManifest as unknown as AppDescriptor],
      TEST_ORG,
    )
    await sql`
      UPDATE kernel.apps
      SET config = ${JSON.stringify({ gmailPushSecret: "push-secret", webhookVerifyToken: "verify-me-123" })}::jsonb
      WHERE org_id = ${TEST_ORG} AND name = 'mail'
    `
    const url = (token: string, challenge = "1158201444") =>
      `/webhooks/${TEST_ORG}/mail/gmail-push?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=${challenge}`

    const ok = await app.request(url("verify-me-123"))
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe("1158201444")
    expect(ok.headers.get("content-type")).toContain("text/plain")

    expect((await app.request(url("wrong-token"))).status).toBe(403)
    // A challenge that is not a plain token is never reflected.
    expect((await app.request(url("verify-me-123", "%3Cscript%3E"))).status).toBe(400)
    // An unknown endpoint is a 404, and a plain GET stays 405.
    expect(
      (
        await app.request(
          `/webhooks/${TEST_ORG}/mail/nope?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1`,
        )
      ).status,
    ).toBe(404)
    expect((await app.request(`/webhooks/${TEST_ORG}/mail/gmail-push`)).status).toBe(405)

    // With no verify token configured the handshake is refused, not open.
    await sql`
      UPDATE kernel.apps SET config = ${JSON.stringify({ gmailPushSecret: "push-secret" })}::jsonb
      WHERE org_id = ${TEST_ORG} AND name = 'mail'
    `
    expect((await app.request(url("anything"))).status).toBe(403)
  })

  it("answers the handshake against a verify token the app stored as an app-held secret", async () => {
    const APP = "verify-secret-app"
    const ENDPOINT = "meta"
    const connections = { facebook: { appSecretConfigKeys: ["webhookVerifyToken"] } }
    await sql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${TEST_ORG}, 'Webhook Test Org', 'webhook-test-org')
      ON CONFLICT (id) DO NOTHING`
    await sql`
      INSERT INTO kernel.apps (id, org_id, name, version, status)
      VALUES (gen_random_uuid(), ${TEST_ORG}, ${APP}, '1.0.0', 'active')
      ON CONFLICT (org_id, name) DO NOTHING`
    webhookHandlers.set([TEST_ORG, APP, ENDPOINT], {
      appName: APP,
      orgId: TEST_ORG,
      verify: async () => ({ valid: true as const }),
      handler: async () => ({ status: 200 }),
      _manifest: { connections },
    } as never)
    try {
      const { storeAppHeldSecret } = await import("~/modules/apps/connections/service")
      await storeAppHeldSecret({
        orgId: TEST_ORG,
        appName: APP,
        key: "webhookVerifyToken",
        value: "held-token-42",
        manifestConnections: connections,
      })
      const [row] =
        await sql`SELECT config FROM kernel.apps WHERE org_id = ${TEST_ORG} AND name = ${APP}`
      const stored = (typeof row?.config === "string" ? JSON.parse(row.config) : row?.config) as {
        webhookVerifyToken?: string
      }
      // Encrypted at rest: the handshake must decrypt before comparing.
      expect(stored.webhookVerifyToken).not.toBe("held-token-42")
      const url = (token: string) =>
        `/webhooks/${TEST_ORG}/${APP}/${ENDPOINT}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=777`
      const ok = await app.request(url("held-token-42"))
      expect(ok.status).toBe(200)
      expect(await ok.text()).toBe("777")
      expect((await app.request(url(String(stored.webhookVerifyToken)))).status).toBe(403)
      expect((await app.request(url("wrong"))).status).toBe(403)
    } finally {
      webhookHandlers.delete([TEST_ORG, APP, ENDPOINT])
      await sql`DELETE FROM kernel.apps WHERE org_id = ${TEST_ORG} AND name = ${APP}`
    }
  })

  // ── Handler result → HTTP status mapping (deep-review cluster 2 item 3) ──
  //
  // Manifest/host webhook handlers report transient downstream failure by
  // RETURNING `{ status: 5xx }` (they do not throw). The route must (a)
  // propagate a retriable 5xx so the provider re-delivers, and (b) release the
  // redis replay claim so the retry re-reaches the handler instead of being
  // short-circuited as a duplicate. On success it must keep the claim.
  describe("handler result status mapping", () => {
    const APP = "result-map-app"
    const ENDPOINT = "topic"

    async function seedAppRow(): Promise<void> {
      // Re-assert the parent org at point-of-use: a concurrent integration suite
      // (full-integration.test.ts) runs an unscoped TRUNCATE ... organizations
      // CASCADE in the shared bun process, which can wipe the beforeAll-seeded
      // TEST_ORG between this describe's tests. Without this, the apps INSERT
      // below hits apps_org_fk and the route's RLS tx throws → 500 instead of
      // the asserted 503. Idempotent; mirrors the beforeAll org insert.
      await sql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (${TEST_ORG}, 'Webhook Test Org', 'webhook-test-org')
        ON CONFLICT (id) DO NOTHING`
      await sql`
        INSERT INTO kernel.apps (id, org_id, name, version, status)
        VALUES (gen_random_uuid(), ${TEST_ORG}, ${APP}, '1.0.0', 'active')
        ON CONFLICT (org_id, name) DO NOTHING`
    }

    afterEach(async () => {
      mock.restore()
      webhookHandlers.delete([TEST_ORG, APP, ENDPOINT])
      await sql`DELETE FROM kernel.apps WHERE org_id = ${TEST_ORG} AND name = ${APP}`
    })

    function registerHostHandler(handler: (payload: unknown, ctx: any) => Promise<unknown>): void {
      webhookHandlers.set([TEST_ORG, APP, ENDPOINT], {
        appName: APP,
        orgId: TEST_ORG,
        // Function-form verifier: accept and supply the replay identity.
        verify: async () => ({ valid: true as const, replayKey: "fixed-replay-key" }),
        handler,
      })
    }

    function replayKeyFor(replayKey: string): string {
      const replayHash = createHash("sha256").update(replayKey).digest("hex")
      return `${REPLAY_PREFIX}${TEST_ORG}:${APP}:${ENDPOINT}:${replayHash}`
    }

    it("propagates a 5xx and releases the replay claim when the handler returns a non-2xx", async () => {
      await seedAppRow()
      const key = replayKeyFor("fixed-replay-key")
      await redis.del(key)
      redisKeysToClean.push(key)
      registerHostHandler(async () => ({ status: 503, body: "downstream emit failed" }))

      const res = await app.request(`/webhooks/${TEST_ORG}/${APP}/${ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      })

      // Retriable status surfaced to the provider.
      expect(res.status).toBe(503)
      // Replay claim released → a genuine retry re-reaches the handler.
      expect(await redis.exists(key)).toBe(0)
    })

    it("returns 200 and KEEPS the replay claim when the handler succeeds", async () => {
      await seedAppRow()
      const key = replayKeyFor("fixed-replay-key")
      await redis.del(key)
      redisKeysToClean.push(key)
      registerHostHandler(async () => ({ status: 200 }))

      const res = await app.request(`/webhooks/${TEST_ORG}/${APP}/${ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      })

      expect(res.status).toBe(200)
      // Claim retained → a duplicate redelivery is deduped, not reprocessed.
      expect(await redis.exists(key)).toBe(1)
    })

    it("returns 401 when signature verification is unparseable/invalid", async () => {
      await seedAppRow()
      webhookHandlers.set([TEST_ORG, APP, ENDPOINT], {
        appName: APP,
        orgId: TEST_ORG,
        // An unparseable verifier result (no {valid}/{ok}/{drop}) makes
        // parseWebhookVerificationResult return null → the route's invalid-
        // signature path. A missing/forged signature is failed authentication;
        // the canonical status for that is 401 Unauthorized.
        verify: async () => ({ totally: "bogus" }) as unknown as never,
        handler: async () => ({ status: 200 }),
      })

      const res = await app.request(`/webhooks/${TEST_ORG}/${APP}/${ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      })

      expect(res.status).toBe(401)
    })

    it("answers 503 and logs the cause when the verifier bundle throws at load", async () => {
      await seedAppRow()
      const dir = mkdtempSync(join(tmpdir(), "bundle-load-"))
      const bundlePath = join(dir, "bundle.js")
      writeFileSync(
        bundlePath,
        'throw new Error("Uint8Array is not defined");\nglobalThis.verify = 1\n',
      )
      webhookHandlers.set([TEST_ORG, APP, ENDPOINT], {
        appName: APP,
        orgId: TEST_ORG,
        verify: { bundlePath, exportName: "verify", trusted: true },
        handler: async () => ({ status: 200 }),
      })
      const errSpy = spyOn(webhooksLogger, "error")
      try {
        const res = await app.request(`/webhooks/${TEST_ORG}/${APP}/${ENDPOINT}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hello: "world" }),
        })
        expect(res.status).toBe(503)
        expect(JSON.stringify(await res.json())).not.toContain("Uint8Array")
        const call = errSpy.mock.calls.find((c) => (c[0] as { appName?: string }).appName === APP)
        expect(call).toBeDefined()
        const fields = call?.[0] as { errorMessage: string; errorStack: string; appVersion: string }
        expect(fields.errorMessage).toContain("Uint8Array is not defined")
        expect(fields.errorStack).toBeTruthy()
        expect(fields.appVersion).toBe("1.0.0")
      } finally {
        errSpy.mockRestore()
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("treats a void-returning handler as success (legacy contract)", async () => {
      await seedAppRow()
      const key = replayKeyFor("fixed-replay-key")
      await redis.del(key)
      redisKeysToClean.push(key)
      registerHostHandler(async () => undefined)

      const res = await app.request(`/webhooks/${TEST_ORG}/${APP}/${ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      })

      expect(res.status).toBe(200)
      expect(await redis.exists(key)).toBe(1)
    })

    function spyRetryEnqueue() {
      return spyOn(jobsModule, "enqueueAppJob").mockResolvedValue("stub")
    }

    function retryCalls(spy: ReturnType<typeof spyRetryEnqueue>): number {
      return spy.mock.calls.filter((call) => call[0] === "kernel" && call[1] === "retry-webhook")
        .length
    }

    it("answers a handler 4xx as-is with its message and schedules NO retry", async () => {
      await seedAppRow()
      const key = replayKeyFor("fixed-replay-key")
      await redis.del(key)
      redisKeysToClean.push(key)
      registerHostHandler(async () => ({ status: 400, body: "invalid envelope: dedupKey" }))
      const enqueue = spyRetryEnqueue()

      const res = await app.request(`/webhooks/${TEST_ORG}/${APP}/${ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      })

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: { message: "invalid envelope: dedupKey" } })
      expect(retryCalls(enqueue)).toBe(0)
      // Nothing happened: a corrected or repeated delivery re-reaches the handler.
      expect(await redis.exists(key)).toBe(0)
    })

    it("still schedules a retry for a handler 5xx", async () => {
      await seedAppRow()
      const key = replayKeyFor("fixed-replay-key")
      await redis.del(key)
      redisKeysToClean.push(key)
      registerHostHandler(async () => ({ status: 503, body: "downstream emit failed" }))
      const enqueue = spyRetryEnqueue()

      const res = await app.request(`/webhooks/${TEST_ORG}/${APP}/${ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      })

      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: { message: "Webhook processing failed" } })
      expect(retryCalls(enqueue)).toBe(1)
    })

    it("passes the handler's JSON body through on 2xx", async () => {
      await seedAppRow()
      const key = replayKeyFor("fixed-replay-key")
      await redis.del(key)
      redisKeysToClean.push(key)
      registerHostHandler(async () => ({
        status: 200,
        body: JSON.stringify({ resolved: true, id: "inc-1" }),
      }))

      const res = await app.request(`/webhooks/${TEST_ORG}/${APP}/${ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ data: { resolved: true, id: "inc-1" } })
    })

    it("keeps {received:true} when the 2xx body is not a JSON object", async () => {
      await seedAppRow()
      const key = replayKeyFor("fixed-replay-key")
      await redis.del(key)
      redisKeysToClean.push(key)
      registerHostHandler(async () => ({ status: 200, body: "ok" }))

      const res = await app.request(`/webhooks/${TEST_ORG}/${APP}/${ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ data: { received: true } })
    })
  })
})
