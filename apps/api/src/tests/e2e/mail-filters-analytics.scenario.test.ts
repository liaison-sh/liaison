// SPDX-License-Identifier: FSL-1.1-ALv2
//
// E2E — deep-week-sim capability Modules C + D, install → reach → behave over the
// running `index.e2e.ts` server (spawned by `setupScenario`).
//
//   Module C — Mail search filters (real `mail:search` tool, host-manifest QuickJS
//   bundle): `from`/sender, `since`/`until` date-range, `body` text, honest paging
//   (exact totalCount + correct nextCursor), and malformed-date → typed validation
//   error. Driven over POST /api/apps/tools/mail:search (executeTool → sandbox
//   bridge → agentMailSearch). Conversations + messages are seeded directly into
//   `app_mail`; the sender is the denormalized `from_email` column (the C-1 fix).
//
//   Module D — Shopify `analytics_query` (real bundled app): a typed,
//   injection-hardened aggregate read. The agent supplies structured enum params
//   (metric / period / groupBy); the handler assembles the ShopifyQL internally
//   from a frozen allowlist. The external `*.myshopify.com` Admin GraphQL boundary
//   is the ONLY thing mocked (makeShopifyMockFetch, wired into index.e2e.ts +
//   the SSRF intercepts-host union). The connector capability itself is real:
//   install → register → execute → QuickJS sandbox bridge → mock recorder. A
//   `no_shopifyql` mode flips the mock to `parseErrors` so the handler degrades to
//   a BOUNDED in-context tally over `orders_search` (bound STATED).
//
// Per-process global Shopify mock MODE ⇒ all scenarios run SERIALLY within one
// worker. All fixtures use FICTIONAL values (*.test domains) per the privacy guard.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api, createUserWithScopes } from "@liaison/test-helpers"
import { seedConversation, seedMessage } from "./helpers/mail-seed"
import { setupScenario, teardownScenario } from "./setup"

// ─── shared types for the tool envelopes ───

interface MailSearchItem {
  id: string
  subject?: string | null
  fromEmail: string | null
  lastMessageAt?: string | null
}
interface MailSearchOk {
  items: MailSearchItem[]
  totalCount: number
  nextCursor?: string
}

interface ShopifyMockRecord {
  url: string
  method: string
  headers: Record<string, string>
  actor: string | null
  body: string | null
  operation: string | null
  receivedAt: number
}

