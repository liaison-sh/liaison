// SPDX-License-Identifier: FSL-1.1-ALv2
//
// E2E — the REAL installed Pennylane bundled app, install → reach → behave,
// driven over the running `index.e2e.ts` server (spawned by `setupScenario`).
//
// This is NOT the component integration test (pennylane-connector.integration.test.ts,
// which drives the bundle's PennylaneClient + runConnectProbe directly through a
// bridgeFetch adapter). Here the FULL production path runs for real:
//   spawn server → POST /api/_test/pennylane/install-for-test (the server-side
//   install dance: installAppFromTarball + reloadInstalledApps + grant connection +
//   createCredentialConnection → outbox delivers connected_account:create →
//   onConnectionEstablished runs the connect probe THROUGH the mock) → register the
//   nine read tools + the gated upload → execute each over POST /api/apps/tools/
//   pennylane:<tool> → QuickJS sandbox bridge → makePennylaneMockFetch → mock recorder.
//
// The external Pennylane HTTP API (app.pennylane.com) is the ONLY thing mocked
// (makePennylaneMockFetch, wired into index.e2e.ts both arms + the SSRF
// intercepts-host predicate union). The connector capability itself is real.
//
// Per-process global mock MODE ⇒ all scenarios run SERIALLY within one worker.
// `afterEach` resets the mock. Scenarios needing a non-`full` probe verdict set
// the mode BEFORE install and re-install (the probe runs at install time under
// the mock's *current* mode).

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api, createUserWithScopes } from "@liaison/test-helpers"
import { setupScenario, teardownScenario } from "./setup"

type MockMode = "full" | "invoice_only" | "blocked_finance"

interface MockRecord {
  url: string
  method: string
  headers: Record<string, string>
  actor: string | null
  body: string | null
  receivedAt: number
}

