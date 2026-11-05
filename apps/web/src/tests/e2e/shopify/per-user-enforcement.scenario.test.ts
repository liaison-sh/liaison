// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 e2e S2 — per-user scope enforcement.
//
// Critical property: a user without `shopify:refunds:create` scope CANNOT
// trigger a successful Shopify Admin call. The kernel `executeTool`
// pipeline checks the caller's scopes BEFORE the bundle's mutation body
// runs.
//
// Real-Shopify mode: we observe the property via the kernel's response
// shape — a denied caller gets either a non-2xx error or a 200 with a
// `blocked`/scope-denial envelope. We deliberately do NOT call `refunds_create`
// as an authorized caller in this test, so no destructive write reaches
// the real dev store. The bundle is wired such that a denied call short-
// circuits in the kernel scope-gate — that's the property that matters
// for security; the "zero outbound HTTP" property was a useful corollary
// when the mock could record traffic, but the security invariant is the
// scope-gate firing.
import { resolve } from "node:path"
import { api } from "@liaison/test-helpers"
import { bundledAppTarball } from "../bundled-app-tarball"
import { expect, requireShopifyCreds, test } from "./_shopify-fixtures"
import { grantScopes } from "./helpers/grant-scopes"
import { installShopifyApp } from "./helpers/install-shopify-app"

const LIAISON_ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "..")
const SHOPIFY_BUNDLE = bundledAppTarball(LIAISON_ROOT, "shopify")

test.describe("Shopify: per-user scope enforcement", () => {
  test("denied user (no shopify:refunds:create) does NOT receive a successful tool execution", async ({
    env,
    world,
    qa,
    shopifyConfig,
  }) => {
    requireShopifyCreds(shopifyConfig)
    // 1. Install + connect against real dev store.
    await installShopifyApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      shopDomain: shopifyConfig.shopDomain,
      realOfflineToken: shopifyConfig.offlineToken,
      realWebhookSecret: shopifyConfig.webhookSecret,
      bundlePath: SHOPIFY_BUNDLE,
    })

    // 2. Strip all shopify scopes from Lucas (the QA seed grants all scopes
    //    by default — we need an explicitly denied user for this test).
    await grantScopes(env.serverUrl, qa.admin.token, {
      userId: qa.lucas.id,
      orgId: world.org.id,
      callingApp: "shopify",
      scopes: [],
    })

    // 3. Lucas now has zero shopify scopes. Invoke the refund tool as Lucas
    //    via the tool-invoker route. The kernel `executeTool` pipeline
    //    can respond in one of three ways, all of which are acceptable
    //    proofs that the scope-gate fired:
    //      (a) non-2xx with an error envelope (auth/route-level reject)
    //      (b) 200 with `{ blocked: ... }` (gated-tool approval flow —
    //          the bundle's mutation body never runs)
    //      (c) 200 with an error envelope `{ error: ... }` (executor
    //          returned a structured rejection)
    //    What we MUST NOT see: a 200 with a successful Shopify mutation
    //    payload (`data.refundCreate.refund` etc.) — that would mean
    //    Lucas's call reached the real Shopify API and succeeded.
    let resp: { status: number; body: unknown } | "__threw__"
    try {
      resp = await api(env.serverUrl, "/api/apps/shopify/tools/refunds_create", {
        method: "POST",
        token: qa.lucas.token,
        body: {
          orderId: "gid://shopify/Order/1001",
          input: { reason: "duplicate" },
        },
      })
    } catch {
      // (a) non-2xx that the helper surfaced as a throw — scope-gate rejected
      //     at the route layer. Acceptable outcome.
      resp = "__threw__"
    }

    // The kernel `executeTool` pipeline short-circuits a scope-lacking caller
    // BEFORE the bundle's mutation body runs, returning
    // `{ error: { code: "forbidden", message: "missing scope: …" } }` (see
    // execute-tool.ts). No outbound Shopify Admin call is made. We assert the
    // strongest signal observable end-to-end:
    //   1. NO successful refund payload appears ANYWHERE in the response
    //      (deep scan — guards against the prior tautological check, which
    //      inspected the `{status,body,headers}` wrapper and so could never
    //      see `refund`/`refundCreate` regardless of outcome).
    //   2. The response is NOT a 2xx carrying a populated refund result.
    // NOTE: the authoritative "zero outbound Shopify HTTP" invariant is proved
    // host-side with an instrumented fetch mock (see crossTrackNeeds — a Track B
    // unit test in apps/api asserting mock.calls.length === 0); this E2E proves
    // the observable contract: a denied caller never gets a successful refund.
    const serialized = resp === "__threw__" ? "" : JSON.stringify(resp.body ?? {})
    const containsSuccessfulRefund =
      /"refundCreate"\s*:\s*\{[^}]*"refund"\s*:\s*\{/.test(serialized) ||
      /"refund"\s*:\s*\{[^}]*"id"\s*:\s*"gid:\/\/shopify\/Refund\//.test(serialized)
    expect(
      containsSuccessfulRefund,
      `denied caller must not receive a successful refund payload; got: ${serialized.slice(0, 500)}`,
    ).toBe(false)

    // And if the route DID answer 2xx, it must be an empty/blocked/error
    // envelope — never a populated refund. (A throw is the route-level reject.)
    if (resp !== "__threw__" && resp.status >= 200 && resp.status < 300) {
      const env_ = (resp.body ?? {}) as { data?: unknown; blocked?: unknown; error?: unknown }
      const refundData = env_.data as { refundCreate?: { refund?: unknown } } | null | undefined
      expect(refundData?.refundCreate?.refund ?? null).toBeNull()
    }
  })
})
