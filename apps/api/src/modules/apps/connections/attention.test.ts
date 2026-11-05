// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import {
  connectionConfigRegistry,
  manifestRegistry,
  resetAppRegistries,
} from "~/modules/apps/app-registries"
import {
  computeConnectionHealthAttentionItems,
  expiresSoonWithoutRenewal,
  tokenExpiryOf,
} from "~/modules/apps/connections/attention"

const ORG = "00000000-0000-4000-8000-000000920001"
const USER = "00000000-0000-4000-8000-000000920002"

const ACTOR = {
  actorType: "user" as const,
  userId: USER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

function accessToken(): string {
  return encryptSecret(
    "fake-access-token",
    env.ENCRYPTION_KEY,
    CryptoContext.connectedAccountAccessToken,
  )
}

function refreshToken(): string {
  return encryptSecret(
    "fake-refresh-token",
    env.ENCRYPTION_KEY,
    CryptoContext.connectedAccountRefreshToken,
  )
}

async function insertAccount(opts: {
  id: string
  appName: string
  connectionName: string
  identifier: string
  status: "active" | "error" | "disconnected"
  providerType?: "oauth2" | "credentials"
  hasRefreshToken?: boolean
  tokenExpiresAt?: Date | null
  statusMessage?: string | null
  updatedAt?: Date
  metadata?: Record<string, unknown> | null
}): Promise<void> {
  await sql`INSERT INTO kernel.connected_accounts
    (id, org_id, app_name, connection_name, owner_type, owner_id, provider_type,
     identifier, access_token_encrypted, refresh_token_encrypted, status, status_message,
     token_expires_at, created_by, updated_at, metadata)
    VALUES (
      ${opts.id}, ${ORG}, ${opts.appName}, ${opts.connectionName}, 'user', ${USER},
      ${opts.providerType ?? "oauth2"}, ${opts.identifier}, ${accessToken()},
      ${opts.hasRefreshToken === false ? null : refreshToken()}, ${opts.status},
      ${opts.statusMessage ?? null}, ${opts.tokenExpiresAt?.toISOString() ?? null}, ${USER},
      ${(opts.updatedAt ?? new Date()).toISOString()},
      ${opts.metadata ? JSON.stringify(opts.metadata) : null}::jsonb
    )
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      status_message = EXCLUDED.status_message,
      token_expires_at = EXCLUDED.token_expires_at,
      refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
      updated_at = EXCLUDED.updated_at,
      metadata = EXCLUDED.metadata`
}

async function computeItems() {
  return withRlsContext(ACTOR, (tx) => computeConnectionHealthAttentionItems(tx, ORG, USER))
}

describe("connections.attention (connection health)", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Connection Health Org', 'connection-health-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER}, ${ORG}, 'connhealth@attn.test', 'ConnHealth', 'active', 'hash')
      ON CONFLICT DO NOTHING`
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${ORG}`
    resetAppRegistries()
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("connections.attention.expired-no-refresh-flags-item", async () => {
    const id = "00000000-0000-4000-8000-0000009201a1"
    await insertAccount({
      id,
      appName: "social",
      connectionName: "google",
      identifier: "ops@example.com",
      status: "active",
      hasRefreshToken: false,
      tokenExpiresAt: new Date(Date.now() - 60 * 60 * 1000),
    })

    const items = await computeItems()
    const item = items.find((i) => i.entityId === id)
    expect(item).toBeDefined()
    expect(item!.app).toBe("kernel")
    expect(item!.entity).toBe("connected_account")
    expect(item!.kind).toBe("system_alert")
    expect(item!.metadata?.reason).toBe("expired_no_refresh")
    expect(item!.metadata?.appName).toBe("social")
    // Fully qualified tab type: bare "settings" is an ambiguous alias (invoicing
    // registers its own local `settings`) and resolves to no component.
    expect(item!.action).toEqual({ type: "open_entity", tabType: "kernel:settings", entityId: id })
    // The app's manifest decides where it reconnects (settings-paths.ts): an app
    // without a settings page or a connector card lands on the App store...
    expect(item!.metadata?.settingsRoute).toBe("/settings/store")
    // ...an app with one on its settings page, a connector on its Connectors card.
    manifestRegistry.set([ORG, "social"], {
      name: "social",
      uiBundleUrl: null,
      kind: "app",
      settings: { sections: [] },
    })
    const onPage = (await computeItems()).find((i) => i.entityId === id)
    expect(onPage!.metadata?.settingsRoute).toBe("/settings/apps/social")
    manifestRegistry.set([ORG, "social"], { name: "social", uiBundleUrl: null, kind: "connector" })
    const onCard = (await computeItems()).find((i) => i.entityId === id)
    expect(onCard!.metadata?.settingsRoute).toBe("/settings/connectors?open=social")
  })

  it("connections.attention.expired-with-refresh-self-heals-no-item", async () => {
    const id = "00000000-0000-4000-8000-0000009201a2"
    await insertAccount({
      id,
      appName: "social",
      connectionName: "google",
      identifier: "self-heal@example.com",
      status: "active",
      hasRefreshToken: true,
      tokenExpiresAt: new Date(Date.now() - 60 * 60 * 1000),
    })

    const items = await computeItems()
    expect(items.find((i) => i.entityId === id)).toBeUndefined()
  })

  it("connections.attention.refreshUsesAccessToken-self-heals-no-item", async () => {
    const id = "00000000-0000-4000-8000-0000009201a3"
    connectionConfigRegistry.set([ORG, "social", "instagram"], {
      type: "oauth2",
      allowedDomains: [],
      refreshUsesAccessToken: true,
    })
    await insertAccount({
      id,
      appName: "social",
      connectionName: "instagram",
      identifier: "ig-self-heal@example.com",
      status: "active",
      hasRefreshToken: false,
      tokenExpiresAt: new Date(Date.now() - 60 * 60 * 1000),
    })

    const items = await computeItems()
    expect(items.find((i) => i.entityId === id)).toBeUndefined()
  })

  it("connections.attention.status-error-flags-item", async () => {
    const id = "00000000-0000-4000-8000-0000009201a4"
    await insertAccount({
      id,
      appName: "mail",
      connectionName: "gmail",
      identifier: "broken@example.com",
      status: "error",
      statusMessage: "Authorization expired -- reconnect required",
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })

    const items = await computeItems()
    const item = items.find((i) => i.entityId === id)
    expect(item).toBeDefined()
    expect(item!.metadata?.reason).toBe("error")
    expect(item!.metadata?.statusMessage).toBe("Authorization expired -- reconnect required")
  })

  it("connections.attention.not-yet-expired-no-item", async () => {
    const id = "00000000-0000-4000-8000-0000009201a5"
    // Further out than the 14-day reminder window: nothing to say yet.
    await insertAccount({
      id,
      appName: "social",
      connectionName: "google",
      identifier: "healthy@example.com",
      status: "active",
      hasRefreshToken: false,
      tokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    })

    const items = await computeItems()
    expect(items.find((i) => i.entityId === id)).toBeUndefined()
  })

  it("connections.attention.expires-soon-without-renewal-reminds-admins", async () => {
    // Facebook Login's long-lived user token: about 60 days, no refresh token.
    // Within 14 days of its expiry the admins are reminded to reconnect.
    const soonId = "00000000-0000-4000-8000-0000009201b1"
    const renewsId = "00000000-0000-4000-8000-0000009201b2"
    const expiresAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)
    await insertAccount({
      id: soonId,
      appName: "social",
      connectionName: "facebook",
      identifier: "1000001",
      status: "active",
      hasRefreshToken: false,
      tokenExpiresAt: expiresAt,
    })
    // A token with a refresh token renews itself: no reminder.
    await insertAccount({
      id: renewsId,
      appName: "social",
      connectionName: "google",
      identifier: "renews@example.com",
      status: "active",
      tokenExpiresAt: expiresAt,
    })

    const items = await computeItems()
    const item = items.find((i) => i.entityId === soonId)
    expect(item).toBeDefined()
    expect(item!.metadata?.reason).toBe("expires_soon")
    expect(item!.metadata?.tokenExpiresAt).toBe(expiresAt.toISOString())
    expect(item!.summary).toContain(expiresAt.toISOString().slice(0, 10))
    expect(item!.summary).toContain("reconnect it before then")
    expect(item!.urgency).toBeLessThan(70)
    expect(items.find((i) => i.entityId === renewsId)).toBeUndefined()
  })

  it("connections.attention.reconnect-clears-item", async () => {
    const staleId = "00000000-0000-4000-8000-0000009201a6"
    const freshId = "00000000-0000-4000-8000-0000009201a7"
    const identifier = "reconnect@example.com"

    // Old row: errored, superseded by a fresh reconnect (mirrors handleOAuthCallback,
    // which only deactivates rows that were still `active` at reconnect time — an
    // already-`error` row is left behind as an orphan).
    await insertAccount({
      id: staleId,
      appName: "social",
      connectionName: "google",
      identifier,
      status: "error",
      statusMessage: "Authorization expired -- reconnect required",
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    })
    await insertAccount({
      id: freshId,
      appName: "social",
      connectionName: "google",
      identifier,
      status: "active",
      hasRefreshToken: true,
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      updatedAt: new Date(),
    })

    const items = await computeItems()
    expect(items.find((i) => i.entityId === staleId)).toBeUndefined()
    expect(items.find((i) => i.entityId === freshId)).toBeUndefined()
  })

  it("connections.attention.missing-scopes-flags-item", async () => {
    // A HEALTHY connection whose recorded grant lacks scopes the manifest now
    // requires — the silent-degradation case (e.g. Shopify without
    // read_all_orders hides orders older than 60 days without any error).
    const id = "00000000-0000-4000-8000-0000009201b1"
    connectionConfigRegistry.set([ORG, "shopify", "shop"], {
      type: "oauth2",
      allowedDomains: [],
      scopes: ["read_orders", "read_all_orders", "read_reports"],
    })
    await insertAccount({
      id,
      appName: "shopify",
      connectionName: "shop",
      identifier: "acme.myshopify.com",
      status: "active",
      hasRefreshToken: true,
      metadata: { grantedOAuthScopes: ["read_orders"] },
    })

    const items = await computeItems()
    const item = items.find((i) => i.entityId === id)
    expect(item).toBeDefined()
    expect(item!.metadata?.reason).toBe("missing_scopes")
    expect(item!.metadata?.missingScopes).toEqual(["read_all_orders", "read_reports"])
    expect(item!.summary).toContain("read_all_orders")
    expect(item!.summary).toContain("re-authorization")
  })

  it("connections.attention.complete-grant-no-item", async () => {
    const id = "00000000-0000-4000-8000-0000009201b2"
    connectionConfigRegistry.set([ORG, "shopify", "shop"], {
      type: "oauth2",
      allowedDomains: [],
      scopes: ["read_orders", "read_all_orders"],
    })
    await insertAccount({
      id,
      appName: "shopify",
      connectionName: "shop",
      identifier: "complete.myshopify.com",
      status: "active",
      hasRefreshToken: true,
      metadata: { grantedOAuthScopes: ["read_orders", "read_all_orders", "write_orders"] },
    })

    const items = await computeItems()
    expect(items.find((i) => i.entityId === id)).toBeUndefined()
  })

  it("connections.attention.normalized-write-grant-satisfies-read", async () => {
    // Shopify NORMALIZES the grant it reports: `write_X` implies `read_X`, so
    // the token response omits the read scope. Only genuinely absent scopes
    // (here read_all_orders, pending Shopify approval) may be flagged.
    const id = "00000000-0000-4000-8000-0000009201b4"
    connectionConfigRegistry.set([ORG, "shopify", "shop"], {
      type: "oauth2",
      allowedDomains: [],
      scopes: ["read_orders", "write_orders", "read_markets", "read_all_orders"],
    })
    await insertAccount({
      id,
      appName: "shopify",
      connectionName: "shop",
      identifier: "normalized.myshopify.com",
      status: "active",
      hasRefreshToken: true,
      metadata: { grantedOAuthScopes: ["write_orders", "read_markets"] },
    })

    const items = await computeItems()
    const item = items.find((i) => i.entityId === id)
    expect(item).toBeDefined()
    expect(item!.metadata?.missingScopes).toEqual(["read_all_orders"])
  })

  describe("protected scopes (approval-gated)", () => {
    const PROTECTED = {
      type: "oauth2" as const,
      allowedDomains: [],
      scopes: ["read_orders"],
      protectedScopes: [{ scope: "read_all_orders", setting: "fullOrderHistory" }],
    }

    afterEach(async () => {
      await sql`UPDATE kernel.organizations SET settings = settings - 'shopify' WHERE id = ${ORG}`
    })

    it("connections.attention.protected-scope-not-opted-in-flags-request", async () => {
      // The org never turned on the opt-in: the grant still lacks data (orders older than
      // 60 days), so the item says to request the scope, turn the setting on and reconnect.
      const id = "00000000-0000-4000-8000-0000009201d1"
      connectionConfigRegistry.set([ORG, "shopify", "shop"], PROTECTED)
      await insertAccount({
        id,
        appName: "shopify",
        connectionName: "shop",
        identifier: "window.myshopify.com",
        status: "active",
        hasRefreshToken: true,
        metadata: { grantedOAuthScopes: ["read_orders"] },
      })

      const items = await computeItems()
      const item = items.find((i) => i.entityId === id)
      expect(item).toBeDefined()
      expect(item!.metadata?.reason).toBe("missing_scopes")
      expect(item!.metadata?.missingScopes).toEqual(["read_all_orders"])
      expect(item!.summary).toContain("Request read_all_orders from shopify")
      expect(item!.summary).toContain("turn on fullOrderHistory and reconnect")
    })

    it("connections.attention.protected-scope-held-no-item", async () => {
      const id = "00000000-0000-4000-8000-0000009201d3"
      connectionConfigRegistry.set([ORG, "shopify", "shop"], PROTECTED)
      await insertAccount({
        id,
        appName: "shopify",
        connectionName: "shop",
        identifier: "granted.myshopify.com",
        status: "active",
        hasRefreshToken: true,
        metadata: { grantedOAuthScopes: ["read_orders", "read_all_orders"] },
      })

      const items = await computeItems()
      expect(items.find((i) => i.entityId === id)).toBeUndefined()
    })

    it("connections.attention.protected-scope-opted-in-missing-flags-item", async () => {
      const id = "00000000-0000-4000-8000-0000009201d2"
      connectionConfigRegistry.set([ORG, "shopify", "shop"], PROTECTED)
      await sql`UPDATE kernel.organizations
        SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{shopify}', '{"fullOrderHistory": true}'::jsonb)
        WHERE id = ${ORG}`
      await insertAccount({
        id,
        appName: "shopify",
        connectionName: "shop",
        identifier: "optedin.myshopify.com",
        status: "active",
        hasRefreshToken: true,
        metadata: { grantedOAuthScopes: ["read_orders"] },
      })

      const items = await computeItems()
      const item = items.find((i) => i.entityId === id)
      expect(item).toBeDefined()
      expect(item!.metadata?.missingScopes).toEqual(["read_all_orders"])
      // Opted in already: only the reconnect is left, no request to make.
      expect(item!.summary).toContain("reconnect it and approve")
      expect(item!.summary).not.toContain("Request")
    })

    it("connections.attention.app-configuration-scopes-say-release-first", async () => {
      // Shopify-managed installation grants the app's released configuration, so a
      // reconnect alone cannot add the scope: the item says to add it there first.
      const id = "00000000-0000-4000-8000-0000009201d4"
      connectionConfigRegistry.set([ORG, "shopify", "shop"], {
        ...PROTECTED,
        scopesFromAppConfiguration: true,
      })
      await sql`UPDATE kernel.organizations
        SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{shopify}', '{"fullOrderHistory": true}'::jsonb)
        WHERE id = ${ORG}`
      await insertAccount({
        id,
        appName: "shopify",
        connectionName: "shop",
        identifier: "managed.myshopify.com",
        status: "active",
        hasRefreshToken: true,
        metadata: { grantedOAuthScopes: ["read_orders"] },
      })

      const items = await computeItems()
      const item = items.find((i) => i.entityId === id)
      expect(item).toBeDefined()
      expect(item!.summary).toContain(
        "add read_all_orders to the shopify app's configuration (download the current file from Liaison's setup guide, or add it to its scopes) and release it, then reconnect it and approve",
      )
      expect(item!.summary).toContain("refuses the release")
    })
  })

  it("connections.attention.app-configuration-scope-drift-says-release-first", async () => {
    const id = "00000000-0000-4000-8000-0000009201d5"
    connectionConfigRegistry.set([ORG, "shopify", "shop"], {
      type: "oauth2",
      allowedDomains: [],
      scopes: ["read_orders", "read_locations"],
      scopesFromAppConfiguration: true,
    })
    await insertAccount({
      id,
      appName: "shopify",
      connectionName: "shop",
      identifier: "drift.myshopify.com",
      status: "active",
      hasRefreshToken: true,
      metadata: { grantedOAuthScopes: ["read_orders"] },
    })

    const items = await computeItems()
    const item = items.find((i) => i.entityId === id)
    expect(item).toBeDefined()
    expect(item!.metadata?.missingScopes).toEqual(["read_locations"])
    expect(item!.summary).toContain(
      "Data is silently limited until you add read_locations to the shopify app's configuration",
    )
    expect(item!.summary).toContain("release it, then reconnect.")
  })

  it("connections.attention.broad-calendar-grant-satisfies-narrow-scopes", async () => {
    // Calendar narrowed its request from full `calendar` to `calendar.events` +
    // `calendar.calendarlist.readonly`. A connection made before holds the broad
    // grant, which covers both: no reconnect prompt.
    const id = "00000000-0000-4000-8000-0000009201c1"
    const narrow = [
      "openid",
      "email",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    ]
    connectionConfigRegistry.set([ORG, "calendar", "google-calendar"], {
      type: "oauth2",
      allowedDomains: [],
      scopes: narrow,
    })
    await insertAccount({
      id,
      appName: "calendar",
      connectionName: "google-calendar",
      identifier: "legacy-calendar@example.com",
      status: "active",
      hasRefreshToken: true,
      metadata: {
        grantedOAuthScopes: [
          "openid",
          "https://www.googleapis.com/auth/userinfo.email",
          "https://www.googleapis.com/auth/calendar",
        ],
      },
    })
    // A grant holding only read access to calendars still lacks events write.
    const readOnlyId = "00000000-0000-4000-8000-0000009201c2"
    await insertAccount({
      id: readOnlyId,
      appName: "calendar",
      connectionName: "google-calendar",
      identifier: "readonly-calendar@example.com",
      status: "active",
      hasRefreshToken: true,
      metadata: {
        grantedOAuthScopes: [
          "openid",
          "https://www.googleapis.com/auth/userinfo.email",
          "https://www.googleapis.com/auth/calendar.readonly",
        ],
      },
    })

    const items = await computeItems()
    expect(items.find((i) => i.entityId === id)).toBeUndefined()
    const readOnly = items.find((i) => i.entityId === readOnlyId)
    expect(readOnly!.metadata?.missingScopes).toEqual([
      "https://www.googleapis.com/auth/calendar.events",
    ])
  })

  it("connections.attention.google-identity-url-grant-satisfies-aliases", async () => {
    // Google records OIDC identity grants in canonical URL form
    // (userinfo.email / userinfo.profile) even when the manifest requests the
    // short aliases (email / profile). This grant is COMPLETE — flagging it
    // was the prod false positive on the tickets support mailbox.
    const id = "00000000-0000-4000-8000-0000009201b5"
    connectionConfigRegistry.set([ORG, "tickets", "gmail"], {
      type: "oauth2",
      allowedDomains: [],
      scopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.send",
      ],
    })
    await insertAccount({
      id,
      appName: "tickets",
      connectionName: "gmail",
      identifier: "support@example.com",
      status: "active",
      hasRefreshToken: true,
      metadata: {
        grantedOAuthScopes: [
          "https://www.googleapis.com/auth/gmail.send",
          "https://www.googleapis.com/auth/gmail.modify",
          "https://www.googleapis.com/auth/userinfo.email",
          "https://www.googleapis.com/auth/userinfo.profile",
          "openid",
        ],
      },
    })

    const items = await computeItems()
    expect(items.find((i) => i.entityId === id)).toBeUndefined()
  })

  it("connections.attention.google-genuinely-missing-scope-still-flags", async () => {
    // The identity-alias equivalence must not weaken real drift detection: a
    // grant holding the identity URLs but MISSING gmail.modify flags exactly
    // that scope — and only that scope.
    const id = "00000000-0000-4000-8000-0000009201b6"
    connectionConfigRegistry.set([ORG, "tickets", "gmail"], {
      type: "oauth2",
      allowedDomains: [],
      scopes: [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.send",
      ],
    })
    await insertAccount({
      id,
      appName: "tickets",
      connectionName: "gmail",
      identifier: "drifted@example.com",
      status: "active",
      hasRefreshToken: true,
      metadata: {
        grantedOAuthScopes: [
          "https://www.googleapis.com/auth/gmail.send",
          "https://www.googleapis.com/auth/userinfo.email",
          "https://www.googleapis.com/auth/userinfo.profile",
          "openid",
        ],
      },
    })

    manifestRegistry.set([ORG, "tickets"], {
      name: "tickets",
      uiBundleUrl: null,
      kind: "app",
      settings: { sections: [] },
    })
    const items = await computeItems()
    const item = items.find((i) => i.entityId === id)
    expect(item).toBeDefined()
    expect(item!.metadata?.reason).toBe("missing_scopes")
    expect(item!.metadata?.missingScopes).toEqual(["https://www.googleapis.com/auth/gmail.modify"])
    // Tickets connections reconnect from the tickets settings page (its Inboxes section).
    expect(item!.metadata?.settingsRoute).toBe("/settings/apps/tickets")
  })

  it("connections.attention.unknown-grant-not-flagged", async () => {
    // A connection made before granted-scope tracking has NO recorded grant —
    // unverifiable, so it must NOT nag (its app Settings banner covers it).
    const id = "00000000-0000-4000-8000-0000009201b3"
    connectionConfigRegistry.set([ORG, "shopify", "shop"], {
      type: "oauth2",
      allowedDomains: [],
      scopes: ["read_orders", "read_all_orders"],
    })
    await insertAccount({
      id,
      appName: "shopify",
      connectionName: "shop",
      identifier: "legacy.myshopify.com",
      status: "active",
      hasRefreshToken: true,
      metadata: null,
    })

    const items = await computeItems()
    expect(items.find((i) => i.entityId === id)).toBeUndefined()
  })

  it("connections.attention.disconnected-account-no-item", async () => {
    const id = "00000000-0000-4000-8000-0000009201a8"
    await insertAccount({
      id,
      appName: "social",
      connectionName: "google",
      identifier: "gone@example.com",
      status: "disconnected",
      tokenExpiresAt: new Date(Date.now() - 60 * 60 * 1000),
    })

    const items = await computeItems()
    expect(items.find((i) => i.entityId === id)).toBeUndefined()
  })
})