describe("Pennylane E2E — install → reach → behave (real app, mocked external API)", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let prefix: string

  // Read-scoped driving user (all read tools + the gated invoices:write scope).
  let readUser: { id: string; token: string }
  // A seeded thread whose id is the gated-upload call's threadId (S10).
  let thread: { id: string }
  // A seeded kernel.files row id standing in for a mail-sourced attachment (S10).
  let seededFileId: string

  // ─── interaction helpers (local to this spec) ───

  // The mode the scenario last asked for. The install route pins the mock mode
  // itself (so a prior scenario's mode cannot leak into this install's connect
  // probe), which silently undid a `setMockMode` made just before the install:
  // every degraded-probe scenario saw the "full" verdict instead of its own.
  // Carrying the mode into the install body is what makes the pair work.
  let mockMode: MockMode = "full"

  async function installPennylane(
    orgId: string,
    mode: MockMode = mockMode,
  ): Promise<{ connectionId: string }> {
    const res = await api(url, "/api/_test/pennylane/install-for-test", {
      method: "POST",
      token: world.admin.token,
      body: { orgId, mode },
    })
    if (res.status !== 200) {
      throw new Error(`install-for-test failed: ${res.status} ${JSON.stringify(res.body)}`)
    }
    return { connectionId: res.body.connectionId }
  }

  async function setMockMode(
    mode: MockMode,
    opts?: { rateLimitOnce?: boolean; firm403?: boolean },
  ): Promise<void> {
    mockMode = mode
    const res = await api(url, "/api/_test/pennylane/mock/mode", {
      method: "POST",
      token: world.admin.token,
      body: { mode, ...opts },
    })
    expect(res.status).toBe(200)
  }

  async function resetMock(): Promise<void> {
    mockMode = "full"
    await api(url, "/api/_test/pennylane/mock/reset", {
      method: "POST",
      token: world.admin.token,
      body: {},
    })
  }

  async function mockRequests(): Promise<MockRecord[]> {
    const res = await api(url, "/api/_test/pennylane/mock/requests", { token: world.admin.token })
    expect(res.status).toBe(200)
    return res.body.requests as MockRecord[]
  }

  async function callTool(
    token: string,
    tool: string,
    params: Record<string, unknown>,
    opts?: { threadId?: string; asAgent?: boolean },
  ) {
    // A proposal is an AGENT's call (a person's own call never parks an
    // approval): `asAgent` makes it as the agent acting for `token`'s user.
    if (opts?.asAgent) {
      return api(url, "/api/_test/agent-tool-call", {
        method: "POST",
        token,
        body: {
          toolName: `pennylane:${tool}`,
          params,
          ...(opts.threadId ? { threadId: opts.threadId } : {}),
        },
      })
    }
    return api(url, `/api/apps/tools/pennylane:${tool}`, {
      method: "POST",
      token,
      body: { params, ...(opts?.threadId ? { threadId: opts.threadId } : {}) },
    })
  }

  /**
   * The version the install really lands, read from the app's own manifest.
   * The install route resolves its tarball from that manifest too, so a
   * literal here went stale the moment the app was bumped and failed two
   * scenarios on a version difference that is not what either is about.
   */
  function bundledVersion(): string {
    const manifestPath = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "..",
      "..",
      "bundled-apps",
      "pennylane",
      "app.manifest.json",
    )
    return (JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string }).version
  }

  function pnlSchema(): string {
    return prefix ? `"${prefix}app_pennylane"` : "app_pennylane"
  }
  function kernelSchema(): string {
    return prefix ? `"${prefix}kernel"` : "kernel"
  }

  /** Poll `app_pennylane.app_config` for the connect-probe verdict (no fixed sleep). */
  async function waitForConnectionScope(
    deadlineMs = 10_000,
  ): Promise<{ scope: string; cash_status: string } | null> {
    const deadline = Date.now() + deadlineMs
    while (Date.now() < deadline) {
      const rows = await env.db.sql.unsafe(
        `SELECT value FROM ${pnlSchema()}.app_config WHERE key = 'connection_scope' LIMIT 1`,
      )
      if (rows.length > 0) {
        const v = rows[0].value
        return (typeof v === "string" ? JSON.parse(v) : v) as { scope: string; cash_status: string }
      }
      await Bun.sleep(50)
    }
    return null
  }

  /** Rebuild the .liaisonapp so the install route never depends on a stale artifact. */
  function buildBundle(): void {
    const liaisonRoot = `${import.meta.dir}/../../../../..`
    const r = spawnSync("bash", ["scripts/build-bundled-app.sh", "pennylane", "--skip-sign"], {
      cwd: liaisonRoot,
      stdio: "pipe",
      encoding: "utf8",
    })
    if (r.status !== 0) {
      throw new Error(`buildBundle failed (${r.status}): ${r.stderr ?? r.stdout ?? "<no output>"}`)
    }
  }

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 71,
      org: { name: "Pennylane E2E Org" },
      populate: { users: { count: 2 } },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
    prefix = env.schemaPrefix ?? ""

    // Hermetic: build the tarball so the install route always has a fresh artifact.
    buildBundle()

    // A read-scoped + write-scoped driving user (reads + the gated upload).
    readUser = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: [
        "pennylane:invoices:read",
        "pennylane:reports:read",
        "pennylane:cash:read",
        "pennylane:invoices:write",
      ],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })

    // A thread for the gated-upload call (S10 passes its id as threadId; a gated
    // tool with no threadId short-circuits to 403 before createApprovalRequest).
    thread = await world.threads.create(world.users[0], {
      participantIds: [world.users[1].id],
      initialMessage: { content: "Pennylane upload approval thread" },
    })

    // A kernel.files row standing in for a mail-sourced attachment PDF (S10 file_id).
    // The file is parented on the mail app/thread (a typical mail-sourced attachment
    // shape); supplier_invoice_upload reads it under the caller's RLS and stages it.
    const ks = kernelSchema()
    const [fileRow] = await env.db.sql.unsafe(
      `INSERT INTO ${ks}.files
         (org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key, uploaded_by)
       VALUES ($1, 'mail', 'message', $2, 'acme-invoice.pdf', 'application/pdf', 1024, $3, $4)
       RETURNING id`,
      [world.org.id, thread.id, `e2e/pennylane/acme-invoice-${Date.now()}.pdf`, world.users[0].id],
    )
    seededFileId = fileRow.id as string
  }, 180_000)

  afterEach(async () => {
    await resetMock()
  })

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 15_000)

  // ─── INFRA-1: smoke ───

  it("smoke: Pennylane installs and one read returns the seeded book (+ SSRF negative)", async () => {
    await setMockMode("full")
    const { connectionId } = await installPennylane(world.org.id)
    expect(typeof connectionId).toBe("string")
    expect(connectionId.length).toBeGreaterThan(0)

    // `kernel.apps` is the org-scoped registry carrying the active status; the disk
    // record (`apps_installed`) has no status column. Both must reflect the install.
    const ks = kernelSchema()
    const [appRow] = await env.db.sql.unsafe(
      `SELECT name, status, version FROM ${ks}.apps WHERE name = 'pennylane'`,
    )
    expect(appRow).toBeDefined()
    expect(appRow.status).toBe("active")
    const [installRow] = await env.db.sql.unsafe(
      `SELECT name, version FROM ${ks}.apps_installed WHERE name = 'pennylane'`,
    )
    expect(installRow).toBeDefined()
    expect(installRow.version).toBe(bundledVersion())

    // One interaction through the full path: install → register → execute → sandbox
    // bridge → mock fetch → projected response.
    const res = await callTool(readUser.token, "supplier_invoices_list", {})
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data.items)).toBe(true)
    expect(res.body.data.items.length).toBe(3)
    // Money is minor-units bigint → serialized to a STRING across the QuickJS bridge.
    expect(typeof res.body.data.items[0].total.amount_minor).toBe("string")
    // SSRF negative: the body is the seeded book, NOT a private-host/SSRF error
    // (guards the SandboxBridgeTestAccess.setFetchInterceptsHost predicate union).
    expect(res.body.error).toBeUndefined()
  }, 60_000)

  // ─── S1: install round-trip ───

  it("S1: app installs + registers all read tools, reachable via executeTool", async () => {
    await setMockMode("full")
    const { connectionId } = await installPennylane(world.org.id)
    expect(/^[0-9a-f-]{36}$/.test(connectionId)).toBe(true)

    const ks = kernelSchema()
    const [appRow] = await env.db.sql.unsafe(
      `SELECT status, version FROM ${ks}.apps WHERE name = 'pennylane'`,
    )
    expect(appRow.status).toBe("active")
    expect(appRow.version).toBe(bundledVersion())

    // Registration → reachability: the tool actually runs through executeTool.
    const res = await callTool(readUser.token, "supplier_invoices_list", {})
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data.items)).toBe(true)
  }, 60_000)

  // ─── S2: connect-probe `full` ───

  it("S2: connect-probe full → scope=full / cash live persisted via lifecycle event", async () => {
    await setMockMode("full")
    await installPennylane(world.org.id)

    const scope = await waitForConnectionScope()
    expect(scope).not.toBeNull()
    expect(scope).toEqual({ scope: "full", cash_status: "live" })

    const reqs = await mockRequests()
    const supplierProbe = reqs.find(
      (r) =>
        r.url.includes("/api/external/v2/supplier_invoices") &&
        r.url.includes("limit=1") &&
        r.method === "GET",
    )
    const bankProbe = reqs.find(
      (r) =>
        r.url.includes("/api/external/v2/bank_accounts") &&
        r.url.includes("limit=1") &&
        r.method === "GET",
    )
    expect(supplierProbe).toBeDefined()
    expect(bankProbe).toBeDefined()
    // PennylaneClient sets a static Authorization: Bearer header on every call.
    expect(supplierProbe?.headers.authorization).toMatch(/^Bearer /)
    expect(bankProbe?.headers.authorization).toMatch(/^Bearer /)
  }, 60_000)

  // ─── S3: connect-probe `invoice_only` (bank-403) ───

  it("S3: connect-probe invoice_only (bank-403) degrades, connection stays active", async () => {
    await setMockMode("invoice_only")
    const { connectionId } = await installPennylane(world.org.id)

    const scope = await waitForConnectionScope()
    expect(scope).toEqual({ scope: "invoice_only", cash_status: "unavailable" })

    // A bank-403 is a degrade, NOT a connection failure — app + connection survive.
    const ks = kernelSchema()
    const [appRow] = await env.db.sql.unsafe(
      `SELECT status FROM ${ks}.apps WHERE name = 'pennylane'`,
    )
    expect(appRow.status).toBe("active")
    const [connRow] = await env.db.sql.unsafe(
      `SELECT id FROM ${ks}.connected_accounts WHERE id = $1`,
      [connectionId],
    )
    expect(connRow).toBeDefined()
  }, 60_000)

  // ─── S4: connect-probe `blocked_finance` (supplier-403) ───

  it("S4: connect-probe blocked_finance (supplier-403) scoped to finance; server stays healthy", async () => {
    await setMockMode("blocked_finance")
    await installPennylane(world.org.id)

    // The probe THROWS in onConnectionEstablished (supplier-403 → BLOCKED finance
    // class) BEFORE persistConnectionScope — so no full|invoice_only verdict lands.
    // Poll briefly to give the outbox worker time to attempt the probe, then assert
    // absence of a non-blocked verdict.
    const deadline = Date.now() + 6_000
    let scope: { scope: string; cash_status: string } | null = null
    while (Date.now() < deadline) {
      scope = await waitForConnectionScope(200)
      if (scope) break
      await Bun.sleep(200)
    }
    // No full|invoice_only scope persisted — the probe threw before persisting one.
    if (scope) {
      expect(["full", "invoice_only"]).not.toContain(scope.scope)
    } else {
      expect(scope).toBeNull()
    }

    // The supplier-403 was exercised through the real probe path.
    const reqs = await mockRequests()
    const supplierProbe = reqs.find(
      (r) => r.url.includes("/api/external/v2/supplier_invoices") && r.method === "GET",
    )
    expect(supplierProbe).toBeDefined()

    // The degrade is SCOPED — the server keeps running, other routes respond.
    const health = await api(url, "/api/health")
    expect(health.status).toBe(200)
  }, 60_000)

  // ─── S5: pnl_summary reconciled P&L ───

  it("S5: pnl_summary reconciled P&L through real read path (601→COGS, gross_margin=rev−cogs)", async () => {
    await setMockMode("full")
    await installPennylane(world.org.id)

    const tb = await callTool(readUser.token, "trial_balance_get", {})
    expect(tb.status).toBe(200)
    const byCode = Object.fromEntries(
      (tb.body.data.lines as Array<{ account_code: string; balance_minor: string }>).map((l) => [
        l.account_code,
        l.balance_minor,
      ]),
    )
    // Money is minor-units bigint → STRINGS across the bridge. Board-realistic scale
    // (revenue €100,000 = 10000000 minor) so the live-Shopify DTC slice is a coherent ~19%.
    expect(byCode["707000"]).toBe("10000000")
    expect(byCode["601000"]).toBe("4000000")
    expect(byCode["627000"]).toBe("500000")

    const pnl = await callTool(readUser.token, "pnl_summary", {})
    expect(pnl.status).toBe(200)
    const d = pnl.body.data
    // pnl_summary money fields carry the `_minor` suffix (the shared minor-units convention)
    // so the agent never reads a bare integer as whole euros (the board-deck 100× fab trap).
    expect(d.revenue_minor).toBe("10000000")
    // 601… classifies COGS via longest-prefix (601 beats 60=opex) — load-bearing.
    expect(d.cogs_minor).toBe("4000000")
    expect(d.opex_minor).toBe("500000")
    expect(d.gross_margin_minor).toBe("6000000") // = revenue − cogs (60%)
    expect(d.revenue).toBeUndefined()
    expect(d.gross_margin).toBeUndefined()
  }, 60_000)

  // ─── S6: runway_estimate single-currency ───

  it("S6: runway_estimate = cash ÷ trailing net burn, single-currency (EUR 30000000/3000000=10)", async () => {
    await setMockMode("full")
    await installPennylane(world.org.id)

    const cash = await callTool(readUser.token, "cash_position", {})
    expect(cash.status).toBe(200)
    expect(cash.body.data.cash_status).toBe("live")
    expect(cash.body.data.total_by_currency.EUR).toBe("30000000")
    expect(cash.body.data.total_by_currency.USD).toBe("9000000")

    const runway = await callTool(readUser.token, "runway_estimate", {})
    expect(runway.status).toBe(200)
    expect(runway.body.data.cash_status).toBe("live")
    // EUR cash 30000000 ÷ EUR net burn 3000000 = 10. USD bucket + USD flow excluded
    // (single-currency runway, no automated FX). Ratio unchanged from the prior scale.
    expect(runway.body.data.months).toBe(10)
  }, 60_000)

  // ─── S7: bank-403 honest degrade ───

  it("S7: bank-403 honest degrade — cash + runway unavailable/null, never fabricate", async () => {
    await setMockMode("invoice_only")
    await installPennylane(world.org.id)
    const scope = await waitForConnectionScope()
    expect(scope?.cash_status).toBe("unavailable")

    const cash = await callTool(readUser.token, "cash_position", {})
    expect(cash.status).toBe(200)
    expect(cash.body.data.cash_status).toBe("unavailable")
    expect(cash.body.data.accounts).toEqual([])
    expect(cash.body.data.total_by_currency).toEqual({})

    const runway = await callTool(readUser.token, "runway_estimate", {})
    expect(runway.status).toBe(200)
    expect(runway.body.data.cash_status).toBe("unavailable")
    expect(runway.body.data.months).toBeNull()

    // P&L survives a bank-403 — only cash is descoped.
    const pnl = await callTool(readUser.token, "pnl_summary", {})
    expect(pnl.status).toBe(200)
    expect(pnl.body.data.revenue_minor).toBe("10000000")
  }, 60_000)

  // ─── S8: firm-403 → ledger_entries reconstruction (drives code-review C-1) ───

  it("S8: firm-403 trial-balance → ledger_entries reconstruction (real read path)", async () => {
    // Install cleanly under full (probe hits supplier_invoices/bank_accounts, not
    // trial_balance), THEN flip firm403 so /trial_balance 403s at read time.
    await setMockMode("full")
    await installPennylane(world.org.id)
    await setMockMode("full", { firm403: true })
    await resetMock() // clears the recorder; firm403 is cleared too — re-set it
    await setMockMode("full", { firm403: true })

    const pnl = await callTool(readUser.token, "pnl_summary", {})
    expect(pnl.status).toBe(200)
    // Same reconciled P&L, reconstructed from /ledger_entries (not the 403'd TB).
    expect(pnl.body.data.revenue_minor).toBe("10000000")
    expect(pnl.body.data.cogs_minor).toBe("4000000")
    expect(pnl.body.data.gross_margin_minor).toBe("6000000")

    const reqs = await mockRequests()
    const tbReq = reqs.find(
      (r) => r.url.includes("/api/external/v2/trial_balance") && r.method === "GET",
    )
    const ledgerReq = reqs.find(
      (r) => r.url.includes("/api/external/v2/ledger_entries") && r.method === "GET",
    )
    // The read attempted /trial_balance (got 403) THEN fell back to /ledger_entries
    // — the fallback fired end-to-end through the real read handler (C-1).
    expect(tbReq).toBeDefined()
    expect(ledgerReq).toBeDefined()
  }, 60_000)

  // ─── S9: supplier_invoices_list filter narrows ───

  it("S9: supplier_invoices_list filter narrows results through the real sandbox bridge", async () => {
    await setMockMode("full")
    await installPennylane(world.org.id)

    const all = await callTool(readUser.token, "supplier_invoices_list", {})
    expect(all.status).toBe(200)
    const allItems = all.body.data.items as Array<{
      status: string
      total: { amount_minor: string; currency: string }
    }>
    expect(allItems.length).toBe(3)
    expect(typeof allItems[0].total.amount_minor).toBe("string")
    expect(allItems[0].total.currency).toBe("EUR")

    const filtered = await callTool(readUser.token, "supplier_invoices_list", {
      filter: [{ field: "status", operator: "eq", value: "unpaid" }],
    })
    expect(filtered.status).toBe(200)
    const filteredItems = filtered.body.data.items as Array<{ status: string }>
    // si_1 + si_3 are unpaid; si_2 is paid → strictly fewer, all unpaid.
    expect(filteredItems.length).toBeLessThan(allItems.length)
    expect(filteredItems.length).toBe(2)
    expect(filteredItems.every((i) => i.status === "unpaid")).toBe(true)

    // Wire-level proof: the filtered request carried the encoded filter= query param
    // (the filter[] JSON survived agent params → QuickJS bridge → client encode → mock).
    const reqs = await mockRequests()
    const filteredReq = reqs.find(
      (r) =>
        r.url.includes("/api/external/v2/supplier_invoices") &&
        r.url.includes("filter=") &&
        r.url.includes("unpaid"),
    )
    expect(filteredReq).toBeDefined()
  }, 60_000)

  // ─── S10: gated supplier_invoice_upload PROPOSES ───

  it("S10: gated supplier_invoice_upload PROPOSES (lands approval), no silent POST", async () => {
    await setMockMode("full")
    await installPennylane(world.org.id)

    const res = await callTool(
      readUser.token,
      "supplier_invoice_upload",
      {
        file_id: seededFileId,
        supplier_name: "Acme Parts",
        invoice_date: "2026-06-01",
        amount_minor: "40000",
        currency: "EUR",
      },
      { threadId: thread.id, asAgent: true },
    )
    // Gated → 200 with a blocked/approval envelope under body.data.blocked.
    expect(res.status).toBe(200)
    expect(res.body.data.blocked).toBeDefined()
    expect(res.body.data.blocked.reason).toBe("gated")
    expect(/^[0-9a-f-]{36}$/.test(res.body.data.blocked.approvalRequestId)).toBe(true)

    // A real approval row landed (the human-visible side effect; createApprovalRequest
    // ran, which only happens AFTER the threadId check passes).
    const ks = kernelSchema()
    const approvals = (await env.db.sql.unsafe(
      `SELECT id, tool_name, summary FROM ${ks}.approval_requests WHERE tool_name LIKE 'pennylane:%'`,
    )) as unknown as Array<{ id: string; tool_name: string; summary: unknown }>
    expect(approvals.length).toBeGreaterThanOrEqual(1)
    const row = approvals.find((a) => a.tool_name.includes("supplier_invoice_upload"))
    expect(row).toBeDefined()
    // summary is jsonb; the default summarizer puts the serialized params (incl.
    // supplier_name) into `lines` — assert the supplier surfaces in the card.
    expect(JSON.stringify(row?.summary)).toContain("Acme Parts")

    // Negative assertion (degrade-first contract): NO POST to a Pennylane upload
    // endpoint — the tool stages + proposes, it does NOT silently file a document.
    const reqs = await mockRequests()
    const uploadPost = reqs.find((r) => r.method === "POST" && r.url.includes("app.pennylane.com"))
    expect(uploadPost).toBeUndefined()
  }, 60_000)

  // ─── S11: home_load reachability + empty-snapshot null-degrade ───

  it("S11: home_load registered + reachable, degrades cleanly on an empty snapshot", async () => {
    await setMockMode("full")
    await installPennylane(world.org.id)

    const res = await callTool(readUser.token, "home_load", {})
    expect(res.status).toBe(200)
    // Last registered read tool not otherwise driven E2E — reachable through executeTool.
    expect("pnl" in res.body.data).toBe(true)
    expect("cash" in res.body.data).toBe(true)
    // Fresh install: snapshots are TRUNCATEd and the cron has not run → null-degrade.
    expect(res.body.data.pnl).toBeNull()
    expect(res.body.data.cash).toBeNull()
  }, 60_000)

  // ─── S12: spend_by_category buckets the seeded trial balance by P&L class ───

  it("S12: spend_by_category buckets the seeded book by P&L class (rev/cogs/opex/other)", async () => {
    await setMockMode("full")
    await installPennylane(world.org.id)

    // spend_by_category aggregates the SAME trial-balance lines pnl_summary reads
    // (707000→revenue, 601000→cogs, 627000→opex via the default PCG class map),
    // returning one bucket per PnlClass — reachable read tool #6 asserted E2E.
    const res = await callTool(readUser.token, "spend_by_category", {})
    expect(res.status).toBe(200)
    expect(res.body.error).toBeUndefined()
    const cats = res.body.data.categories as Array<{ class: string; total_minor: string }>
    // One bucket per PnlClass, in the fixed declaration order.
    expect(cats.map((c) => c.class)).toEqual(["revenue", "cogs", "opex", "other"])
    // Money is minor-units bigint → STRINGS across the QuickJS bridge.
    const byClass = Object.fromEntries(cats.map((c) => [c.class, c.total_minor]))
    expect(typeof byClass.revenue).toBe("string")
    // Reconciles to the seeded trial balance: 707000=10000000 / 601000=4000000 / 627000=500000.
    expect(byClass.revenue).toBe("10000000")
    expect(byClass.cogs).toBe("4000000")
    expect(byClass.opex).toBe("500000")
    expect(byClass.other).toBe("0")

    // Wire-level proof: the aggregation sourced /trial_balance (not a synthetic value).
    const reqs = await mockRequests()
    const tbReq = reqs.find(
      (r) => r.url.includes("/api/external/v2/trial_balance") && r.method === "GET",
    )
    expect(tbReq).toBeDefined()
  }, 60_000)

  // ─── S13: transactions_list projects amount_minor (signed bigint→string) ───

  it("S13: transactions_list projects the seeded burn-side flow (signed minor-units → string)", async () => {
    await setMockMode("full")
    await installPennylane(world.org.id)

    // transactions_list is the burn-side read runway_estimate consumes; assert it
    // directly — reachable read tool #7 — against the single seeded EUR outflow.
    const res = await callTool(readUser.token, "transactions_list", {})
    expect(res.status).toBe(200)
    expect(res.body.error).toBeUndefined()
    const d = res.body.data
    const items = d.items as Array<{ amount_minor: string; currency: string }>
    // One seeded transaction: {amount: -3000000, currency: "EUR"} (a €30,000 EUR outflow).
    expect(items.length).toBe(1)
    // Negative minor-units survive the bigint→string bridge coercion as a STRING.
    expect(typeof items[0].amount_minor).toBe("string")
    expect(items[0].amount_minor).toBe("-3000000")
    expect(items[0].currency).toBe("EUR")
    // Single mock page: no further cursor, not truncated.
    expect(d.next_cursor).toBeNull()
    expect(d.has_more).toBe(false)

    // Wire-level proof: the read hit /transactions through the real sandbox bridge.
    const reqs = await mockRequests()
    const txReq = reqs.find(
      (r) => r.url.includes("/api/external/v2/transactions") && r.method === "GET",
    )
    expect(txReq).toBeDefined()
  }, 60_000)

  // ─── S14: customer_invoices_list projects AR headers (customer_name fallback) ───

  it("S14: customer_invoices_list projects the seeded AR header (customer_name fallback)", async () => {
    await setMockMode("full")
    await installPennylane(world.org.id)

    // customer_invoices_list is the receivable side; the projector reuses the
    // supplier-invoice header shape, falling supplier_name back to customer_name
    // (a customer invoice carries no supplier_name) — reachable read tool #8.
    const res = await callTool(readUser.token, "customer_invoices_list", {})
    expect(res.status).toBe(200)
    expect(res.body.error).toBeUndefined()
    const d = res.body.data
    const items = d.items as Array<{
      id: string
      supplier_name: string
      total: { amount_minor: string; currency: string }
      status: string
      due_date: string
      invoice_date: string
    }>
    // One seeded customer invoice: ci_1, BuyerCo, EUR 10000000 (€100,000), paid.
    expect(items.length).toBe(1)
    const ci = items[0]
    expect(ci.id).toBe("ci_1")
    // supplier_name falls back to the raw customer_name (the projector's union).
    expect(ci.supplier_name).toBe("BuyerCo")
    // Money is minor-units bigint → STRING across the bridge.
    expect(typeof ci.total.amount_minor).toBe("string")
    expect(ci.total.amount_minor).toBe("10000000")
    expect(ci.total.currency).toBe("EUR")
    expect(ci.status).toBe("paid")
    expect(ci.due_date).toBe("2026-06-15")
    expect(ci.invoice_date).toBe("2026-06-01")
    expect(d.next_cursor).toBeNull()
    expect(d.has_more).toBe(false)
  }, 60_000)

  // ─── S15: supplier_invoice_get fetches one header by id ───

  it("S15: supplier_invoice_get returns the single seeded header for an id", async () => {
    await setMockMode("full")
    await installPennylane(world.org.id)

    // supplier_invoice_get is the single-header read (the only GET-by-id tool in the
    // suite) — reachable read tool #9. Fetch si_1 and assert the projected header.
    const res = await callTool(readUser.token, "supplier_invoice_get", { id: "si_1" })
    expect(res.status).toBe(200)
    expect(res.body.error).toBeUndefined()
    const inv = res.body.data as {
      id: string
      supplier_name: string
      total: { amount_minor: string; currency: string }
      status: string
      due_date: string
      invoice_date: string
    }
    // A single object (not a list envelope) — the seeded si_1 supplier invoice.
    expect(inv.id).toBe("si_1")
    expect(inv.supplier_name).toBe("Acme Parts")
    expect(typeof inv.total.amount_minor).toBe("string")
    expect(inv.total.amount_minor).toBe("40000")
    expect(inv.total.currency).toBe("EUR")
    expect(inv.status).toBe("unpaid")
    expect(inv.due_date).toBe("2026-07-01")
    expect(inv.invoice_date).toBe("2026-06-01")

    // Wire-level proof: the read hit the by-id GET path (.../supplier_invoices/si_1).
    const reqs = await mockRequests()
    const getReq = reqs.find(
      (r) => r.url.includes("/api/external/v2/supplier_invoices/si_1") && r.method === "GET",
    )
    expect(getReq).toBeDefined()
  }, 60_000)
})
