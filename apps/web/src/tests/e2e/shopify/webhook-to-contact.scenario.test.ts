// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 e2e S1 — webhook → contact materialization.
//
// Validates Task A0 (`resolveContact`) + Task B12 (`customersCreateHandler`):
// a signed `customers/create` webhook delivered to the kernel webhook route
// → bundle's customers-create handler → `ctx.resolveContact` → kernel.contacts
// row keyed by `external_ids.shopify`.
//
// Smoke version of the spec scenario — does NOT exercise the install-time
// bulk backfill (that requires mocking `bulkOperationRunQuery` + serving
// a JSONL file from the mock; deferred to a future session). The single
// webhook → contact path is the load-bearing eager-sync property.
import { randomBytes } from "node:crypto"
import { resolve } from "node:path"
import { api } from "@liaison/test-helpers"
import { bundledAppTarball } from "../bundled-app-tarball"
import { expect, test } from "./_shopify-fixtures"
import { customerFixture, customerWebhookBody } from "./helpers/customer-fixture"
import { dispatchTestWebhook } from "./helpers/dispatch-shopify-webhook"
import { installShopifyApp } from "./helpers/install-shopify-app"

const LIAISON_ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "..")
const SHOPIFY_BUNDLE = bundledAppTarball(LIAISON_ROOT, "shopify")

// CI ENFORCEMENT (deep-review cluster 8): this scenario no longer self-skips
// on missing Shopify creds — the webhook is synthetic (locally signed) and the
// install runs in mock mode, so it needs no live store. It now runs in
// credential-less CI.
//
// CROSS-TRACK DEPENDENCY (Track A/B — sandbox runtime + webhook route):
// historically the bundle's `customersCreateHandler` → `ctx.resolveContact`
// round-trip deadlocked inside QuickJS (the RPC bridge's promise-resolution
// path), and the kernel webhook route discarded the handler's return so a
// transient failure surfaced as HTTP 200 (clusters 2/6). Until those land,
// this assertion can time out / find no contact. That is the WHOLE POINT of
// running it unconditionally: the breakage is now visible in CI instead of
// hidden behind a skip. It is the canonical (route → HMAC → handler → emit →
// kernel.contacts) smoke the deep review asked CI to carry.
test.describe("Shopify: webhook -> contact", () => {
  test("customers-create webhook materializes a kernel.contacts row keyed by shopify external_id", async ({
    env,
    world,
    qa,
  }) => {
    // No creds gate (deep-review cluster 8). The webhook flow is SYNTHETIC —
    // we locally sign a `customers/create` body and POST it to the kernel
    // webhook route via `dispatchTestWebhook`; the bundle's handler keys a
    // contact through `ctx.resolveContact` (a kernel bridge call), never a
    // live Shopify Admin call. So this runs in MOCK-install mode in CI with no
    // `SHOPIFY_*` creds: the test-only install route seeds a synthetic webhook
    // secret and returns it, and we sign with exactly that secret.
    const installed = await installShopifyApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: SHOPIFY_BUNDLE,
    })

    // 2. Build a customer fixture with a unique email + numeric id so the
    //    test is idempotent across runs in the same DB.
    const unique = randomBytes(4).toString("hex")
    const numericId = String(9_990_000 + Math.floor(Math.random() * 9999))
    const fixture = customerFixture({
      numericId,
      email: `paul+${unique}@example.com`,
      firstName: "Paul",
      lastName: "Doe",
    })

    // 3. Dispatch a signed customers-create webhook (HMAC-SHA256 against
    //    the H4 secret captured by the install harness).
    const result = await dispatchTestWebhook({
      serverUrl: env.serverUrl,
      orgId: world.org.id,
      appName: "shopify",
      endpointName: "customers-create",
      body: customerWebhookBody(fixture),
      secret: installed.webhookSecret,
    })
    expect(result.status).toBeGreaterThanOrEqual(200)
    expect(result.status).toBeLessThan(300)

    // 4. Poll the contacts list for the email — the bundle handler emits
    //    `ctx.resolveContact` which materializes a kernel.contacts row.
    //    NOTE: `api()` returns `{status, body, headers}` — body is the
    //    full envelope `{data, meta}`. Don't confuse `resp.data` (undef)
    //    with `resp.body.data` (the rows).
    const start = Date.now()
    let found: { email?: string; externalIds?: Record<string, string> } | null = null
    while (Date.now() - start < 15_000) {
      const resp = await api(
        env.serverUrl,
        `/api/contacts?query=${encodeURIComponent(fixture.email)}`,
        { token: qa.admin.token },
      )
      const rows = (resp.body?.data ?? []) as Array<{
        email?: string
        externalIds?: Record<string, string>
      }>
      found = rows.find((r) => r.email === fixture.email) ?? null
      if (found) break
      await new Promise((r) => setTimeout(r, 250))
    }
    expect(found, `expected a contacts row for ${fixture.email} within 15s`).toBeTruthy()
    // The webhook handler keys the contact under `externalIds.shopify` with
    // the numeric customer id from the payload (see bundle's
    // `customersCreateHandler` → `externalId: String(p.id)`). The kernel
    // list route returns the camelCase `externalIds` property name (drizzle
    // column → JS prop mapping), NOT snake-case `external_ids`.
    expect(found?.externalIds?.shopify).toBe(numericId)
  })
})
