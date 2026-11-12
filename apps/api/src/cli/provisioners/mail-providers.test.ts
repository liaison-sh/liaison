// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Real-DB test for `apps[]` `name: mail` + `providers` (the per-org mail
 * provider switch, `mail-providers.ts`), driven through the apps provisioner
 * the way `config apply` runs it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { and, eq } from "drizzle-orm"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { appsProvisioner } from "~/cli/provisioners/apps"
import type { MailProviderResult } from "~/cli/provisioners/mail-providers"
import { buildProvisionContext, type ProvisionContext } from "~/cli/provisioners/types"
import { withPrivilegedDb } from "~/db/privileged"
import { apps } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { resetCatalogCache } from "~/modules/apps/catalog"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { loadMailAppConfig } from "~/modules/mail/provider-settings"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { saveGoogleIntegrationConfig } from "~/modules/settings/google-integration"
import { type AppInstallSnapshot, snapshotAppInstalls } from "~/tests/helpers/app-install-state"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// Apps this file installs are instance-wide rows: put them back after it.
let installs: AppInstallSnapshot | null = null

type GmailEnv = { GMAIL_OAUTH_CLIENT_ID?: string; GMAIL_OAUTH_CLIENT_SECRET?: string }
const mutableEnv = env as GmailEnv
let savedEnv: GmailEnv
let emptyCatalogDir: string

beforeAll(async () => {
  await acquireTestLock()
  installs = await snapshotAppInstalls()
  // No deployment-level Gmail client: availability then depends only on the
  // org's own Google client, which each test controls.
  savedEnv = {
    GMAIL_OAUTH_CLIENT_ID: mutableEnv.GMAIL_OAUTH_CLIENT_ID,
    GMAIL_OAUTH_CLIENT_SECRET: mutableEnv.GMAIL_OAUTH_CLIENT_SECRET,
  }
  mutableEnv.GMAIL_OAUTH_CLIENT_ID = undefined
  mutableEnv.GMAIL_OAUTH_CLIENT_SECRET = undefined
  emptyCatalogDir = mkdtempSync(join(tmpdir(), "mail-providers-empty-catalog-"))
  process.env.LIAISON_APP_CATALOG_DIR = emptyCatalogDir
  resetCatalogCache()
})

afterAll(async () => {
  mutableEnv.GMAIL_OAUTH_CLIENT_ID = savedEnv.GMAIL_OAUTH_CLIENT_ID
  mutableEnv.GMAIL_OAUTH_CLIENT_SECRET = savedEnv.GMAIL_OAUTH_CLIENT_SECRET
  rmSync(emptyCatalogDir, { recursive: true, force: true })
  delete process.env.LIAISON_APP_CATALOG_DIR
  resetCatalogCache()
  await installs?.restore()
  await releaseTestLock()
})

async function freshOrg(opts: { googleClient: boolean }): Promise<{
  ctx: ProvisionContext
  orgId: string
  slug: string
}> {
  const slug = `cli-mailprov-${crypto.randomUUID().slice(0, 12)}`
  const { orgId } = await ensureOrg({ slug, name: "MailProvidersOrg" })
  const { userId } = await ensureUser({
    orgId,
    email: `admin-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`,
    name: "Owner",
    password: "pw-mailprov-1!",
    role: "admin",
  })
  // What the org provisioner does post-commit: registers the org's apps, which
  // creates its `kernel.apps` mail row.
  await ensureAppsForOrg(orgId)
  if (opts.googleClient) {
    await saveGoogleIntegrationConfig(orgId, { clientId: "cid-1234567", clientSecret: "csecret" })
  }
  const ctx = buildProvisionContext({ log: () => {}, validateByok: false })
  ctx.orgId = orgId
  ctx.actor.userId = userId
  ctx.actor.scopes = ["*"]
  return { ctx, orgId, slug }
}

function mailConfig(slug: string, providers?: { gmail: { enabled: boolean } }): ProvisioningConfig {
  return {
    org: { slug, name: "MailProvidersOrg" },
    apps: [{ name: "mail", enable: true, ...(providers ? { providers } : {}) }],
  }
}

async function setMailAppConfig(orgId: string, config: Record<string, unknown>): Promise<void> {
  await withPrivilegedDb(orgId, "test-mail-config-seed", (tx) =>
    tx
      .update(apps)
      .set({ config })
      .where(and(eq(apps.orgId, orgId), eq(apps.name, "mail"))),
  )
}

function mailProviders(result: {
  section?: unknown
}): Record<string, MailProviderResult> | undefined {
  const section = result.section as {
    apps: Array<{ name: string; providers?: Record<string, MailProviderResult> }>
  }
  return section.apps.find((a) => a.name === "mail")?.providers
}

const GMAIL_KEY = "apps.mail.providers.gmail.enabled"

