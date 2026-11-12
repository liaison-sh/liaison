// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Declarative provisioning (`apps[].provision`) through `config apply` and
 * `config verify`, against the `pagefx` fixture, a SANDBOXED app whose
 * provisioning handler stores the setup in its own data store.
 *
 * Discriminators: the config file schema takes the block; a block that fails the
 * app's schema is a usage error before anything is written; apply runs the app's
 * handler (a sandbox run) and a second apply changes nothing; verify reports
 * PASS on a matching setup (the app's verify handler ran), DRIFT when the file
 * moved, and no drift is written by verify.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { ConfigError } from "~/cli/config/parse"
import { validateConfig } from "~/cli/config/schema"
import { runConfigVerify } from "~/cli/config/verify"
import { applyAppProvision, planAppProvision } from "~/cli/provisioners/app-provision"
import { appsProvisioner } from "~/cli/provisioners/apps"
import { buildProvisionContext, type ProvisionContext } from "~/cli/provisioners/types"
import { sql } from "~/db"
import { PAGE_FX_APP, pageFixtureApp } from "~/modules/apps/__fixtures__/page-app/descriptor"
import { registerApps } from "~/modules/apps/runtime"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let ctx: ProvisionContext
let orgId = ""
let slug = ""

async function storedSetup(): Promise<unknown> {
  const [row] = await sql<{ data: unknown }[]>`
    SELECT data FROM kernel.app_documents
    WHERE org_id = ${orgId} AND app = ${PAGE_FX_APP} AND collection = 'setup' AND doc_id = 'current'`
  return row?.data ?? null
}

beforeAll(async () => {
  await acquireTestLock()
  slug = `cli-prov-${crypto.randomUUID().slice(0, 12)}`
  orgId = (await ensureOrg({ slug, name: "ProvisionOrg" })).orgId
  const { userId } = await ensureUser({
    orgId,
    email: `admin-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`,
    name: "Owner",
    password: "pw-prov-1!",
    role: "admin",
  })
  await registerApps([pageFixtureApp], orgId)
  ctx = buildProvisionContext({ log: () => {}, validateByok: false })
  ctx.orgId = orgId
  ctx.actor.userId = userId
  ctx.actor.scopes = ["*"]
}, 180_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("apps[].provision", () => {
  test("the config file schema takes the block (enabled apps only)", () => {
    const base = { org: { slug: "acme", name: "Acme" } }
    const ok = validateConfig({
      ...base,
      apps: [{ name: PAGE_FX_APP, enable: true, provision: { greeting: "hi" } }],
    })
    expect(ok.ok).toBe(true)
    const off = validateConfig({
      ...base,
      apps: [{ name: PAGE_FX_APP, enable: false, provision: { greeting: "hi" } }],
    })
    expect(off.ok).toBe(false)
  })

  test("a block that fails the app's schema is a usage error, nothing written", async () => {
    await expect(applyAppProvision(ctx, PAGE_FX_APP, { greeting: 3 })).rejects.toBeInstanceOf(
      ConfigError,
    )
    await expect(
      applyAppProvision(ctx, PAGE_FX_APP, { greeting: "x", extra: true }),
    ).rejects.toBeInstanceOf(ConfigError)
    expect(await storedSetup()).toBeNull()
  }, 60_000)

  test("config apply runs the app's handler; a second apply changes nothing", async () => {
    const config = {
      org: { slug, name: "ProvisionOrg" },
      apps: [
        {
          name: PAGE_FX_APP,
          enable: true,
          provision: { greeting: "Bonjour", folders: ["a", "b"] },
        },
      ],
    }
    const parsed = validateConfig(config)
    if (!parsed.ok) throw new Error("config invalid")
    // A live-org plan (agent tool path) is the handler's dry run.
    expect(await planAppProvision(ctx, PAGE_FX_APP, { greeting: "Bonjour" })).toEqual([
      `provision app '${PAGE_FX_APP}': greeting`,
    ])
    expect(await storedSetup()).toBeNull()

    const first = await appsProvisioner.apply(ctx, { actions: [] }, parsed.config)
    expect(first.changed).toEqual(
      expect.arrayContaining([
        `apps.${PAGE_FX_APP}.provision: greeting`,
        `apps.${PAGE_FX_APP}.provision: folders`,
      ]),
    )
    expect(await storedSetup()).toEqual({ greeting: "Bonjour", folders: ["a", "b"] })

    const second = await appsProvisioner.apply(ctx, { actions: [] }, parsed.config)
    expect(second.unchanged).toEqual(expect.arrayContaining([`apps.${PAGE_FX_APP}.provision`]))
    expect((second.changed ?? []).filter((c) => c.includes(".provision"))).toEqual([])
  }, 120_000)

  test("config verify: PASS through the app's verify handler, DRIFT when the file moved", async () => {
    const verify = (provision: Record<string, unknown>) => {
      const parsed = validateConfig({
        org: { slug, name: "ProvisionOrg" },
        apps: [{ name: PAGE_FX_APP, enable: true, provision }],
      })
      if (!parsed.ok) throw new Error("config invalid")
      return runConfigVerify({ config: parsed.config, log: () => {} })
    }
    const pass = await verify({ greeting: "Bonjour", folders: ["a", "b"] })
    expect(pass.exitCode).toBe(0)
    expect(pass.report.provision).toEqual([
      { app: PAGE_FX_APP, status: "PASS", identity: "greeting: Bonjour" },
    ])

    const drift = await verify({ greeting: "Hallo", folders: ["a", "b"] })
    expect(drift.exitCode).toBe(1)
    expect(drift.report.provision).toEqual([
      { app: PAGE_FX_APP, status: "DRIFT", changes: ["greeting"] },
    ])
    // Verify wrote nothing.
    expect(await storedSetup()).toEqual({ greeting: "Bonjour", folders: ["a", "b"] })
  }, 120_000)
})
