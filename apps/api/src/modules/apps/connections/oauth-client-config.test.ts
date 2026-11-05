// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { env } from "~/lib/env"
import { oauthClientResolverRegistry, resetAppRegistries } from "~/modules/apps/app-registries"
import { resolveOAuthClientConfig } from "~/modules/apps/connections/oauth-client-config"

type ShopifyInstanceVars = { SHOPIFY_APP_CLIENT_ID?: string; SHOPIFY_APP_CLIENT_SECRET?: string }
const mutableEnv = env as ShopifyInstanceVars
const saved = {
  id: mutableEnv.SHOPIFY_APP_CLIENT_ID,
  secret: mutableEnv.SHOPIFY_APP_CLIENT_SECRET,
}

afterEach(() => {
  resetAppRegistries()
  mutableEnv.SHOPIFY_APP_CLIENT_ID = saved.id
  mutableEnv.SHOPIFY_APP_CLIENT_SECRET = saved.secret
})

describe("resolveOAuthClientConfig", () => {
  it("prefers a registered app resolver", async () => {
    const orgId = randomUUID()
    oauthClientResolverRegistry.set([orgId, "mail", "gmail"], async () => ({
      clientId: "gmail-client-id",
      clientSecret: "gmail-client-secret",
    }))

    const result = await resolveOAuthClientConfig({
      orgId,
      appName: "mail",
      connectionName: "gmail",
    })

    expect(result).toEqual({
      clientId: "gmail-client-id",
      clientSecret: "gmail-client-secret",
    })
  })

  it("an app resolver returning null leaves the one resolver in charge: no client anywhere is null", async () => {
    const orgId = randomUUID()
    oauthClientResolverRegistry.set([orgId, "test-app", "conn"], async () => null)
    expect(
      await resolveOAuthClientConfig({ orgId, appName: "test-app", connectionName: "conn" }),
    ).toBeNull()
  })

  it("with no resolver and no org client, an instance client answers, marked as the deployment's", async () => {
    mutableEnv.SHOPIFY_APP_CLIENT_ID = "instance-shopify-id"
    mutableEnv.SHOPIFY_APP_CLIENT_SECRET = "instance-shopify-secret"
    const result = await resolveOAuthClientConfig({
      orgId: randomUUID(),
      appName: "shopify",
      connectionName: "shop",
    })
    expect(result).toEqual({
      clientId: "instance-shopify-id",
      clientSecret: "instance-shopify-secret",
      source: "deployment",
    })
  })
})
