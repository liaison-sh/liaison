// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 E2E harness H3 — Playwright client for the test-only
// `setUserScopes` route. The route lives at
// `/api/_test/grants/set-user-scopes` (NODE_ENV-gated).
//
// Usage:
//   await grantScopes(env, qa.admin.token, {
//     userId: tobias.id,
//     orgId: world.org.id,
//     callingApp: "shopify",
//     scopes: ["shopify:refunds:write"],
//   })
//
// Pass `scopes: []` to revoke everything within the calling app's
// namespace for the given user (the SDK semantics are diff-against-set).
import { api } from "@liaison/test-helpers"

export interface GrantScopesOptions {
  userId: string
  orgId: string
  callingApp: string
  scopes: string[]
}

export async function grantScopes(
  serverUrl: string,
  token: string,
  opts: GrantScopesOptions,
): Promise<void> {
  const resp = await api(serverUrl, "/api/_test/grants/set-user-scopes", {
    method: "POST",
    token,
    body: opts,
  })
  if (resp.status !== 200) {
    throw new Error(`grantScopes: route returned ${resp.status}: ${JSON.stringify(resp.body)}`)
  }
}
