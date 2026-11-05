// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 Task B16 — Local Shopify mock for E2E tests.
//
// Stands up a Bun HTTP server that serves canned GraphQL Admin API
// responses and webhook-event scaffolds, while recording every inbound
// request keyed by the `Authorization` header. The test harness sets that
// header to encode the requesting Liaison user (e.g. `Bearer test-user-lucas`),
// so the per-user enforcement spec can assert `requestsFromUser(lucasId)` is
// exactly zero after a denied refund attempt.
//
// Why a mock vs the real dev store: the real dev-store fixtures (used by
// `bundled-apps/shopify/scripts/verify-setup.ts`) are great for unit /
// integration runs against a known data shape, but a live store cannot
// guarantee deterministic per-test isolation, response ordering, or zero
// network egress in CI. The mock pins both.
//
// Lifecycle: start in `beforeAll`, stop in `afterAll` (see
// `_shopify-fixtures.ts`). Each scenario gets its own port via
// `deterministicPorts()`.

export type MockShopifyRecord = {
  url: string
  method: string
  authorization: string | null
  /**
   * P4 (Phase 16 E2E) — actor marker the kernel sandbox-fetch bridge injects
   * on every outbound call when `LIAISON_TEST_INJECT_ACTOR=1`. The mock
   * records it alongside `Authorization` so per-user isolation can be asserted
   * (`requestsFromUser(<userId>)`). Real Shopify never sees this header —
   * only the test-mode bridge sets it.
   */
  actor: string | null
  body: unknown
  receivedAt: number
}

export type MockShopifyOptions = {
  port: number
  /** Canned GraphQL responses keyed by operation name. */
  graphqlResponses?: Record<string, unknown>
  /** Override per-path responses (e.g. `/admin/oauth/access_token`). */
  pathResponses?: Record<string, { status: number; body: unknown }>
}

export interface MockShopifyHandle {
  url: string
  port: number
  stop: () => Promise<void>
  /** All inbound requests in arrival order. */
  allRequests: () => MockShopifyRecord[]
  /** Requests where Authorization header includes the given user marker. */
  requestsFromUser: (userMarker: string) => MockShopifyRecord[]
  /** Reset the recorded request log without restarting the server. */
  clear: () => void
  /** Update canned responses at runtime (per-scenario). */
  setGraphqlResponse: (operationName: string, body: unknown) => void
  setPathResponse: (path: string, status: number, body: unknown) => void
}