describe("the expiry reminder reads the token's real expiry", () => {
  const DAY = 24 * 60 * 60 * 1000
  const now = Date.now()
  const base = {
    orgId: "00000000-0000-4000-8000-000000000001",
    appName: "social",
    connectionName: "facebook",
    status: "active",
    providerType: "oauth2",
    refreshTokenEncrypted: null,
  }

  it("uses the provider's answer: data access lapsing first reminds, though the token lasts", () => {
    const row = {
      ...base,
      // expires_in said 60 days, but data access ends in 5 (debug_token).
      tokenExpiresAt: new Date(now + 60 * DAY),
      metadata: {
        tokenExpiry: {
          expiresAt: new Date(now + 60 * DAY).toISOString(),
          dataAccessExpiresAt: new Date(now + 5 * DAY).toISOString(),
        },
      },
    }
    expect(expiresSoonWithoutRenewal(row, now)).toBe(true)
    expect(tokenExpiryOf(row)).toMatchObject({ source: "provider", kind: "data_access" })
  })

  it("reminds for a token stored with no expires_in when the provider gave its expiry", () => {
    const row = {
      ...base,
      tokenExpiresAt: null,
      metadata: { tokenExpiry: { expiresAt: new Date(now + 3 * DAY).toISOString() } },
    }
    expect(expiresSoonWithoutRenewal(row, now)).toBe(true)
  })

  it("does not remind when the provider says the token never lapses", () => {
    const row = {
      ...base,
      tokenExpiresAt: new Date(now + 3 * DAY),
      metadata: { tokenExpiry: { expiresAt: null, dataAccessExpiresAt: null } },
    }
    expect(expiresSoonWithoutRenewal(row, now)).toBe(false)
  })

  it("falls back to the stored expiry, only for tokens meant to last over a day", () => {
    const longLived = {
      ...base,
      tokenExpiresAt: new Date(now + 3 * DAY),
      metadata: null,
      updatedAt: new Date(now - 50 * DAY),
    }
    expect(expiresSoonWithoutRenewal(longLived, now)).toBe(true)
    expect(tokenExpiryOf(longLived)).toMatchObject({ source: "stored" })
    // A one-hour token with no refresh: no standing reminder.
    const shortLived = {
      ...base,
      tokenExpiresAt: new Date(now + 30 * 60 * 1000),
      metadata: null,
      updatedAt: new Date(now - 30 * 60 * 1000),
    }
    expect(expiresSoonWithoutRenewal(shortLived, now)).toBe(false)
  })
})
