// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "~/db/connection"
import { processWebhookRetry, WebhookWorkerTestAccess } from "~/infra/jobs/webhook-worker"
import { webhookHandlers } from "~/modules/apps/app-registries"
import { forgetOrgApps, rememberOrgAppStates } from "~/modules/apps/org-apps"
import { initSandboxPool } from "~/modules/apps/sandbox/pool"

const RORG = "00000000-0000-0000-0000-0000000000b1"
const RAPP = "shopify"
const RENDPOINT = "orders"

// A real (empty) bundle file so the worker's real loadBundle() succeeds; the
// injected executor seam intercepts before any sandbox execution, so the file
// content is irrelevant.
let tmpDir: string
let bundlePath: string

// Captured arguments from the injected manifest executor.
const captured: { extraArgs?: unknown[]; params?: unknown }[] = []

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "webhook-retry-"))
  bundlePath = join(tmpDir, "bundle.js")
  writeFileSync(bundlePath, "globalThis.ordersWebhook = async () => {}\n")
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${RORG}, 'Webhook Retry Org', 'webhook-retry-org')
    ON CONFLICT (id) DO NOTHING`
  WebhookWorkerTestAccess.setManifestExecutor(async (opts) => {
    captured.push({ extraArgs: opts.extraArgs, params: opts.params })
    return undefined
  })
})

afterAll(async () => {
  WebhookWorkerTestAccess.setManifestExecutor()
  rmSync(tmpDir, { recursive: true, force: true })
  await sql`DELETE FROM kernel.organizations WHERE id = ${RORG}`
})

describe("webhook retry worker — header re-supply (B18)", () => {
  beforeEach(() => {
    captured.length = 0
    webhookHandlers.set([RORG, RAPP, RENDPOINT], {
      handler: { bundlePath, exportName: "ordersWebhook" },
      verify: { bundlePath, exportName: "verify" },
      appName: RAPP,
      orgId: RORG,
      _manifest: { name: RAPP } as never,
    })
  })

  afterEach(() => {
    webhookHandlers.delete([RORG, RAPP, RENDPOINT])
  })

  it("forwards persisted headers to the manifest handler as the 3rd arg", async () => {
    const headers = { "x-shopify-webhook-id": "evt-123", "content-type": "application/json" }
    await processWebhookRetry({
      orgId: RORG,
      appName: RAPP,
      endpointName: RENDPOINT,
      payload: { id: 1 },
      headers,
    })
    expect(captured).toHaveLength(1)
    expect(captured[0].extraArgs).toEqual([headers])
    expect(captured[0].params).toEqual({ id: 1 })
  })

  it("passes an empty header dict when the job carries no headers", async () => {
    await processWebhookRetry({
      orgId: RORG,
      appName: RAPP,
      endpointName: RENDPOINT,
      payload: { id: 2 },
    })
    expect(captured).toHaveLength(1)
    expect(captured[0].extraArgs).toEqual([{}])
  })

  it("drops the retry when the app is Off for the org (the handler does not run)", async () => {
    rememberOrgAppStates(RORG, [{ app: RAPP, status: "disabled" }])
    try {
      await processWebhookRetry({
        orgId: RORG,
        appName: RAPP,
        endpointName: RENDPOINT,
        payload: { id: 3 },
        headers: {},
      })
      expect(captured).toHaveLength(0)
    } finally {
      forgetOrgApps(RORG)
    }
  })

  // S11 (P3 T16): a retry keyed by its delivery id applies once. The job
  // re-run after its handler committed (a crash before the job completed, the
  // stalled check re-running it) does not run the handler again; a run whose
  // handler threw leaves the key free for the job's own retry. On the base the
  // second run applies the delivery again.
  it("effect runs once when its job is run twice with the same delivery id", async () => {
    const job = {
      orgId: RORG,
      appName: RAPP,
      endpointName: RENDPOINT,
      payload: { id: 7 },
      deliveryId: crypto.randomUUID(),
    }
    await processWebhookRetry(job)
    await processWebhookRetry(job)
    expect(captured).toHaveLength(1)
  })

  it("a retry whose handler threw runs again on the job's retry", async () => {
    const job = {
      orgId: RORG,
      appName: RAPP,
      endpointName: RENDPOINT,
      payload: { id: 8 },
      deliveryId: crypto.randomUUID(),
    }
    let calls = 0
    WebhookWorkerTestAccess.setManifestExecutor(async () => {
      calls++
      if (calls === 1) throw new Error("downstream down")
      return undefined
    })
    try {
      await expect(processWebhookRetry(job)).rejects.toThrow("downstream down")
      await processWebhookRetry(job)
      await processWebhookRetry(job)
      expect(calls).toBe(2)
    } finally {
      WebhookWorkerTestAccess.setManifestExecutor(async (opts) => {
        captured.push({ extraArgs: opts.extraArgs, params: opts.params })
        return undefined
      })
    }
  })

  // A retry whose process was killed inside the handler: the handler's
  // transaction rolled back with the process (nothing applied) and its claim is
  // a dead process's. The stalled re-run must apply the delivery, not drop it
  // as unknown (the retry is automatic: nobody else would ever re-run it).
  it("a retry killed inside its handler is run again by the re-run, not lost as unknown", async () => {
    const deliveryId = crypto.randomUUID()
    await sql`INSERT INTO kernel.effect_ledger (org_id, key, state, claimed_by, claimed_at)
      VALUES (${RORG}, ${`webhook:${RAPP}:${RENDPOINT}:${deliveryId}`}, 'pending',
        'dead-instance-of-a-killed-worker', now() - interval '1 hour')`
    await processWebhookRetry({
      orgId: RORG,
      appName: RAPP,
      endpointName: RENDPOINT,
      payload: { id: 9 },
      deliveryId,
    })
    expect(captured).toHaveLength(1)
    const [row] = await sql<{ state: string }[]>`SELECT state FROM kernel.effect_ledger
      WHERE org_id = ${RORG} AND key = ${`webhook:${RAPP}:${RENDPOINT}:${deliveryId}`}`
    expect(row?.state).toBe("done")
  })

  // Upgrade (rolling deploy): a `retry-webhook` job written by the previous
  // release's route, already waiting when this release starts (the inbox drain
  // moves only delayed ones), runs unchanged: the same handler, payload and
  // headers, under the same effect-ledger key.
  it("a job in the previous release's shape still runs unchanged", async () => {
    const deliveryId = "6f1c2a8e-3b7d-4c55-9a0e-1d2b3c4d5e6f"
    // Frozen copy of what the previous release enqueued (routes.ts, retry-webhook).
    const previousReleaseJob = JSON.parse(
      JSON.stringify({
        orgId: RORG,
        appName: RAPP,
        endpointName: RENDPOINT,
        payload: { id: 42, line_items: [{ sku: "A-1" }] },
        headers: { "x-shopify-webhook-id": "evt-42", "content-type": "application/json" },
        deliveryId,
      }),
    )
    await processWebhookRetry(previousReleaseJob)
    expect(captured).toEqual([
      {
        extraArgs: [{ "x-shopify-webhook-id": "evt-42", "content-type": "application/json" }],
        params: { id: 42, line_items: [{ sku: "A-1" }] },
      },
    ])
    const [row] = await sql<{ state: string }[]>`SELECT state FROM kernel.effect_ledger
      WHERE org_id = ${RORG} AND key = ${`webhook:${RAPP}:${RENDPOINT}:${deliveryId}`}`
    expect(row?.state).toBe("done")
    await sql`DELETE FROM kernel.effect_ledger WHERE org_id = ${RORG}
      AND key = ${`webhook:${RAPP}:${RENDPOINT}:${deliveryId}`}`
  })

  it("skips silently when no handler is registered", async () => {
    await processWebhookRetry({
      orgId: RORG,
      appName: RAPP,
      endpointName: "unregistered",
      payload: {},
      headers: {},
    })
    expect(captured).toHaveLength(0)
  })
})

describe("webhook retry key reconstruction", () => {
  it("finds handler after JSON roundtrip (tuple deserialization)", () => {
    const ORG_ID = "00000000-0000-0000-0000-000000000001"
    const APP = "test"
    const ENDPOINT = "endpoint"

    // Register a webhook handler
    webhookHandlers.set([ORG_ID, APP, ENDPOINT], {
      handler: async () => {},
      verify: async () => ({ valid: true, replayKey: "test" }),
      appName: APP,
      orgId: ORG_ID,
    })

    // Simulate what BullMQ does: serialize and deserialize
    const payload = JSON.parse(
      JSON.stringify({
        orgId: ORG_ID,
        appName: APP,
        endpointName: ENDPOINT,
        payload: { data: "test" },
      }),
    )

    // Reconstruct key from fields (the fix)
    const reg = webhookHandlers.get([payload.orgId, payload.appName, payload.endpointName])
    expect(reg).toBeDefined()
    expect(reg?.appName).toBe(APP)

    // Clean up
    webhookHandlers.delete([ORG_ID, APP, ENDPOINT])
  })
})

describe("webhook retry worker: a handler's declared budget (S11)", () => {
  const savedBase = process.env.LIAISON_SANDBOX_TIMEOUT_MS
  const savedMax = process.env.LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS
  const job = { orgId: RORG, appName: RAPP, endpointName: RENDPOINT, payload: {} }
  const register = (exportName: string, timeoutMs?: number, path = bundlePath) =>
    webhookHandlers.set([RORG, RAPP, RENDPOINT], {
      handler: { bundlePath: path, exportName, trusted: true },
      verify: { bundlePath, exportName: "verify" },
      appName: RAPP,
      orgId: RORG,
      _manifest: { name: RAPP } as never,
      ...(timeoutMs ? { timeoutMs } : {}),
    })

  beforeEach(() => {
    process.env.LIAISON_SANDBOX_TIMEOUT_MS = "200"
  })
  afterEach(() => {
    webhookHandlers.delete([RORG, RAPP, RENDPOINT])
    WebhookWorkerTestAccess.setManifestExecutor(async () => undefined)
    if (savedBase === undefined) delete process.env.LIAISON_SANDBOX_TIMEOUT_MS
    else process.env.LIAISON_SANDBOX_TIMEOUT_MS = savedBase
    if (savedMax === undefined) delete process.env.LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS
    else process.env.LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS = savedMax
  })

  it("passes the resolved budget to the executor; nothing declared stays the default", async () => {
    const seen: (number | undefined)[] = []
    WebhookWorkerTestAccess.setManifestExecutor(async (opts) => {
      seen.push(opts.timeoutMs)
      return undefined
    })
    register("ordersWebhook", 18_000)
    await processWebhookRetry(job)
    process.env.LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS = "4000"
    await processWebhookRetry(job)
    register("ordersWebhook")
    await processWebhookRetry(job)
    expect(seen).toEqual([18_000, 4_000, undefined])
  })

  it("the real sandbox stops a spinning retry at the declared budget", async () => {
    const spinPath = join(tmpDir, "spin.js")
    writeFileSync(spinPath, "globalThis.spin = async () => { while (true) {} }\n")
    await initSandboxPool()
    WebhookWorkerTestAccess.setManifestExecutor()
    register("spin", 1_500, spinPath)
    const started = Date.now()
    await expect(processWebhookRetry(job)).rejects.toThrow()
    const took = Date.now() - started
    expect(took).toBeGreaterThanOrEqual(1_400)
    expect(took).toBeLessThan(10_000)
  }, 20_000)
})
