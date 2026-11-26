// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Real-DB unit test for `apps[].appSecrets` (app-held secrets a person gives):
 * plan says set / roll without the value, apply stores it encrypted, a second
 * apply with the same value is unchanged (no roll), an undeclared key or a bad
 * shape is a usage error before any write, an empty value is skipped and
 * pending, pull never writes a secret into the file and drift never tracks one.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { trackedFields } from "~/cli/config/drift"
import { ConfigError } from "~/cli/config/parse"
import { runConfigPull } from "~/cli/config/pull"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { appsProvisioner } from "~/cli/provisioners/apps"
import { buildProvisionContext, type ProvisionContext } from "~/cli/provisioners/types"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { connectionConfigRegistry, manifestRegistry } from "~/modules/apps/app-registries"
import { resetCatalogCache } from "~/modules/apps/catalog"
import { decryptConnectionConfigValue } from "~/modules/apps/connections/service"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "secretprov"
const CONN = "api"
const KEY = "webhookSigningSecret"
const FIRST = "whsec_firstSECRETvalue000001"
const SECOND = "whsec_secondSECRETvalue00002"

let emptyCatalogDir: string
beforeAll(async () => {
  await acquireTestLock()
  emptyCatalogDir = mkdtempSync(join(tmpdir(), "app-secrets-empty-catalog-"))
  process.env.LIAISON_APP_CATALOG_DIR = emptyCatalogDir
  resetCatalogCache()
})
afterAll(async () => {
  rmSync(emptyCatalogDir, { recursive: true, force: true })
  delete process.env.LIAISON_APP_CATALOG_DIR
  resetCatalogCache()
  await releaseTestLock()
})

const decl = {
  type: "credentials" as const,
  allowedDomains: ["api.demo.test"],
  appSecretConfigKeys: [KEY, `${KEY}Previous`],
  appSecretFields: [
    {
      key: KEY,
      label: "Webhook signing secret",
      pattern: "^whsec_[A-Za-z0-9]{16,}$",
      patternMessage: "A signing secret starts with whsec_.",
    },
  ],
}

/** A registered app whose connection declares one settable secret. */
async function orgWithSecretApp(): Promise<{ ctx: ProvisionContext; orgId: string; slug: string }> {
  const slug = `cli-secrets-${crypto.randomUUID().slice(0, 12)}`
  const { orgId } = await ensureOrg({ slug, name: "SecretsOrg" })
  const { userId } = await ensureUser({
    orgId,
    email: `admin-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`,
    name: "Owner",
    password: "pw-secrets-1!",
    role: "admin",
  })
  const ctx = buildProvisionContext({ log: () => {}, validateByok: false })
  ctx.orgId = orgId
  ctx.actor.userId = userId
  ctx.actor.scopes = ["*"]
  await ensureAppsForOrg(orgId)
  manifestRegistry.set([orgId, APP], { name: APP, uiBundleUrl: null })
  connectionConfigRegistry.set([orgId, APP, CONN], decl)
  await withSystemDb("app-secrets-test-row", (db) =>
    db.execute(drizzleSql`
      INSERT INTO kernel.apps (org_id, name, version, status, config)
      VALUES (${orgId}, ${APP}, '1.0.0', 'active', '{}'::jsonb)
    `),
  )
  return { ctx, orgId, slug }
}

function cleanup(orgId: string): void {
  manifestRegistry.delete([orgId, APP])
  connectionConfigRegistry.deleteByPrefix([orgId, APP])
}

async function storedConfig(orgId: string): Promise<Record<string, unknown>> {
  const rows = await withSystemDb("app-secrets-test-read", (db) =>
    db.execute(
      drizzleSql`SELECT config FROM kernel.apps WHERE org_id = ${orgId} AND name = ${APP}`,
    ),
  )
  return (extractRows<{ config: Record<string, unknown> }>(rows)[0]?.config ?? {}) as Record<
    string,
    unknown
  >
}

function withSecrets(appSecrets: Record<string, string>): ProvisioningConfig {
  return { org: { slug: "x", name: "X" }, apps: [{ name: APP, enable: true, appSecrets }] }
}

