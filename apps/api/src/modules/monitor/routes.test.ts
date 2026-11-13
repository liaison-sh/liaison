// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * C3 -- GET /diag integration test. Real Postgres/Redis via app.request (house harness).
 */
import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { sql } from "~/db/connection"
import { FairnessTestAccess, fairMetricsKey } from "~/infra/jobs/fairness"
import { JOBS_METRICS_KEY } from "~/infra/jobs/fanout-keys"
import * as searchClient from "~/infra/search/client"
import { _setEdition } from "~/lib/edition"
import { _resetLatencyWindow } from "~/lib/latency-window"
import { monitorLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { _resetMaintenanceCache } from "~/middleware/maintenance"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool } from "~/modules/apps/sandbox/pool"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"
import { buildTestApp } from "~/tests/helpers/build-app"

const MONITOR_TOKEN = process.env.MONITOR_TOKEN ?? ""

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES ('00000000-0000-0000-0000-000000000001', 'Diag Test Org', 'diag-test')
    ON CONFLICT (id) DO NOTHING`
  // The mailbox tests seed app_mail.accounts rows: its columns past the baseline
  // (encryption_state, ...) come from the mail app's schema sync, so register
  // the app here rather than rely on an earlier file of the run having done it.
  await acquireAppSchemaJsLock("app_mail")
  try {
    await initSandboxPool()
    await registerApps([mailAppManifest], "00000000-0000-0000-0000-000000000001")
  } finally {
    await releaseAppSchemaJsLock("app_mail")
  }
}, 60_000)

describe("GET /diag", () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    delete process.env.MAINTENANCE_FLAG_PATH
    _resetMaintenanceCache()
  })

  it("exposes the webhook-health lists and no silence window", async () => {
    const app = await buildTestApp()
    const res = await app.request("/diag", {
      headers: { Authorization: `Bearer ${MONITOR_TOKEN}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { webhookIngest: Record<string, unknown> }
    expect(Array.isArray(body.webhookIngest.rejectingApps)).toBe(true)
    expect(Array.isArray(body.webhookIngest.missedDeliveryApps)).toBe(true)
    expect(Array.isArray(body.webhookIngest.staleProbeApps)).toBe(true)
    expect(Array.isArray(body.webhookIngest.probedApps)).toBe(true)
    expect("silentApps" in body.webhookIngest).toBe(false)
  })

  it("http latency field: managed only (self-hosted has none)", async () => {
    const app = await buildTestApp()
    const diag = async () =>
      (await (
        await app.request("/diag", { headers: { Authorization: `Bearer ${MONITOR_TOKEN}` } })
      ).json()) as { http?: { p95Ms: number | null; count: number; windowS: number } }
    try {
      _setEdition("self_hosted")
      _resetLatencyWindow()
      await app.request("/api/client-policy")
      expect("http" in (await diag())).toBe(false)
      _setEdition("managed")
      _resetLatencyWindow()
      await app.request("/api/client-policy")
      await app.request("/api/client-policy")
      const body = await diag()
      expect(body.http?.windowS).toBe(900)
      expect(body.http?.count).toBeGreaterThanOrEqual(2)
      expect(typeof body.http?.p95Ms).toBe("number")
    } finally {
      _setEdition(null)
      _resetLatencyWindow()
    }
  })

  it("no token -> 401", async () => {
    const app = await buildTestApp()
    const res = await app.request("/diag")
    expect(res.status).toBe(401)
  })

  it("wrong token -> 401", async () => {
    const app = await buildTestApp()
    const res = await app.request("/diag", { headers: { Authorization: "Bearer wrong-token" } })
    expect(res.status).toBe(401)
  })

  it("wrong-length token -> 401", async () => {
    const app = await buildTestApp()
    const res = await app.request("/diag", { headers: { Authorization: "Bearer short" } })
    expect(res.status).toBe(401)
  })

  it("correct token -> 200, zod-validated full shape, live db numbers", async () => {
    const app = await buildTestApp()
    const res = await app.request("/diag", {
      headers: { Authorization: `Bearer ${MONITOR_TOKEN}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      diagVersion: number
      appVersion: string
      appRuns: {
        judgedOn: string
        alerts: unknown[]
        thresholds: Record<string, number>
        process: Record<string, { windowS: number; lanes: Record<string, unknown> }>
        cell: Record<string, { windowS: number }> | null
      }
      uptimeSec: number
      errorSignatures: unknown[]
      outbox: { oldestPendingAgeSec: number | null; deadLetterCount: number }
      worker: { lastTickAt: string | null; heartbeatSource: string }
      deps: { postgres: string; redis: string; meili: string; s3: string }
      db: { activeConnections: number; maxConnections: number }
      rlsPool: {
        inFlight: number
        acquireTimeouts: number
        lastAcquireTimeoutAgoMs: number | null
        statementTimeouts: number
        lastStatementTimeoutAgoMs: number | null
      }
      mailIngest: {
        mailboxInboxes: number
        unhealthyInboxes: number
        oldestSyncAgeSec: number | null
        unhealthy: Array<{
          emailAddress: string | null
          connectionStatus: string
          lastSyncAgeSec: number | null
        }>
      }
    }
    expect(body.diagVersion).toBe(2)
    expect(body.appRuns.process["15m"]?.windowS).toBe(900)
    expect(body.appRuns.process["24h"]?.windowS).toBe(86_400)
    expect(Object.keys(body.appRuns.process["15m"]?.lanes ?? {}).sort()).toEqual([
      "background",
      "interactive",
      "nested",
    ])
    expect(body.appRuns.judgedOn).toBe("cell")
    expect(body.appRuns.cell?.["15m"]?.windowS).toBe(900)
    expect(Array.isArray(body.appRuns.alerts)).toBe(true)
    expect(body.appRuns.thresholds.timeoutsMin).toBe(10)
    expect(typeof body.appVersion).toBe("string")
    expect(typeof body.uptimeSec).toBe("number")
    expect(Array.isArray(body.errorSignatures)).toBe(true)
    expect(body.worker.heartbeatSource).toBe("inproc")
    expect(body.deps.postgres).toBe("ok")
    expect(body.deps.redis).toBe("ok")
    expect(body.db.activeConnections).toBeGreaterThanOrEqual(1)
    expect(body.db.maxConnections).toBeGreaterThan(0)
    expect(body.outbox.deadLetterCount).toBeGreaterThanOrEqual(0)
    // U4.16 — the sandbox-wedge leading indicator: pool pressure must be
    // visible at /diag BEFORE it becomes a total wedge (watchdog-consumable).
    expect(typeof body.rlsPool.inFlight).toBe("number")
    expect(body.rlsPool.inFlight).toBeGreaterThanOrEqual(0)
    expect(typeof body.rlsPool.acquireTimeouts).toBe("number")
    expect(typeof body.rlsPool.statementTimeouts).toBe("number")
    // Mailbox-ingest health: the watchdog fires `mail-ingest` critical when a mailbox inbox
    // shows active but its OAuth connection has died. Shape must be present + typed so the
    // collector is watchdog-consumable (unhealthyInboxes drives the alert).
    expect(typeof body.mailIngest.mailboxInboxes).toBe("number")
    expect(typeof body.mailIngest.unhealthyInboxes).toBe("number")
    expect(body.mailIngest.unhealthyInboxes).toBeGreaterThanOrEqual(0)
    expect(Array.isArray(body.mailIngest.unhealthy)).toBe(true)
    // Silent inbound drops are counted per reason.
    expect(typeof (body as unknown as { inboundMailDrops: unknown }).inboundMailDrops).toBe(
      "object",
    )
  })

  it("rlsPool.inFlight reflects a concurrently-open withRlsContext transaction", async () => {
    const { withRlsContext } = await import("~/db/rls")
    const app = await buildTestApp()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const txPromise = withRlsContext(
      {
        actorType: "system",
        orgId: "00000000-0000-0000-0000-000000000001",
        purpose: "job",
        scopes: [],
      },
      async () => {
        await held
      },
    )
    try {
      // Give the transaction a moment to actually acquire+begin.
      await new Promise((r) => setTimeout(r, 50))
      const res = await app.request("/diag", {
        headers: { Authorization: `Bearer ${MONITOR_TOKEN}` },
      })
      const body = (await res.json()) as { rlsPool: { inFlight: number } }
      expect(body.rlsPool.inFlight).toBeGreaterThanOrEqual(1)
    } finally {
      release()
      await txPromise
    }
  })

  it("exposes the pool plan and every pool's gauge", async () => {
    const { poolPlan } = await import("~/db/process-pool-plan")
    const app = await buildTestApp()
    const res = await app.request("/diag", {
      headers: { Authorization: `Bearer ${MONITOR_TOKEN}` },
    })
    const body = (await res.json()) as {
      poolPlan: { pools: Record<string, number>; verdict: string; mode: string }
      pools: Record<
        string,
        { max: number; held: number; peak: number; waiting: number; acquireTimeouts: number }
      >
      nestedPrivilegedAcquisitions: number
    }
    expect(body.poolPlan.pools).toEqual(poolPlan.pools)
    expect(body.poolPlan.verdict).toBe(poolPlan.verdict)
    expect(Object.keys(body.pools).sort()).toEqual([
      "jobs",
      "main",
      "privileged",
      "privilegedJobs",
      "request",
    ])
    expect(body.pools.privileged?.max).toBe(poolPlan.pools.privileged)
    expect(typeof body.pools.request?.acquireTimeouts).toBe("number")
    expect(typeof body.nestedPrivilegedAcquisitions).toBe("number")
    expect((body as unknown as { pinnedJobs: { max: number } }).pinnedJobs.max).toBe(
      poolPlan.pinnedJobSlots,
    )
  })

  it("a forced unhandled error appears in errorSignatures", async () => {
    const app = await buildTestApp()
    // Route the throwing test route through the same errorHandler the real app uses to
    // exercise the C1 tracker wiring end-to-end.
    const { Hono } = await import("hono")
    const { errorHandler } = await import("~/middleware/error-handler")
    const probe = new Hono()
    probe.get("/__diag_probe_throw", () => {
      throw new Error("diag probe unhandled error")
    })
    probe.onError(errorHandler)
    await probe.request("/__diag_probe_throw")

    const res = await app.request("/diag", {
      headers: { Authorization: `Bearer ${MONITOR_TOKEN}` },
    })
    const body = (await res.json()) as { errorSignatures: Array<{ lastSample: string }> }
    expect(
      body.errorSignatures.some((s) => s.lastSample.includes("diag probe unhandled error")),
    ).toBe(true)
  })

  it("maintenance flag set -> /diag still 200 while an /api/* route short-circuits", async () => {
    const d = mkdtempSync(join(tmpdir(), "liaison-diag-maint-"))
    dirs.push(d)
    const flagPath = join(d, "maintenance")
    writeFileSync(flagPath, "")
    // Set MAINTENANCE_FLAG_PATH directly (rather than via buildTestApp's opts) and build
    // with no options -- buildTestApp's finally block restores process.env to its
    // PRE-CALL value once the import resolves, which would otherwise delete the flag path
    // out from under us before app.request() ever runs (readMaintenanceState() re-reads
    // process.env on every request, it isn't captured at build time). Matches the working
    // pattern in src/middleware/maintenance.test.ts.
    process.env.MAINTENANCE_FLAG_PATH = flagPath
    const app = await buildTestApp()

    const apiRes = await app.request("/api/threads")
    expect(apiRes.status).toBe(503)

    const diagRes = await app.request("/diag", {
      headers: { Authorization: `Bearer ${MONITOR_TOKEN}` },
    })
    expect(diagRes.status).toBe(200)
  })

  it("a connected mailbox whose last sync is stale reports reason 'sync_stalled'", async () => {
    // Seed a kind='mailbox' tickets inbox on a LIVE gmail connection whose newest
    // recorded sync is 3h old (> the 1h default). The connection still shows active, so
    // this is exactly the silent-stall case (dead push watch, wedged worker) the old /diag
    // model missed. Clean up in finally so the seeded row never leaks into sibling tests.
    const caId = "00000000-0000-0000-0000-0000000ca511"
    const inboxId = "00000000-0000-0000-0000-00000001b0c1"
    const userId = "00000000-0000-0000-0000-0000000005e1"
    const staleIso = new Date(Date.now() - 3 * 3600 * 1000).toISOString()
    try {
      await sql`INSERT INTO kernel.users (id, org_id, email, name)
        VALUES (${userId}, '00000000-0000-0000-0000-000000000001', 'diag-seed@diag.test', 'Diag Seed')
        ON CONFLICT (id) DO NOTHING`
      const metaJson = JSON.stringify({ gmail: { historyId: "42", lastSyncAt: staleIso } })
      await sql`INSERT INTO kernel.connected_accounts
        (id, org_id, app_name, connection_name, owner_type, provider_type, identifier,
         status, metadata, created_by)
        VALUES (${caId}, '00000000-0000-0000-0000-000000000001', 'tickets', 'gmail', 'org',
         'gmail', 'stalled-mailbox@diag.test', 'active',
         ${metaJson}::jsonb,
         ${userId})
        ON CONFLICT (id) DO NOTHING`
      await sql`INSERT INTO app_tickets.inboxes
        (id, org_id, connected_account_id, name, email_address, kind)
        VALUES (${inboxId}, '00000000-0000-0000-0000-000000000001', ${caId},
         'Stalled Mailbox', 'stalled-mailbox@diag.test', 'mailbox')
        ON CONFLICT (id) DO NOTHING`

      const app = await buildTestApp()
      const res = await app.request("/diag", {
        headers: { Authorization: `Bearer ${MONITOR_TOKEN}` },
      })
      const body = (await res.json()) as {
        mailIngest: {
          oldestSyncAgeSec: number | null
          unhealthy: Array<{
            emailAddress: string | null
            reason?: string
            lastSyncAgeSec: number | null
          }>
        }
      }
      const stalled = body.mailIngest.unhealthy.find(
        (u) => u.emailAddress === "stalled-mailbox@diag.test",
      )
      expect(stalled).toBeDefined()
      expect(stalled?.reason).toBe("sync_stalled")
      expect(stalled?.lastSyncAgeSec ?? 0).toBeGreaterThan(3600)
      expect(body.mailIngest.oldestSyncAgeSec ?? 0).toBeGreaterThan(3600)
    } finally {
      await sql`DELETE FROM app_tickets.inboxes WHERE id = ${inboxId}`
      await sql`DELETE FROM kernel.connected_accounts WHERE id = ${caId}`
      await sql`DELETE FROM kernel.users WHERE id = ${userId}`
    }
  })

  it("mail-app accounts stuck in error or wedged mid-initial-sync report unhealthy", async () => {
    // Two app_mail.accounts failure modes the tickets-inbox join can never see (prod
    // 2026-07-11: admin@ wedged in 'syncing' for 10h with zero alerts):
    //  - sync_status='error' (reconnect required)            -> account_error
    //  - sync_status='syncing' with updated_at 3h stale (the backfill job chain is dead;
    //    a live backfill saves cursor progress every page)   -> initial_sync_wedged
    const caId = "00000000-0000-0000-0000-0000000ca512"
    const userId = "00000000-0000-0000-0000-0000000005e2"
    const errAcctId = "00000000-0000-0000-0000-0000000acc01"
    const wedgedAcctId = "00000000-0000-0000-0000-0000000acc02"
    const staleIso = new Date(Date.now() - 3 * 3600 * 1000).toISOString()
    try {
      await sql`INSERT INTO kernel.users (id, org_id, email, name)
        VALUES (${userId}, '00000000-0000-0000-0000-000000000001', 'diag-mail-seed@diag.test', 'Diag Mail Seed')
        ON CONFLICT (id) DO NOTHING`
      await sql`INSERT INTO kernel.connected_accounts
        (id, org_id, app_name, connection_name, owner_type, provider_type, identifier, status, created_by)
        VALUES (${caId}, '00000000-0000-0000-0000-000000000001', 'mail', 'gmail', 'org',
         'gmail', 'diag-mail@diag.test', 'active', ${userId})
        ON CONFLICT (id) DO NOTHING`
      await sql`INSERT INTO app_mail.accounts
        (id, org_id, connected_account_id, owner_type, provider, email_address,
         sync_status, last_sync_error, updated_at)
        VALUES (${errAcctId}, '00000000-0000-0000-0000-000000000001', ${caId}, 'org', 'gmail',
         'errored-mailbox@diag.test', 'error', 'Token revoked -- reconnect required', now())
        ON CONFLICT (id) DO NOTHING`
      await sql`INSERT INTO app_mail.accounts
        (id, org_id, connected_account_id, owner_type, provider, email_address,
         sync_status, updated_at)
        VALUES (${wedgedAcctId}, '00000000-0000-0000-0000-000000000001', ${caId}, 'org', 'gmail',
         'wedged-mailbox@diag.test', 'syncing', ${staleIso})
        ON CONFLICT (id) DO NOTHING`

      const app = await buildTestApp()
      const res = await app.request("/diag", {
        headers: { Authorization: `Bearer ${MONITOR_TOKEN}` },
      })
      const body = (await res.json()) as {
        mailIngest: {
          mailboxInboxes: number
          unhealthyInboxes: number
          unhealthy: Array<{
            emailAddress: string | null
            connectionStatus: string
            reason?: string
            statusMessage?: string | null
          }>
        }
      }
      const errored = body.mailIngest.unhealthy.find(
        (u) => u.emailAddress === "errored-mailbox@diag.test",
      )
      expect(errored).toBeDefined()
      expect(errored?.reason).toBe("account_error")
      expect(errored?.statusMessage).toContain("reconnect")
      const wedged = body.mailIngest.unhealthy.find(
        (u) => u.emailAddress === "wedged-mailbox@diag.test",
      )
      expect(wedged).toBeDefined()
      expect(wedged?.reason).toBe("initial_sync_wedged")
      expect(body.mailIngest.unhealthyInboxes).toBeGreaterThanOrEqual(2)
      // Mail accounts are counted into the watched-mailbox total.
      expect(body.mailIngest.mailboxInboxes).toBeGreaterThanOrEqual(2)
    } finally {
      await sql`DELETE FROM app_mail.accounts WHERE id IN (${errAcctId}, ${wedgedAcctId})`
      await sql`DELETE FROM kernel.connected_accounts WHERE id = ${caId}`
      await sql`DELETE FROM kernel.users WHERE id = ${userId}`
    }
  })

  it("a healthy mid-backfill account (fresh updated_at) is NOT flagged", async () => {
    // A live initial sync legitimately sits in 'syncing' for hours on a big mailbox; it
    // saves cursor progress onto the row every page, so a FRESH updated_at must not page.
    const caId = "00000000-0000-0000-0000-0000000ca513"
    const userId = "00000000-0000-0000-0000-0000000005e3"
    const acctId = "00000000-0000-0000-0000-0000000acc03"
    try {
      await sql`INSERT INTO kernel.users (id, org_id, email, name)
        VALUES (${userId}, '00000000-0000-0000-0000-000000000001', 'diag-mail-seed2@diag.test', 'Diag Mail Seed 2')
        ON CONFLICT (id) DO NOTHING`
      await sql`INSERT INTO kernel.connected_accounts
        (id, org_id, app_name, connection_name, owner_type, provider_type, identifier, status, created_by)
        VALUES (${caId}, '00000000-0000-0000-0000-000000000001', 'mail', 'gmail', 'org',
         'gmail', 'diag-mail2@diag.test', 'active', ${userId})
        ON CONFLICT (id) DO NOTHING`
      await sql`INSERT INTO app_mail.accounts
        (id, org_id, connected_account_id, owner_type, provider, email_address,
         sync_status, updated_at)
        VALUES (${acctId}, '00000000-0000-0000-0000-000000000001', ${caId}, 'org', 'gmail',
         'backfilling-mailbox@diag.test', 'syncing', now())
        ON CONFLICT (id) DO NOTHING`

      const app = await buildTestApp()
      const res = await app.request("/diag", {
        headers: { Authorization: `Bearer ${MONITOR_TOKEN}` },
      })
      const body = (await res.json()) as {
        mailIngest: { unhealthy: Array<{ emailAddress: string | null }> }
      }
      expect(
        body.mailIngest.unhealthy.find((u) => u.emailAddress === "backfilling-mailbox@diag.test"),
      ).toBeUndefined()
    } finally {
      await sql`DELETE FROM app_mail.accounts WHERE id = ${acctId}`
      await sql`DELETE FROM kernel.connected_accounts WHERE id = ${caId}`
      await sql`DELETE FROM kernel.users WHERE id = ${userId}`
    }
  })

  it("a personal mailbox waiting for encryption enrollment is NOT flagged as wedged", async () => {
    // A reset (or never-enrolled) personal mailbox sits in 'pre-sync' with a stale row by
    // design: sync is suspended until its owner enrolls new keys. The same stale row on an
    // ENROLLED ('ready') mailbox is a dead initial-sync chain and must still page.
    const caId = "00000000-0000-0000-0000-0000000ca514"
    const userId = "00000000-0000-0000-0000-0000000005e4"
    const waitingAcctId = "00000000-0000-0000-0000-0000000acc04"
    const readyAcctId = "00000000-0000-0000-0000-0000000acc05"
    const staleIso = new Date(Date.now() - 3 * 3600 * 1000).toISOString()
    try {
      await sql`INSERT INTO kernel.users (id, org_id, email, name)
        VALUES (${userId}, '00000000-0000-0000-0000-000000000001', 'diag-mail-seed3@diag.test', 'Diag Mail Seed 3')
        ON CONFLICT (id) DO NOTHING`
      await sql`INSERT INTO kernel.connected_accounts
        (id, org_id, app_name, connection_name, owner_type, provider_type, identifier, status, created_by)
        VALUES (${caId}, '00000000-0000-0000-0000-000000000001', 'mail', 'gmail', 'user',
         'gmail', 'diag-mail3@diag.test', 'active', ${userId})
        ON CONFLICT (id) DO NOTHING`
      await sql`INSERT INTO app_mail.accounts
        (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
         sync_status, encryption_state, updated_at)
        VALUES (${waitingAcctId}, '00000000-0000-0000-0000-000000000001', ${caId}, 'user', ${userId}, 'gmail',
         'awaiting-keys-mailbox@diag.test', 'pre-sync', 'pending_enrollment', ${staleIso})
        ON CONFLICT (id) DO NOTHING`
      await sql`INSERT INTO app_mail.accounts
        (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
         sync_status, encryption_state, updated_at)
        VALUES (${readyAcctId}, '00000000-0000-0000-0000-000000000001', ${caId}, 'user', ${userId}, 'gmail',
         'enrolled-wedged-mailbox@diag.test', 'pre-sync', 'ready', ${staleIso})
        ON CONFLICT (id) DO NOTHING`

      const app = await buildTestApp()
      const res = await app.request("/diag", {
        headers: { Authorization: `Bearer ${MONITOR_TOKEN}` },
      })
      const body = (await res.json()) as {
        mailIngest: { unhealthy: Array<{ emailAddress: string | null; reason?: string }> }
      }
      expect(
        body.mailIngest.unhealthy.find((u) => u.emailAddress === "awaiting-keys-mailbox@diag.test"),
      ).toBeUndefined()
      expect(
        body.mailIngest.unhealthy.find(
          (u) => u.emailAddress === "enrolled-wedged-mailbox@diag.test",
        )?.reason,
      ).toBe("initial_sync_wedged")
    } finally {
      await sql`DELETE FROM app_mail.accounts WHERE id IN (${waitingAcctId}, ${readyAcctId})`
      await sql`DELETE FROM kernel.connected_accounts WHERE id = ${caId}`
      await sql`DELETE FROM kernel.users WHERE id = ${userId}`
    }
  })

  // REGRESSION: 59 health-dep criticals over 54 days produced zero diagnostic content --
  // the incident body was literally "see diag payload", with nothing recording WHICH dep
  // went non-ok. /diag must carry per-dep latency AND warn (never error, since a transient
  // dep hiccup is expected, and the watchdog pages on pino level >= 50) whenever any dep
  // is not ok.
  it("carries per-dep latencyMs and warns (not errors) when a dep is non-ok", async () => {
    const warnSpy = spyOn(monitorLogger, "warn")
    const errorSpy = spyOn(monitorLogger, "error")
    const meiliSpy = spyOn(searchClient, "getMeili").mockReturnValue({
      health: async () => Promise.reject(new Error("meili down")),
    } as never)
    try {
      const app = await buildTestApp()
      const res = await app.request("/diag", {
        headers: { Authorization: `Bearer ${MONITOR_TOKEN}` },
      })
      const body = (await res.json()) as {
        deps: { postgres: string; redis: string; meili: string; s3: string }
        depLatencyMs: { postgres: number; redis: number; meili: number; s3: number }
      }
      expect(body.deps.meili).not.toBe("ok")
      expect(typeof body.depLatencyMs.postgres).toBe("number")
      expect(typeof body.depLatencyMs.redis).toBe("number")
      expect(typeof body.depLatencyMs.meili).toBe("number")
      expect(typeof body.depLatencyMs.s3).toBe("number")
      expect(warnSpy).toHaveBeenCalled()
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      meiliSpy.mockRestore()
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it("outbox lag fields are null-safe on an empty table", async () => {
    const app = await buildTestApp()
    const res = await app.request("/diag", {
      headers: { Authorization: `Bearer ${MONITOR_TOKEN}` },
    })
    const body = (await res.json()) as { outbox: { oldestPendingAgeSec: number | null } }
    // Either null (empty) or a number -- never throws, never undefined.
    expect(
      body.outbox.oldestPendingAgeSec === null ||
        typeof body.outbox.oldestPendingAgeSec === "number",
    ).toBe(true)
  })

  it("shows per-queue fairness counters (busyOrgs a count, no org id) and fan-out counters per (app, job)", async () => {
    const orgId = crypto.randomUUID()
    const queue = "kernel-agent"
    await redis.hincrby(fairMetricsKey(queue), "admitted", 3)
    await redis.hincrby(fairMetricsKey(queue), "denied", 2)
    await redis.zadd(FairnessTestAccess.keys.qKey(queue, orgId), Date.now(), "diag-job")
    await redis.zadd(FairnessTestAccess.keys.orgsKey(queue), Date.now(), orgId)
    await redis.hincrby(JOBS_METRICS_KEY, "fanout_enqueued:diagapp:sync", 7)
    await redis.hincrby(JOBS_METRICS_KEY, "legacy_tick_dropped:diagapp:sync", 1)
    try {
      const app = await buildTestApp()
      const res = await app.request("/diag", {
        headers: { Authorization: `Bearer ${MONITOR_TOKEN}` },
      })
      expect(res.status).toBe(200)
      const text = await res.text()
      const body = JSON.parse(text) as {
        jobs: {
          fairness?: {
            enabled: boolean
            queues: Record<string, { admitted: number; denied: number; busyOrgs: number }>
          }
          fanout?: { schedulers: number; byJob: Record<string, Record<string, number>> }
        }
      }
      const agent = body.jobs.fairness?.queues[queue]
      expect(body.jobs.fairness?.enabled).toBe(true)
      expect(agent?.admitted).toBeGreaterThanOrEqual(3)
      expect(agent?.denied).toBeGreaterThanOrEqual(2)
      expect(agent?.busyOrgs).toBeGreaterThanOrEqual(1)
      expect(text).not.toContain(orgId)
      expect(body.jobs.fanout?.byJob["diagapp:sync"]?.fanout_enqueued).toBeGreaterThanOrEqual(7)
      expect(body.jobs.fanout?.byJob["diagapp:sync"]?.legacy_tick_dropped).toBeGreaterThanOrEqual(1)
      expect(typeof body.jobs.fanout?.schedulers).toBe("number")
    } finally {
      await redis.del(FairnessTestAccess.keys.qKey(queue, orgId))
      await redis.zrem(FairnessTestAccess.keys.orgsKey(queue), orgId)
      await redis.hdel(
        JOBS_METRICS_KEY,
        "fanout_enqueued:diagapp:sync",
        "legacy_tick_dropped:diagapp:sync",
      )
    }
  })
})