describe("Mail filters (Module C) + Shopify analytics (Module D) — E2E (real apps, mocked external boundary)", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let prefix: string

  // Mail-scoped driving user (read).
  let mailUser: { id: string; token: string }
  // Shopify analytics-scoped driving user.
  let shopUser: { id: string; token: string }
  // The seeded `app_mail.accounts` row id all conversations hang off.
  let mailAccountId: string
  // Shopify is installed ONCE (apps_installed PK is (name,version)); the
  // per-scenario behavior is driven by the mock MODE, not by re-installing.
  let shopConnectionId: string

  function mailSchema(): string {
    return prefix ? `"${prefix}app_mail"` : "app_mail"
  }

  // ─── interaction helpers ───

  /** POST a mail tool; params go in the body root (executeTool: params ?? body).
   *  A handler `{ error }` return is surfaced by the route as an HTTP error
   *  envelope (`body.error`, status derived from the code), NOT under body.data. */
  async function callMailTool(
    token: string,
    tool: string,
    params: Record<string, unknown>,
  ): Promise<{
    status: number
    data: MailSearchOk | undefined
    error?: { code: string; message: string }
    /** The response, rendered for an assertion message. */
    why: string
  }> {
    const res = await api(url, `/api/apps/tools/mail:${tool}`, {
      method: "POST",
      token,
      body: params,
    })
    return {
      status: res.status,
      data: res.body.data as MailSearchOk | undefined,
      error: res.body.error as { code: string; message: string } | undefined,
      why: `${tool}: ${JSON.stringify(res.body)}`.slice(0, 600),
    }
  }

  async function callShopTool(
    token: string,
    tool: string,
    params: Record<string, unknown>,
  ): Promise<{
    status: number
    data: Record<string, unknown> | undefined
    error?: { code: string; message: string }
    /** The error, rendered for an assertion message: a bare "expected 200,
     *  received 500" says nothing about what the tool actually refused. */
    why: string
  }> {
    const res = await api(url, `/api/apps/tools/shopify:${tool}`, {
      method: "POST",
      token,
      body: params,
    })
    return {
      status: res.status,
      data: res.body.data as Record<string, unknown> | undefined,
      error: res.body.error as { code: string; message: string } | undefined,
      why: `${tool}: ${JSON.stringify(res.body)}`.slice(0, 600),
    }
  }

  async function installShopify(): Promise<{ connectionId: string; shopDomain: string }> {
    // Real-Shopify install MODE (realOfflineToken set) → no api_base_url override,
    // so get-client builds `https://<shopDomain>.myshopify.com` — the canonical
    // host the in-process mock intercepts. The token is inert (the mock ignores
    // auth); the shop domain is FICTIONAL.
    const res = await api(url, "/api/_test/shopify/install-for-test", {
      method: "POST",
      token: world.admin.token,
      body: {
        orgId: world.org.id,
        realOfflineToken: "mock-offline-token",
        realWebhookSecret: "mock-webhook-secret-deep-week-sim",
        shopDomain: "deep-week-sim.myshopify.com",
      },
    })
    if (res.status !== 200) {
      throw new Error(`shopify install-for-test failed: ${res.status} ${JSON.stringify(res.body)}`)
    }
    return { connectionId: res.body.connectionId, shopDomain: res.body.shopDomain }
  }

  async function setShopMockMode(mode: "shopifyql" | "no_shopifyql"): Promise<void> {
    const res = await api(url, "/api/_test/shopify/mock/mode", {
      method: "POST",
      token: world.admin.token,
      body: { mode },
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  }

  async function resetShopMock(): Promise<void> {
    await api(url, "/api/_test/shopify/mock/reset", {
      method: "POST",
      token: world.admin.token,
      body: {},
    })
  }

  async function shopMockRequests(): Promise<ShopifyMockRecord[]> {
    const res = await api(url, "/api/_test/shopify/mock/requests", { token: world.admin.token })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    return res.body.requests as ShopifyMockRecord[]
  }

  /** Rebuild the shopify .liaisonapp so the install route never depends on a
   *  stale artifact (hermetic — mirrors the pennylane E2E). */
  function buildShopifyBundle(): void {
    const liaisonRoot = `${import.meta.dir}/../../../../..`
    const r = spawnSync("bash", ["scripts/build-bundled-app.sh", "shopify", "--skip-sign"], {
      cwd: liaisonRoot,
      stdio: "pipe",
      encoding: "utf8",
    })
    if (r.status !== 0) {
      throw new Error(
        `buildShopifyBundle failed (${r.status}): ${r.stderr ?? r.stdout ?? "<none>"}`,
      )
    }
  }

  /** Seed a conversation with a denormalized sender + last_message_at, plus a body message. */
  async function seedConv(opts: {
    fromEmail: string
    subject: string
    snippet?: string
    lastMessageAt?: string
    bodyText?: string
  }): Promise<string> {
    const { id } = await seedConversation(env, {
      accountId: mailAccountId,
      orgId: world.org.id,
      ownerType: "org",
      ownerId: null,
      subject: opts.subject,
      lastMessageAt: opts.lastMessageAt,
      messageCount: 1,
    })
    // Denormalized sender (C-1) — seedConversation does not set from_email; the
    // search `from` filter narrows on this column, with a case-insensitive
    // substring post-filter. snippet is also overridden for query-AND tests.
    const ms = mailSchema()
    await env.db.sql.unsafe(
      `UPDATE ${ms}.conversations SET from_email = $1, snippet = $2 WHERE id = $3`,
      [opts.fromEmail.toLowerCase(), opts.snippet ?? opts.subject, id],
    )
    if (opts.bodyText !== undefined) {
      await seedMessage(env, {
        conversationId: id,
        accountId: mailAccountId,
        orgId: world.org.id,
        ownerType: "org",
        ownerId: null,
        fromAddress: { email: opts.fromEmail },
        toAddresses: [{ email: "inbox@deep-week-sim.test" }],
        subject: opts.subject,
        textBody: opts.bodyText,
        direction: "inbound",
        sentAt: opts.lastMessageAt ?? new Date().toISOString(),
      })
    }
    return id
  }

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 84,
      org: { name: "Mail+Shopify Deep-Week-Sim E2E" },
      populate: { users: { count: 2 } },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
    prefix = env.schemaPrefix ?? ""

    mailUser = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: ["mail:conversations:read"],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })
    shopUser = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: ["shopify:analytics:read", "shopify:orders:read"],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })

    // Seed an org-owned mail account row directly — the search tool projects the
    // account email and scopes RLS by org ownership (mailUser has `*:*`).
    // `connected_account_id` is NOT NULL; a synthetic UUID is fine (the search
    // path only reads `email_address`).
    const ms = mailSchema()
    mailAccountId = randomUUID()
    await env.db.sql.unsafe(
      `INSERT INTO ${ms}.accounts
         (id, org_id, connected_account_id, owner_type, owner_id, provider,
          email_address, display_name, sync_status, created_at)
       VALUES ($1, $2, $3, 'org', NULL, 'gmail', $4, $5, 'active', now())`,
      [
        mailAccountId,
        world.org.id,
        randomUUID(),
        "inbox@deep-week-sim.test",
        "Deep Week Sim Inbox",
      ],
    )

    // Hermetic: rebuild the tarball so the install route always has a fresh
    // artifact (the install harness installs from dist/, not from source).
    buildShopifyBundle()

    // Install the Shopify bundle ONCE (the apps_installed PK is (name, version),
    // so a re-install would collide). Per-scenario behavior is the mock MODE.
    await setShopMockMode("shopifyql")
    const install = await installShopify()
    shopConnectionId = install.connectionId
  }, 240_000)

  afterAll(async () => {
    await resetShopMock()
    await teardownScenario(env, world)
  }, 15_000)

  // ════════════════════════════════════════════════════════════════════════
  //  Module C — Mail search filters
  // ════════════════════════════════════════════════════════════════════════

  // ─── C1: `from`/sender filter narrows (case-insensitive substring) ───

  it("C1: mail:search `from` narrows by sender email (case-insensitive), exact totalCount", async () => {
    const c1 = await seedConv({
      fromEmail: "purchasing@northwind-audio.test",
      subject: "Bulk order #4471",
      lastMessageAt: "2026-05-10T09:00:00Z",
    })
    const _c2 = await seedConv({
      fromEmail: "orders@cascade-synths.test",
      subject: "Cascade restock",
      lastMessageAt: "2026-05-11T09:00:00Z",
    })
    const c3 = await seedConv({
      // mixed-case domain — email casing is inconsistent across providers
      fromEmail: "sales@NORTHWIND-AUDIO.test",
      subject: "Northwind catalogue",
      lastMessageAt: "2026-05-12T09:00:00Z",
    })

    const res = await callMailTool(mailUser.token, "search", { from: "@northwind-audio.test" })
    expect(res.status, res.why).toBe(200)
    expect(res.error).toBeUndefined()
    const ok = res.data as MailSearchOk
    const ids = ok.items.map((i) => i.id).sort()
    expect(ids).toEqual([c1, c3].sort())
    // Exact post-filter total (a wrong count makes the agent page-burn budget).
    expect(ok.totalCount).toBe(2)
    // Every returned conversation's sender matches the needle, case-insensitively.
    for (const item of ok.items) {
      expect(String(item.fromEmail ?? "").toLowerCase()).toContain("@northwind-audio.test")
    }
  }, 60_000)

  // ─── C2: `from` ANDs with free-text `query` ───

  it("C2: `from` ANDs with free-text `query` (a sender's newsletters don't pollute a topical search)", async () => {
    const d1 = await seedConv({
      fromEmail: "shop@boutique-modular.test",
      subject: "Order #5001",
      snippet: "Eurorack wholesale pricing",
      lastMessageAt: "2026-05-13T09:00:00Z",
    })
    const _d2 = await seedConv({
      fromEmail: "shop@boutique-modular.test",
      subject: "Newsletter",
      snippet: "Spring catalogue is out",
      lastMessageAt: "2026-05-14T09:00:00Z",
    })

    const res = await callMailTool(mailUser.token, "search", {
      from: "@boutique-modular.test",
      query: "Eurorack",
    })
    expect(res.status, res.why).toBe(200)
    const ok = res.data as MailSearchOk
    expect(ok.items.map((i) => i.id)).toEqual([d1])
    expect(ok.totalCount).toBe(1)
  }, 60_000)

  // ─── C3: date-range (since/until inclusive) + body text + malformed-date error ───

  it("C3: `since`/`until` window is inclusive-bounded over received date", async () => {
    await seedConv({
      fromEmail: "a@window-fixture.test",
      subject: "Just before",
      lastMessageAt: "2026-04-30T23:59:59Z",
    })
    const q2 = await seedConv({
      fromEmail: "b@window-fixture.test",
      subject: "In window",
      lastMessageAt: "2026-05-15T12:00:00Z",
    })
    await seedConv({
      fromEmail: "c@window-fixture.test",
      subject: "Just after",
      lastMessageAt: "2026-06-01T00:00:01Z",
    })

    const res = await callMailTool(mailUser.token, "search", {
      from: "@window-fixture.test",
      since: "2026-05-01T00:00:00Z",
      until: "2026-05-31T23:59:59Z",
    })
    expect(res.status, res.why).toBe(200)
    const ok = res.data as MailSearchOk
    // q1 (…04-30T23:59:59Z) and q3 (…06-01T00:00:01Z) excluded — an off-by-one
    // mis-buckets a quarter boundary.
    expect(ok.items.map((i) => i.id)).toEqual([q2])
    expect(ok.totalCount).toBe(1)
  }, 60_000)

  it("C3: `body` matches synced message text (not subject/snippet), tolerant of empty/unicode bodies", async () => {
    const b1 = await seedConv({
      fromEmail: "po@body-fixture.test",
      subject: "Re: shipment",
      snippet: "see attached",
      lastMessageAt: "2026-05-16T09:00:00Z",
      bodyText: "Please find our purchase order PO-4471 attached.",
    })
    await seedConv({
      fromEmail: "thanks@body-fixture.test",
      subject: "Re: catalogue",
      snippet: "ack",
      lastMessageAt: "2026-05-17T09:00:00Z",
      bodyText: "Thanks for the catalogue.",
    })
    // Empty body + a unicode body — neither may crash the two-step body search.
    await seedConv({
      fromEmail: "empty@body-fixture.test",
      subject: "(no body)",
      lastMessageAt: "2026-05-18T09:00:00Z",
      bodyText: "",
    })
    const u2 = await seedConv({
      fromEmail: "uni@body-fixture.test",
      subject: "Rücksendung",
      lastMessageAt: "2026-05-19T09:00:00Z",
      bodyText: "Rückläufer für Lieferschein №4471 — café",
    })

    const res = await callMailTool(mailUser.token, "search", {
      from: "@body-fixture.test",
      body: "purchase order",
    })
    expect(res.status, res.why).toBe(200)
    const ok = res.data as MailSearchOk
    // Matched in body, not subject/snippet (b1's snippet is "see attached").
    expect(ok.items.map((i) => i.id)).toEqual([b1])
    expect(ok.totalCount).toBe(1)

    // Unicode body content matches without a crash.
    const uniRes = await callMailTool(mailUser.token, "search", {
      from: "@body-fixture.test",
      body: "Lieferschein",
    })
    const uniOk = uniRes.data as MailSearchOk
    expect(uniOk.items.map((i) => i.id)).toEqual([u2])
  }, 60_000)

  it("C3: malformed `since` → typed validation error, NOT a thrown 500 and NOT a silent all-rows return", async () => {
    const res = await callMailTool(mailUser.token, "search", { since: "not-a-date" })
    // The handler returns `{ error: { code: "invalid_params" } }`; the route maps
    // that code to HTTP 400 with the structured error envelope under body.error —
    // a real, surfaced validation error (not a thrown 500, not a 200 all-rows).
    expect(res.status).toBe(400)
    expect(res.error?.code).toBe("invalid_params")
    expect((res.error?.message ?? "").toLowerCase()).toContain("since")
  }, 60_000)

  // ─── C4: honest paging — exact totalCount + correct nextCursor across the post-filter ───

  it("C4: paging returns exact totalCount + a correct nextCursor under an active post-filter", async () => {
    // Seed 5 conversations from one sender → a small, exact post-filtered set.
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(
        await seedConv({
          fromEmail: "ap@paging-fixture.test",
          subject: `Invoice ${i + 1}`,
          // Strictly descending lastMessageAt → deterministic DESC order.
          lastMessageAt: `2026-05-2${i}T09:00:00Z`,
        }),
      )
    }

    const page1 = await callMailTool(mailUser.token, "search", {
      from: "@paging-fixture.test",
      limit: 2,
    })
    const p1 = page1.data as MailSearchOk
    expect(p1.items.length).toBe(2)
    // totalCount is the WHOLE post-filtered set, not the page size.
    expect(p1.totalCount).toBe(5)
    expect(p1.nextCursor).toBeDefined()

    const page2 = await callMailTool(mailUser.token, "search", {
      from: "@paging-fixture.test",
      limit: 2,
      cursor: p1.nextCursor,
    })
    const p2 = page2.data as MailSearchOk
    expect(p2.items.length).toBe(2)
    expect(p2.totalCount).toBe(5)
    expect(p2.nextCursor).toBeDefined()

    const page3 = await callMailTool(mailUser.token, "search", {
      from: "@paging-fixture.test",
      limit: 2,
      cursor: p2.nextCursor,
    })
    const p3 = page3.data as MailSearchOk
    expect(p3.items.length).toBe(1)
    // Last page → no further cursor.
    expect(p3.nextCursor).toBeUndefined()

    // Three pages partition the 5 conversations with no overlap and full coverage.
    const seen = [...p1.items, ...p2.items, ...p3.items].map((i) => i.id)
    expect(new Set(seen).size).toBe(5)
    expect([...new Set(seen)].sort()).toEqual([...ids].sort())
  }, 60_000)

  // ════════════════════════════════════════════════════════════════════════
  //  Module D — Shopify analytics_query
  // ════════════════════════════════════════════════════════════════════════

  // ─── D1: install round-trip + a ShopifyQL aggregate over the seeded window ───

  it("D1: shopify install round-trips; analytics_query returns the correct ShopifyQL aggregate", async () => {
    // Installed once in beforeAll; the connection id is a real UUID.
    expect(/^[0-9a-f-]{36}$/.test(shopConnectionId)).toBe(true)
    await resetShopMock()
    await setShopMockMode("shopifyql")

    const res = await callShopTool(shopUser.token, "analytics_query", {
      metric: "revenue",
      period: { since: "2026-05-01", until: "2026-05-31" },
      groupBy: "market",
    })
    expect(res.status, res.why).toBe(200)
    expect(res.error).toBeUndefined()
    const data = res.data
    expect(data).toBeDefined()
    // ShopifyQL was available → authoritative source, not the bounded degrade.
    expect(data?.source).toBe("shopifyql")
    expect(data?.metric).toBe("revenue")
    expect(data?.groupBy).toBe("market")
    // The aggregate table came back through the real read path (builder → bridge
    // → mock). by-market rows total 4000.00 (2400 FR + 1600 DE).
    const table = data?.table as { rowData?: unknown[][]; columns?: Array<{ name: string }> } | null
    expect(table).not.toBeNull()
    expect(Array.isArray(table?.rowData)).toBe(true)
    expect(table?.columns?.some((c) => c.name === "total_sales")).toBe(true)
    expect(table?.rowData?.length).toBe(2)

    // Wire-level proof: the assembled query reached the mock as the `Analytics`
    // operation and carried the allowlisted ShopifyQL columns/dims — never raw
    // agent text. The market group flows as `billing_region` from the allowlist.
    const reqs = await shopMockRequests()
    const analyticsReq = reqs.find((r) => r.operation === "Analytics")
    expect(analyticsReq).toBeDefined()
    expect(analyticsReq?.body ?? "").toContain("total_sales")
    expect(analyticsReq?.body ?? "").toContain("billing_region")
    // The period dates flow as bound variables, format-validated — not concatenated.
    expect(analyticsReq?.body ?? "").toContain("2026-05-01")
  }, 90_000)

  // ─── D2: units-by-SKU maps to the allowlisted column ───

  it("D2: analytics_query units/by-sku maps to the allowlisted `net_items_sold` column", async () => {
    await resetShopMock()
    await setShopMockMode("shopifyql")

    const res = await callShopTool(shopUser.token, "analytics_query", {
      metric: "units",
      period: { since: "2026-05-01", until: "2026-05-31" },
      groupBy: "sku",
    })
    expect(res.status, res.why).toBe(200)
    expect(res.data?.source).toBe("shopifyql")
    expect(res.data?.metric).toBe("units")

    const reqs = await shopMockRequests()
    const analyticsReq = reqs.find((r) => r.operation === "Analytics")
    expect(analyticsReq).toBeDefined()
    // units → net_items_sold; sku → product_variant_sku (both from the allowlist).
    expect(analyticsReq?.body ?? "").toContain("net_items_sold")
    expect(analyticsReq?.body ?? "").toContain("product_variant_sku")
  }, 90_000)

  // ─── D3: injection attempt in a param is rejected before any query is assembled ───

  it("D3: an injection attempt in a param is rejected (no query reaches the external API)", async () => {
    await resetShopMock()
    await setShopMockMode("shopifyql")

    // Injection is rejected at TWO defense layers, both BEFORE any query is built:
    //
    //   (a) `metric` / `groupBy` are typed enums in the manifest — a non-allowlisted
    //       value (here carrying ShopifyQL-ish injection text) is rejected by the
    //       param validator with HTTP 400 before the handler even runs.
    //   (b) the period date is a free `string` in the manifest, so it reaches the
    //       handler — where the injection-hardened builder rejects it by FORMAT
    //       (`INVALID_PERIOD`). The allowlist IS the security boundary.

    const metricInj = await callShopTool(shopUser.token, "analytics_query", {
      metric: "total_sales SHOW *; DROP",
      period: { since: "2026-05-01", until: "2026-05-31" },
      groupBy: "none",
    })
    // Rejected (4xx) — the injected metric never became an enum value.
    expect(metricInj.status).toBe(400)
    expect(metricInj.error).toBeDefined()
    // The error names the allowed enum (proves the enum allowlist did the reject).
    expect((metricInj.error?.message ?? "").toLowerCase()).toContain("revenue")

    // A non-allowlisted groupBy is likewise rejected at the enum layer.
    const groupInj = await callShopTool(shopUser.token, "analytics_query", {
      metric: "revenue",
      period: { since: "2026-05-01", until: "2026-05-31" },
      groupBy: "customer_email",
    })
    expect(groupInj.status).toBe(400)
    expect(groupInj.error).toBeDefined()

    // A malformed period date (SQL-ish injection) passes the manifest (free string)
    // but is rejected by the builder's format guard → INVALID_PERIOD (HTTP 500).
    const dateInj = await callShopTool(shopUser.token, "analytics_query", {
      metric: "revenue",
      period: { since: "2026-05-01' OR '1'='1", until: "2026-05-31" },
      groupBy: "none",
    })
    expect(dateInj.error?.code).toBe("INVALID_PERIOD")

    // Crucial negative: NO `Analytics` operation ever reached the external API —
    // all three rejects short-circuited before a query was assembled.
    const reqs = await shopMockRequests()
    expect(reqs.find((r) => r.operation === "Analytics")).toBeUndefined()
  }, 90_000)

  // ─── D4: ShopifyQL-unavailable plan → bounded tally degrade, bound STATED ───

  it("D4: ShopifyQL unavailable → bounded tally over orders_search, bound stated (never fabricated total)", async () => {
    await resetShopMock()
    // Flip the plan to NOT expose ShopifyQL → parseErrors drives the degrade.
    await setShopMockMode("no_shopifyql")

    const res = await callShopTool(shopUser.token, "analytics_query", {
      metric: "revenue",
      period: { since: "2026-05-01", until: "2026-05-31" },
      groupBy: "none",
    })
    expect(res.status, res.why).toBe(200)
    const data = res.data
    // Honest degrade — never presents an authoritative total it cannot compute.
    expect(data?.source).toBe("bounded_tally")
    expect(data?.partial).toBe(true)
    // The seeded order window is 3 orders → the stated bound.
    expect(data?.boundedTo).toBe(3)
    expect(typeof data?.note).toBe("string")
    expect(String(data?.note)).toContain("bounded")

    // The degrade exercised BOTH the ShopifyQL probe (Analytics, which 'failed'
    // with parseErrors) AND the bounded fallback over orders_search — end to end.
    const reqs = await shopMockRequests()
    expect(reqs.find((r) => r.operation === "Analytics")).toBeDefined()
    expect(reqs.find((r) => r.operation === "OrdersSearch")).toBeDefined()
  }, 90_000)
})