describe("apps provisioner: apps[].appSecrets", () => {
  test("plan says set, then roll, never the value; apply stores it encrypted; same value is unchanged", async () => {
    const { ctx, orgId } = await orgWithSecretApp()
    try {
      const plan1 = await appsProvisioner.plan(ctx, withSecrets({ [KEY]: FIRST }))
      expect(plan1.actions).toContain(`set app '${APP}' secret '${KEY}'`)
      expect(JSON.stringify(plan1)).not.toContain(FIRST)

      const logs: string[] = []
      ctx.log = (m) => logs.push(m)
      const r1 = await appsProvisioner.apply(ctx, { actions: [] }, withSecrets({ [KEY]: FIRST }))
      expect(r1.changed ?? []).toContain(`apps.${APP}.appSecrets.${KEY}`)
      const stored1 = await storedConfig(orgId)
      expect(typeof stored1[KEY]).toBe("string")
      expect(stored1[KEY]).not.toBe(FIRST)
      expect(
        decryptConnectionConfigValue(orgId, APP, KEY, stored1[KEY], undefined, { [CONN]: decl }),
      ).toBe(FIRST)

      // The same value again: unchanged, not rolled (no previous value appears).
      const plan2 = await appsProvisioner.plan(ctx, withSecrets({ [KEY]: FIRST }))
      expect(plan2.actions).toContain(`app '${APP}' secret '${KEY}' unchanged`)
      const r2 = await appsProvisioner.apply(ctx, { actions: [] }, withSecrets({ [KEY]: FIRST }))
      expect(r2.unchanged ?? []).toContain(`apps.${APP}.appSecrets.${KEY}`)
      expect((r2.changed ?? []).filter((k) => k.includes("appSecrets"))).toEqual([])
      const stored2 = await storedConfig(orgId)
      expect(stored2[KEY]).toBe(stored1[KEY])
      expect(stored2[`${KEY}Previous`]).toBeUndefined()

      // Another value: plan says roll; apply keeps the previous one.
      const plan3 = await appsProvisioner.plan(ctx, withSecrets({ [KEY]: SECOND }))
      expect(plan3.actions.some((a) => a.startsWith(`roll app '${APP}' secret '${KEY}'`))).toBe(
        true,
      )
      expect(JSON.stringify(plan3)).not.toContain(SECOND)
      await appsProvisioner.apply(ctx, { actions: [] }, withSecrets({ [KEY]: SECOND }))
      const stored3 = await storedConfig(orgId)
      expect(stored3[`${KEY}Previous`]).toBe(stored1[KEY])
      for (const line of logs) {
        expect(line).not.toContain(FIRST)
        expect(line).not.toContain(SECOND)
      }
    } finally {
      cleanup(orgId)
    }
  })

  test("an undeclared key or a refused shape is a usage error before any write", async () => {
    const { ctx, orgId } = await orgWithSecretApp()
    try {
      const bads: Array<Record<string, string>> = [
        { other: FIRST },
        { [KEY]: "not-a-signing-secret" },
      ]
      for (const bad of bads) {
        const config = withSecrets({ ...bad })
        await expect(appsProvisioner.plan(ctx, config)).rejects.toBeInstanceOf(ConfigError)
        await expect(appsProvisioner.apply(ctx, { actions: [] }, config)).rejects.toBeInstanceOf(
          ConfigError,
        )
      }
      const err = await appsProvisioner
        .plan(ctx, withSecrets({ [KEY]: "not-a-signing-secret" }))
        .catch((e: unknown) => e)
      expect(String(err)).not.toContain("not-a-signing-secret")
      expect(await storedConfig(orgId)).toEqual({})
    } finally {
      cleanup(orgId)
    }
  })

  test("an empty value is skipped and pending, never stored or cleared", async () => {
    const { ctx, orgId } = await orgWithSecretApp()
    try {
      await appsProvisioner.apply(ctx, { actions: [] }, withSecrets({ [KEY]: FIRST }))
      const before = await storedConfig(orgId)
      const plan = await appsProvisioner.plan(ctx, withSecrets({ [KEY]: "" }))
      expect(plan.actions).toContain(`app '${APP}' secret '${KEY}': not provided (empty), skipped`)
      const r = await appsProvisioner.apply(ctx, { actions: [] }, withSecrets({ [KEY]: "" }))
      expect(r.pending?.some((p) => p.app === APP && p.connection === CONN)).toBe(true)
      expect(await storedConfig(orgId)).toEqual(before)
    } finally {
      cleanup(orgId)
    }
  })

  test("the tool path refuses a secret before any write", async () => {
    const { ctx, orgId } = await orgWithSecretApp()
    try {
      ctx.toolPath = true
      await expect(
        appsProvisioner.apply(ctx, { actions: [] }, withSecrets({ [KEY]: FIRST })),
      ).rejects.toBeInstanceOf(ConfigError)
      expect(await storedConfig(orgId)).toEqual({})
    } finally {
      cleanup(orgId)
    }
  })

  test("pull reports set / not set and never writes the value; drift never tracks it", async () => {
    const { ctx, orgId, slug } = await orgWithSecretApp()
    const dir = mkdtempSync(join(tmpdir(), "app-secrets-pull-"))
    try {
      await appsProvisioner.apply(ctx, { actions: [] }, withSecrets({ [KEY]: FIRST }))
      const file = join(dir, "liaison.yaml")
      const text = [
        `org: { slug: ${slug}, name: SecretsOrg }`,
        "apps:",
        `  - name: ${APP}`,
        "    enable: true",
        "    appSecrets:",
        `      ${KEY}: \${SIGNING_SECRET}`,
        '      otherSecret: ""',
        "",
      ].join("\n")
      writeFileSync(file, text)
      const logs: string[] = []
      const res = await runConfigPull({
        configPath: file,
        log: (m) => logs.push(m),
        env: { SIGNING_SECRET: SECOND },
      })
      expect(res.exitCode).toBe(0)
      expect(res.text).toContain(`${KEY}: \${SIGNING_SECRET}`)
      expect(res.text).not.toContain(SECOND)
      expect(res.text).not.toContain(FIRST)
      expect(logs).toContain(
        `config pull: apps.${APP}.appSecrets.${KEY}: set on the server (a secret: left as written)`,
      )
      expect(logs).toContain(
        `config pull: apps.${APP}.appSecrets.otherSecret: not set on the server (a secret: left as written)`,
      )
      for (const line of logs) expect(line).not.toContain(FIRST)

      const paths = trackedFields({
        org: { slug, name: "S" },
        apps: [{ name: APP, enable: true, appSecrets: { [KEY]: FIRST } }],
      }).map((f) => f.path)
      expect(paths.some((p) => p.includes("appSecrets"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      cleanup(orgId)
    }
  })
})
