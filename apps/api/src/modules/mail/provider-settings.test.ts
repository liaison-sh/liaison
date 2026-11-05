// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { HTTPException } from "hono/http-exception"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { ticketsAppManifest } from "~/apps/tickets/manifest-descriptor"
import { sql } from "~/db"
import { resetAppRegistries, setDeclaredEmits } from "~/modules/apps/app-registries"
import type { AppDescriptor } from "~/modules/apps/runtime"
import { registerApps } from "~/modules/apps/runtime"
import {
  listMailProviders,
  resolveEnabledMailProviderOAuthClient,
  setMailProviderEnabled,
} from "~/modules/mail/provider-settings"
import { saveGoogleIntegrationConfig } from "~/modules/settings/google-integration"

const TEST_ORG_ID = "00000000-0000-0000-0000-000000000251"

const configuredEnv = {
  GMAIL_OAUTH_CLIENT_ID: "gmail-client-id",
  GMAIL_OAUTH_CLIENT_SECRET: "gmail-client-secret",
}

const unconfiguredEnv = {
  GMAIL_OAUTH_CLIENT_ID: undefined,
  GMAIL_OAUTH_CLIENT_SECRET: undefined,
}

describe("mail provider settings", () => {
  // Register apps ONCE idempotently. The tests below only mutate
  // kernel.organizations.settings, never the app schemas. registerApps is
  // protected by the runtime's own pg_advisory_xact_lock, so concurrent
  // calls from other files cannot race on the schema DDL. We don't DROP
  // the schema here — letting it persist between files prevents the
  // race window with other suites' reads. Schema state is "any registered
  // version of mail+tickets", which is what every test expects.
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${TEST_ORG_ID}, 'Mail Provider Org', 'mail-provider-test')
      ON CONFLICT (id) DO NOTHING`
    resetAppRegistries()
    setDeclaredEmits(
      "*",
      "kernel",
      new Set(["connected_account:create", "connected_account:disconnect"]),
    )
    await registerApps(
      [mailAppManifest as unknown as AppDescriptor, ticketsAppManifest as unknown as AppDescriptor],
      TEST_ORG_ID,
    )
  }, 60_000)

  beforeEach(async () => {
    await sql`UPDATE kernel.organizations SET settings = '{}'::jsonb WHERE id = ${TEST_ORG_ID}`
  })

  afterAll(async () => {
    // Don't DROP — leaving registered schemas idempotent for the next test
    // file. Only delete this test's row from kernel.apps and the org.
    await sql`DELETE FROM kernel.apps WHERE org_id = ${TEST_ORG_ID} AND name IN ('mail', 'tickets')`
    await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG_ID}`
  })

  it("lists provider policy with deployment Google integration", async () => {
    // No org-level Google config, but deployment env is configured
    const providers = await listMailProviders(TEST_ORG_ID, configuredEnv)

    expect(providers).toEqual([
      {
        id: "gmail",
        label: "Gmail",
        kind: "oauth2",
        enabled: false,
        integrationConfigured: true,
        configurationSource: "deployment",
        supportedOwnerTypes: ["user", "org"],
      },
    ])
  })

  it("reports Mail Gmail policy plus shared Google integration status", async () => {
    await setMailProviderEnabled(TEST_ORG_ID, "gmail", true, configuredEnv)

    // No org-level Google config, no deployment env
    const providers = await listMailProviders(TEST_ORG_ID, unconfiguredEnv)

    expect(providers).toEqual([
      {
        id: "gmail",
        label: "Gmail",
        kind: "oauth2",
        enabled: true,
        integrationConfigured: false,
        configurationSource: null,
        supportedOwnerTypes: ["user", "org"],
      },
    ])
  })

  it("resolves Gmail credentials from shared Google integration before deployment defaults", async () => {
    await saveGoogleIntegrationConfig(TEST_ORG_ID, {
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
    })
    await setMailProviderEnabled(TEST_ORG_ID, "gmail", true, configuredEnv)

    await expect(
      resolveEnabledMailProviderOAuthClient(TEST_ORG_ID, "gmail", configuredEnv),
    ).resolves.toEqual({
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
      source: "org",
    })
  })

  it("preserves existing mail config when toggling provider enablement", async () => {
    await sql`
      UPDATE kernel.apps
      SET config = ${JSON.stringify({ gmailPushSecret: "push-secret" })}::jsonb
      WHERE org_id = ${TEST_ORG_ID} AND name = 'mail'
    `

    const updated = await setMailProviderEnabled(TEST_ORG_ID, "gmail", true, configuredEnv)

    expect(updated).toEqual({
      gmailPushSecret: "push-secret",
      providers: {
        gmail: {
          enabled: true,
        },
      },
    })

    const [appRow] = (await sql`
      SELECT config
      FROM kernel.apps
      WHERE org_id = ${TEST_ORG_ID} AND name = 'mail'
    `) as Array<{ config: Record<string, unknown> | null }>

    expect(appRow.config).toEqual(updated)
  })

  it("throws a typed error when Google integration is not configured", async () => {
    await setMailProviderEnabled(TEST_ORG_ID, "gmail", true, configuredEnv)

    await expect(
      resolveEnabledMailProviderOAuthClient(TEST_ORG_ID, "gmail", unconfiguredEnv),
    ).rejects.toBeInstanceOf(HTTPException)

    await expect(
      resolveEnabledMailProviderOAuthClient(TEST_ORG_ID, "gmail", unconfiguredEnv),
    ).rejects.toMatchObject({ status: 503 })
  })
})