describe("apps[] mail providers", () => {
  test("enable: plan says enable, apply switches gmail on, second apply is unchanged", async () => {
    const { ctx, orgId, slug } = await freshOrg({ googleClient: true })
    const config = mailConfig(slug, { gmail: { enabled: true } })

    const plan1 = await appsProvisioner.plan(ctx, config)
    expect(plan1.actions).toContain("enable mail provider 'gmail'")

    const r1 = await appsProvisioner.apply(ctx, plan1, config)
    expect(r1.changed ?? []).toContain(GMAIL_KEY)
    expect(r1.unchanged ?? []).not.toContain(GMAIL_KEY)
    expect(mailProviders(r1)).toEqual({ gmail: { enabled: true, available: true } })
    expect((await loadMailAppConfig(orgId)).providers?.gmail?.enabled).toBe(true)
    expect((r1.pending ?? []).find((p) => p.app === "mail")).toBeUndefined()

    // Idempotent: the plan and the second apply both report unchanged.
    const plan2 = await appsProvisioner.plan(ctx, config)
    expect(plan2.actions).toContain("mail provider 'gmail' unchanged (enabled)")
    const r2 = await appsProvisioner.apply(ctx, plan2, config)
    expect(r2.unchanged ?? []).toContain(GMAIL_KEY)
    expect(r2.changed ?? []).not.toContain(GMAIL_KEY)
    expect((await loadMailAppConfig(orgId)).providers?.gmail?.enabled).toBe(true)
  })

  test("disable: an enabled gmail is switched off", async () => {
    const { ctx, orgId, slug } = await freshOrg({ googleClient: true })
    await setMailAppConfig(orgId, { providers: { gmail: { enabled: true } } })
    const config = mailConfig(slug, { gmail: { enabled: false } })

    const plan = await appsProvisioner.plan(ctx, config)
    expect(plan.actions).toContain("disable mail provider 'gmail'")

    const r = await appsProvisioner.apply(ctx, plan, config)
    expect(r.changed ?? []).toContain(GMAIL_KEY)
    expect(mailProviders(r)).toEqual({ gmail: { enabled: false, available: false } })
    expect((await loadMailAppConfig(orgId)).providers?.gmail?.enabled).toBe(false)
  })

  test("every other mail app config key is preserved", async () => {
    const { ctx, orgId, slug } = await freshOrg({ googleClient: true })
    await setMailAppConfig(orgId, {
      gmailPushSecret: "push-secret-kept",
      inboxAccess: { mode: "members" },
      providers: { gmail: { enabled: false, note: "kept" } },
    })

    await appsProvisioner.apply(
      ctx,
      { actions: [] },
      mailConfig(slug, { gmail: { enabled: true } }),
    )

    const stored: Record<string, unknown> = await loadMailAppConfig(orgId)
    expect(stored).toEqual({
      gmailPushSecret: "push-secret-kept",
      inboxAccess: { mode: "members" },
      providers: { gmail: { enabled: true, note: "kept" } },
    })
  })

  test("omitting providers changes nothing", async () => {
    const { ctx, orgId, slug } = await freshOrg({ googleClient: true })
    const seeded = { gmailPushSecret: "s", providers: { gmail: { enabled: true } } }
    await setMailAppConfig(orgId, seeded)

    const plan = await appsProvisioner.plan(ctx, mailConfig(slug))
    expect(plan.actions.some((a) => a.includes("mail provider"))).toBe(false)
    const r = await appsProvisioner.apply(ctx, plan, mailConfig(slug))

    expect(await loadMailAppConfig(orgId)).toEqual(seeded)
    expect([...(r.changed ?? []), ...(r.unchanged ?? [])]).not.toContain(GMAIL_KEY)
    expect(mailProviders(r)).toBeUndefined()
  })

  test("no Google credentials: the switch is recorded, reported unavailable + pending", async () => {
    const { ctx, orgId, slug } = await freshOrg({ googleClient: false })
    const config = mailConfig(slug, { gmail: { enabled: true } })

    // Planned the way the driver plans: before the org provisioner sets ctx.orgId,
    // resolving the (existing) org by slug.
    const planCtx = buildProvisionContext({ log: () => {}, validateByok: false })
    const plan = await appsProvisioner.plan(planCtx, config)
    expect(plan.actions).toContain(
      "enable mail provider 'gmail' (Google credentials are not set up yet: gmail stays " +
        "unavailable until they are)",
    )

    const logs: string[] = []
    ctx.log = (m) => logs.push(m)
    const r = await appsProvisioner.apply(ctx, plan, config)

    expect(r.changed ?? []).toContain(GMAIL_KEY)
    expect((await loadMailAppConfig(orgId)).providers?.gmail?.enabled).toBe(true)
    expect(mailProviders(r)).toEqual({ gmail: { enabled: true, available: false } })
    const pending = (r.pending ?? []).find((p) => p.app === "mail" && p.connection === "gmail")
    expect(pending?.kind).toBe("credentials")
    expect(pending?.action).toContain("liaison guide google --email <addr>")
    expect(pending?.message).toBe(
      "Gmail is enabled. Google credentials are not set up yet: Gmail stays unavailable until " +
        "they are.",
    )
    expect(logs.some((l) => l.includes("Gmail stays unavailable"))).toBe(true)
  })
})
