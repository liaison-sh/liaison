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
import { pinnedJobsGate, withPinnedJobSlot } from "~/infra/jobs/pinned-jobs-gate"
import { env } from "~/lib/env"
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
import * as appDayCapModule from "~/modules/apps/usage/app-day-cap"
import * as googleOidcModule from "~/modules/webhooks/google-oidc"
import * as inboxModule from "~/modules/webhooks/inbox"

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

  // S30: one push subscription per cell; each org's Mail or Tickets verifier
  // checks the OIDC token against the instance's audience and push service
  // account when the org set none of its own.
  it("the instance Gmail push audience and service account reach the Mail and Tickets verifiers", async () => {
    await registerApps(
      [mailAppManifest as unknown as AppDescriptor, ticketsAppManifest as unknown as AppDescriptor],
      TEST_ORG,
    )
    const audience = "https://cell-a.example.test/webhooks/_cell/gmail-push"
    const serviceAccount = "gmail-push-cell-a@example.iam.gserviceaccount.com"
    const saved = {
      audience: env.GMAIL_PUSH_AUDIENCE,
      serviceAccount: env.GMAIL_PUSH_SERVICE_ACCOUNT,
    }
    env.GMAIL_PUSH_AUDIENCE = audience
    env.GMAIL_PUSH_SERVICE_ACCOUNT = serviceAccount
    const seen: Array<{ audience: string; serviceAccount: string }> = []
    const spy = spyOn(googleOidcModule, "verifyGoogleOidcJwt").mockImplementation(
      async (_token, opts) => {
        seen.push({ audience: opts.expectedAudience, serviceAccount: opts.expectedServiceAccount })
        return { valid: false, reason: "test_stop" }
      },
    )
    try {
      for (const appName of ["mail", "tickets"]) {
        const res = await app.request(`/webhooks/${TEST_ORG}/${appName}/gmail-push`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer a-token" },
          body: JSON.stringify({
            message: {
              data: Buffer.from(JSON.stringify({ emailAddress: "x@example.test" })).toString(
                "base64",
              ),
              messageId: `instance-default-${appName}-${Date.now()}`,
            },
          }),
        })
        expect(res.status).toBe(401)
      }
      expect(seen).toEqual([
        { audience, serviceAccount },
        { audience, serviceAccount },
      ])
    } finally {
      spy.mockRestore()
      env.GMAIL_PUSH_AUDIENCE = saved.audience
      env.GMAIL_PUSH_SERVICE_ACCOUNT = saved.serviceAccount
    }
  })

  it("/webhooks/_cell/* is not served by a self-hosted server", async () => {
    for (const path of ["/webhooks/_cell/gmail-push", "/webhooks/_cell/meta"]) {
      const res = await app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
      expect(res.status).toBe(404)
    }
    const challenge = await app.request(
      "/webhooks/_cell/meta?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1",
    )
    expect(challenge.status).toBe(404)
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
      await sql`DELETE FROM kernel.webhook_inbox WHERE org_id = ${TEST_ORG} AND app_name = ${APP}`
    })

    type InboxRow = {
      status: string
      attempts: number
      payload: unknown
      headers: Record<string, string> | null
      due_in_ms: number
    }
    async function inboxRows(): Promise<InboxRow[]> {
      return sql<InboxRow[]>`
        SELECT status, attempts, payload, headers,
          (extract(epoch FROM due_at - now()) * 1000)::float8 AS due_in_ms
        FROM kernel.webhook_inbox WHERE org_id = ${TEST_ORG} AND app_name = ${APP}`
    }

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

    describe("a handler's declared budget, through the real sandbox", () => {
      let bundleDir: string
      let bundlePath: string
      const savedBase = process.env.LIAISON_SANDBOX_TIMEOUT_MS
      const savedMax = process.env.LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS
      const post = () =>
        app.request(`/webhooks/${TEST_ORG}/${APP}/${ENDPOINT}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hello: "world" }),
        })
      const registerSpinner = (timeoutMs?: number) => {
        webhookHandlers.set([TEST_ORG, APP, ENDPOINT], {
          appName: APP,
          orgId: TEST_ORG,
          verify: async () => ({ valid: true as const, replayKey: crypto.randomUUID() }),
          handler: { bundlePath, exportName: "spin", core: true },
          _manifest: { name: APP, schema: {}, events: {}, connections: {}, network: {} },
          ...(timeoutMs ? { timeoutMs } : {}),
        } as never)
      }

      beforeAll(() => {
        bundleDir = mkdtempSync(join(tmpdir(), "webhook-budget-"))
        bundlePath = join(bundleDir, "bundle.js")
        writeFileSync(bundlePath, "globalThis.spin = async () => { while (true) {} }\n")
      })
      afterAll(() => rmSync(bundleDir, { recursive: true, force: true }))
      beforeEach(() => {
        // The resolver's floor at call time, far below the declared budgets here.
        process.env.LIAISON_SANDBOX_TIMEOUT_MS = "200"
      })
      afterEach(() => {
        if (savedBase === undefined) delete process.env.LIAISON_SANDBOX_TIMEOUT_MS
        else process.env.LIAISON_SANDBOX_TIMEOUT_MS = savedBase
        if (savedMax === undefined) delete process.env.LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS
        else process.env.LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS = savedMax
      })

      it("stops a spinning handler at its budget, in a pinned slot", async () => {
        await seedAppRow()
        registerSpinner(1_500)
        const peakBefore = pinnedJobsGate.state().held
        let heldDuring = 0
        const watch = setInterval(() => {
          heldDuring = Math.max(heldDuring, pinnedJobsGate.state().held)
        }, 50)
        const started = Date.now()
        const res = await post()
        clearInterval(watch)
        expect(res.status).toBe(500)
        const took = Date.now() - started
        expect(took).toBeGreaterThanOrEqual(1_400)
        expect(took).toBeLessThan(10_000)
        expect(heldDuring).toBe(peakBefore + 1)
      }, 20_000)

      it("honours the instance's ceiling on declared budgets", async () => {
        await seedAppRow()
        process.env.LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS = "1000"
        registerSpinner(20_000)
        const started = Date.now()
        const res = await post()
        expect(res.status).toBe(500)
        expect(Date.now() - started).toBeLessThan(10_000)
      }, 20_000)

      it("a delivery that cannot get a slot in time stays in the inbox for the replay, unrun", async () => {
        await seedAppRow()
        const savedCeiling = env.REQUEST_TIMEOUT_MS
        ;(env as { REQUEST_TIMEOUT_MS: number }).REQUEST_TIMEOUT_MS = 30_000
        const { max } = pinnedJobsGate.state()
        let free: () => void = () => {}
        const hold = new Promise<void>((r) => {
          free = r
        })
        const holders = Array.from({ length: max }, () => withPinnedJobSlot("test", () => hold))
        const enqueue = spyOn(jobsModule, "enqueueAppJob").mockResolvedValue(undefined as never)
        const handlerRan = mock(async () => ({ status: 200 }))
        webhookHandlers.set([TEST_ORG, APP, ENDPOINT], {
          appName: APP,
          orgId: TEST_ORG,
          verify: async () => ({ valid: true as const, replayKey: crypto.randomUUID() }),
          handler: handlerRan,
          // The longest allowed budget leaves a second of the request ceiling to wait.
          timeoutMs: 29_000,
        } as never)
        try {
          const started = Date.now()
          const res = await post()
          expect(res.status).toBe(500)
          expect(Date.now() - started).toBeLessThan(10_000)
          expect(handlerRan).not.toHaveBeenCalled()
          expect(enqueue.mock.calls.some((c) => c[1] === "webhook-inbox-replay")).toBe(true)
          const [row] = await inboxRows()
          expect(row?.status).toBe("pending")
        } finally {
          ;(env as { REQUEST_TIMEOUT_MS: number }).REQUEST_TIMEOUT_MS = savedCeiling
          free()
          await Promise.all(holders)
        }
      }, 20_000)

      it("a handler that declares no budget takes no slot", async () => {
        await seedAppRow()
        let held = -1
        registerHostHandler(async () => {
          held = pinnedJobsGate.state().held
          return { status: 200 }
        })
        const before = pinnedJobsGate.state().held
        const res = await post()
        expect(res.status).toBe(200)
        expect(held).toBe(before)
      })
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

    it("answers 503, not a bad signature, when the verifier loses its sandbox worker", async () => {
      await seedAppRow()
      webhookHandlers.set([TEST_ORG, APP, ENDPOINT], {
        appName: APP,
        orgId: TEST_ORG,
        verify: async () => {
          throw new Error("Sandbox worker crashed (exit 1)")
        },
        handler: async () => ({ status: 200 }),
      })
      const res = await app.request(`/webhooks/${TEST_ORG}/${APP}/${ENDPOINT}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      })
      expect(res.status).toBe(503)
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
        verify: { bundlePath, exportName: "verify", core: true },
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
      return spy.mock.calls.filter(
        (call) => call[0] === "kernel" && call[1] === "webhook-inbox-replay",
      ).length
    }

    // The org reached an app day cap: the app's verify runs, its handler waits for
    // the next UTC day in the inbox (payload and headers kept, `held`), and the
    // provider gets a 2xx so it neither retries nor drops the subscription.
    describe("an org at an app day cap", () => {
      const HOLD_MS = 3_600_000
      const verify = mock(async () => ({ valid: true as const, replayKey: "capped-replay-key" }))
      const registerCapped = () => {
        verify.mockClear()
        webhookHandlers.set([TEST_ORG, APP, ENDPOINT], {
          appName: APP,
          orgId: TEST_ORG,
          verify,
          // A sandboxed app's handler (not trusted): the cap applies. The bundle
          // does not exist, so a run would fail loudly instead of passing.
          handler: { bundlePath: "/nonexistent/capped/bundle.js", exportName: "onTopic" },
          _manifest: { name: APP, schema: {}, events: {}, connections: {}, network: {} },
        } as never)
      }
      const post = () =>
        app.request(`/webhooks/${TEST_ORG}/${APP}/${ENDPOINT}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Topic-Id": "t-1" },
          body: JSON.stringify({ order: 42 }),
        })

      it("holds the delivery in the inbox and answers 2xx {held:true}", async () => {
        await seedAppRow()
        const key = replayKeyFor("capped-replay-key")
        await redis.del(key)
        redisKeysToClean.push(key)
        registerCapped()
        const hold = spyOn(appDayCapModule, "appRunHoldMs").mockResolvedValue(HOLD_MS)
        const enqueue = spyRetryEnqueue()

        const res = await post()

        expect(res.status).toBe(200)
        expect(((await res.json()) as { data: unknown }).data).toEqual({
          received: true,
          held: true,
        })
        expect(verify).toHaveBeenCalledTimes(1)
        expect(hold).toHaveBeenCalledTimes(1)
        // Stored held, unrun, with its payload and headers, due at the hold's end.
        const rows = await inboxRows()
        expect(rows).toHaveLength(1)
        const [row] = rows as [InboxRow]
        expect(row.status).toBe("held")
        expect(row.attempts).toBe(0)
        expect(row.payload).toEqual({ order: 42 })
        expect(row.headers?.["x-topic-id"]).toBe("t-1")
        expect(Math.abs(row.due_in_ms - HOLD_MS)).toBeLessThan(60_000)
        // One wake, at the hold's end: nothing ran, so no failure retry was added.
        const wakes = enqueue.mock.calls.filter((c) => c[1] === "webhook-inbox-replay")
        expect(wakes).toHaveLength(1)
        const [queue, , data, opts] = wakes[0] as unknown as [
          string,
          string,
          Record<string, unknown>,
          { delay: number },
        ]
        expect(queue).toBe("kernel")
        expect(data.orgId).toBe(TEST_ORG)
        expect(opts.delay).toBe(HOLD_MS)
        // Held durably: the replay claim stays, so a provider retry is a duplicate.
        expect(await redis.exists(key)).toBe(1)
      })

      it("answers 503 and releases the replay claim when the hold cannot be stored", async () => {
        await seedAppRow()
        const key = replayKeyFor("capped-replay-key")
        await redis.del(key)
        redisKeysToClean.push(key)
        registerCapped()
        spyOn(appDayCapModule, "appRunHoldMs").mockResolvedValue(HOLD_MS)
        spyOn(inboxModule, "storeDelivery").mockRejectedValue(new Error("database down"))

        const res = await post()

        expect(res.status).toBe(503)
        expect(verify).toHaveBeenCalledTimes(1)
        expect(await redis.exists(key)).toBe(0)
      })
    })

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
      expect((await inboxRows()).map((r) => [r.status, r.payload])).toEqual([["rejected", null]])
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
      // Kept in the inbox for the replay, after the first backoff.
      const [row] = await inboxRows()
      expect(row?.status).toBe("pending")
      expect(row?.attempts).toBe(1)
      expect(row?.payload).toEqual({ hello: "world" })
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

    // The durable inbox (inbox.ts): stored before the handler runs, processed
    // once per verified identity, a waiting delivery taken over by a redelivery.
    describe("the webhook inbox", () => {
      const postOnce = () =>
        app.request(`/webhooks/${TEST_ORG}/${APP}/${ENDPOINT}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Delivery": "d-1" },
          body: JSON.stringify({ hello: "inbox" }),
        })

      it("stores the delivery before the handler runs, then settles it done without its payload", async () => {
        await seedAppRow()
        const key = replayKeyFor("fixed-replay-key")
        await redis.del(key)
        redisKeysToClean.push(key)
        let seen: InboxRow[] = []
        registerHostHandler(async () => {
          seen = await inboxRows()
          return { status: 200 }
        })

        const res = await postOnce()

        expect(res.status).toBe(200)
        expect(seen).toHaveLength(1)
        expect(seen[0]?.status).toBe("processing")
        expect(seen[0]?.payload).toEqual({ hello: "inbox" })
        expect(seen[0]?.headers?.["x-delivery"]).toBe("d-1")
        // The claim's lease outlives the request ceiling.
        expect(seen[0]?.due_in_ms ?? 0).toBeGreaterThan(env.REQUEST_TIMEOUT_MS)
        const [row] = await inboxRows()
        expect([row?.status, row?.payload, row?.headers]).toEqual(["done", null, null])
      })

      it("processes a verified identity once, even when the replay claim is gone", async () => {
        await seedAppRow()
        const key = replayKeyFor("fixed-replay-key")
        redisKeysToClean.push(key)
        const handler = mock(async () => ({ status: 200 }))
        registerHostHandler(handler)

        await redis.del(key)
        expect((await postOnce()).status).toBe(200)
        // The Redis claim lost (eviction, failover): the inbox still dedups.
        await redis.del(key)
        const second = await postOnce()

        expect(second.status).toBe(200)
        expect(((await second.json()) as { data: unknown }).data).toEqual({
          received: true,
          duplicate: true,
        })
        expect(handler).toHaveBeenCalledTimes(1)
      })

      it("a redelivery of a delivery waiting for its replay takes it over and runs it now", async () => {
        await seedAppRow()
        const key = replayKeyFor("fixed-replay-key")
        await redis.del(key)
        redisKeysToClean.push(key)
        spyRetryEnqueue()
        let calls = 0
        registerHostHandler(async () => {
          calls++
          return calls === 1 ? { status: 503 } : { status: 200 }
        })

        expect((await postOnce()).status).toBe(503)
        expect((await inboxRows())[0]?.status).toBe("pending")
        const res = await postOnce()

        expect(res.status).toBe(200)
        expect(calls).toBe(2)
        const [row] = await inboxRows()
        expect([row?.status, row?.attempts]).toEqual(["done", 2])
      })
    })
  })
})