const DEFAULT_GRAPHQL_RESPONSES: Record<string, unknown> = {
  // Default `shop` query — used by connection health-check.
  shop: {
    data: {
      shop: {
        id: "gid://shopify/Shop/1",
        name: "Mock Dev Store",
        myshopifyDomain: "mock.myshopify.com",
      },
    },
    extensions: {
      cost: {
        actualQueryCost: 1,
        throttleStatus: { currentlyAvailable: 1999, maximumAvailable: 2000, restoreRate: 100 },
      },
    },
  },
  customers: {
    data: { customers: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    extensions: {
      cost: {
        actualQueryCost: 1,
        throttleStatus: { currentlyAvailable: 1999, maximumAvailable: 2000, restoreRate: 100 },
      },
    },
  },
  orders: {
    data: { orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    extensions: {
      cost: {
        actualQueryCost: 1,
        throttleStatus: { currentlyAvailable: 1999, maximumAvailable: 2000, restoreRate: 100 },
      },
    },
  },
  markets: {
    data: {
      markets: {
        nodes: [{ id: "gid://shopify/Market/1", name: "Default", primary: true, enabled: true }],
      },
    },
    extensions: {
      cost: {
        actualQueryCost: 1,
        throttleStatus: { currentlyAvailable: 1999, maximumAvailable: 2000, restoreRate: 100 },
      },
    },
  },
}

/** Detect a GraphQL `operationName` from the request body. */
function getOperationName(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null
  const op = (body as { operationName?: string; query?: string }).operationName
  if (typeof op === "string" && op.length > 0) return op
  // Fall back to scanning the query string — first `query|mutation NAME`.
  const q = (body as { query?: string }).query
  if (typeof q !== "string") return null
  const m = q.match(/(?:query|mutation)\s+(\w+)/)
  return m?.[1] ?? null
}

export async function startMockShopify(opts: MockShopifyOptions): Promise<MockShopifyHandle> {
  const records: MockShopifyRecord[] = []
  const graphqlResponses: Record<string, unknown> = {
    ...DEFAULT_GRAPHQL_RESPONSES,
    ...(opts.graphqlResponses ?? {}),
  }
  const pathResponses: Record<string, { status: number; body: unknown }> = {
    "/admin/oauth/access_token": {
      status: 200,
      body: { access_token: "mock-offline-token", scope: "read_orders,write_orders" },
    },
    ...(opts.pathResponses ?? {}),
  }

  const server = Bun.serve({
    port: opts.port,
    fetch: async (req) => {
      const url = new URL(req.url)
      const authorization = req.headers.get("authorization")
      // Header is case-insensitive at the HTTP layer; Bun lowercases names.
      const actor = req.headers.get("x-liaison-actor")
      let body: unknown = null
      try {
        if (req.method !== "GET" && req.method !== "HEAD") {
          const text = await req.text()
          if (text.length > 0) {
            try {
              body = JSON.parse(text)
            } catch {
              body = text
            }
          }
        }
      } catch {
        // ignore body-parse failures (mock should be forgiving)
      }
      records.push({
        url: req.url,
        method: req.method,
        authorization,
        actor,
        body,
        receivedAt: Date.now(),
      })

      // Path-level overrides win (oauth callback, webhooks, etc.).
      const path = url.pathname
      if (pathResponses[path]) {
        const r = pathResponses[path]
        // H2 — body MAY be a Promise (e.g. a never-resolving delay or a
        // pending-then-settle for timeout tests). Awaiting any value is a no-op.
        const body = await Promise.resolve(r.body)
        return new Response(JSON.stringify(body), {
          status: r.status,
          headers: { "content-type": "application/json" },
        })
      }

      // GraphQL Admin endpoint — `/admin/api/<version>/graphql.json`.
      if (path.includes("/graphql.json") || path.endsWith("/graphql")) {
        const opName = getOperationName(body)
        // H2 — the operation response MAY be a Promise. Awaiting it lets
        // tests inject delays (timeout sub-test for the search-merge scenario)
        // or async-computed responses while keeping the existing sync-value
        // callers ergonomic (Promise.resolve on a non-Promise is identity).
        const rawResp = (opName && graphqlResponses[opName]) ?? graphqlResponses.shop
        const resp = await Promise.resolve(rawResp)
        return new Response(JSON.stringify(resp), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }

      // Default: 404 with a body the test can inspect.
      return new Response(JSON.stringify({ mock: true, unhandled: path }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })
    },
  })

  return {
    url: `http://127.0.0.1:${opts.port}`,
    port: opts.port,
    stop: async () => {
      server.stop(true)
    },
    allRequests: () => [...records],
    // P4 — group by `X-Liaison-Actor` (the actor marker the kernel
    // sandbox-fetch bridge injects in test mode). Falls back to scanning
    // `Authorization` for the marker, which covers a small handful of
    // call sites (e.g. the OAuth-callback token exchange) that go through
    // host-side `fetch` rather than the sandbox bridge and therefore set
    // the user marker into `Authorization` directly.
    requestsFromUser: (userMarker: string) =>
      records.filter(
        (r) =>
          r.actor === userMarker ||
          (typeof r.authorization === "string" && r.authorization.includes(userMarker)),
      ),
    clear: () => {
      records.length = 0
    },
    setGraphqlResponse: (operationName: string, body: unknown) => {
      graphqlResponses[operationName] = body
    },
    setPathResponse: (path: string, status: number, body: unknown) => {
      pathResponses[path] = { status, body }
    },
  }
}
