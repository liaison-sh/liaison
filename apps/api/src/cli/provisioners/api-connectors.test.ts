// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `apiConnectors` config section against the real database: first apply
// writes the adapter and the credentials, the second is a no-op, a changed
// adapter or credential is rewritten alone, invalid input is exit 2 before any
// write, empty credentials are pending, and config verify probes the
// connection's first parameterless read.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import crypto from "node:crypto"
import * as dnsPromises from "node:dns/promises"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { invalidateConnectionCaches } from "~/apps/api-connector/cache"
import { getAdapterRow, resolveConnectionCredentials } from "~/apps/api-connector/store"
import { ConfigError } from "~/cli/config/parse"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { runConfigVerify } from "~/cli/config/verify"
import { adminProvisioner } from "~/cli/provisioners/admin"
import { apiConnectorsProvisioner } from "~/cli/provisioners/api-connectors"
import { buildProvisionContext, type ProvisionContext } from "~/cli/provisioners/types"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import { quoteIdent } from "~/lib/sql-utils"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ADAPTER_YAML = (version: string) =>
  [
    "id: crm",
    "name: Fixture CRM",
    `version: "${version}"`,
    "baseUrl: https://crm.example.com",
    "auth: { type: bearer }",
    "operations:",
    "  - name: list_companies",
    "    description: Companies.",
    "    kind: read",
    "    method: GET",
    "    path: /companies",
    "    params: { type: object, properties: {} }",
    "    items: /data",
    "    fields: [id, name]",
  ].join("\n")

let dir = ""
let seen: string[] = []
let lookupSpy: ReturnType<typeof spyOn>

beforeAll(async () => {
  await acquireTestLock()
  dir = mkdtempSync(join(tmpdir(), "api-connectors-cfg-"))
  writeFileSync(join(dir, "crm.adapter.yaml"), ADAPTER_YAML("1"))
})

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true })
  await releaseTestLock()
})

beforeEach(() => {
  seen = []
  lookupSpy = spyOn(dnsPromises, "lookup").mockImplementation((async () => [
    { address: "93.184.216.34", family: 4 },
  ]) as never)
  OutboundFetchTestAccess.setFetch((async (
    input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    seen.push(String(input))
    return new Response(JSON.stringify({ data: [{ id: "c1", name: "Acme" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch)
})

afterEach(() => {
  OutboundFetchTestAccess.setFetch(null)
  lookupSpy.mockRestore()
})

async function freshCtx(): Promise<{ ctx: ProvisionContext; orgId: string; slug: string }> {
  const slug = `cli-apiconn-${crypto.randomUUID().slice(0, 12)}`
  const { orgId } = await ensureOrg({ slug, name: "ApiConnectorsTestOrg" })
  const { userId } = await ensureUser({
    orgId,
    email: `owner-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`,
    name: "Robin Owner",
    role: "admin",
    allowPasswordless: true,
  })
  const ctx = buildProvisionContext({ log: () => {}, validateByok: false, configDir: dir })
  ctx.orgId = orgId
  ctx.actor.userId = userId
  ctx.actor.scopes = ["*"]
  return { ctx, orgId, slug }
}

function config(
  list: NonNullable<ProvisioningConfig["apiConnectors"]>,
  slug = "x",
): ProvisioningConfig {
  return { org: { slug, name: "X" }, apiConnectors: list }
}

async function adapterUpdater(orgId: string): Promise<string | null | undefined> {
  const [stored] = extractRows<{ updated_by: string | null }>(
    await withPrivilegedDb(orgId, "test-read-adapter-updater", (tx) =>
      tx.execute(sql`
        SELECT updated_by FROM ${sql.raw(`${quoteIdent(schemaRef("app_api_connector"))}.adapters`)}
        WHERE org_id = ${orgId}::uuid AND identifier = 'crm'`),
    ),
  )
  return stored?.updated_by
}

async function applyOnce(ctx: ProvisionContext, cfg: ProvisioningConfig) {
  const plan = await apiConnectorsProvisioner.plan(ctx, cfg)
  return apiConnectorsProvisioner.apply(ctx, plan, cfg)
}

describe("apiConnectors provisioner", () => {
  test("writes the adapter and the credentials; a second apply is a no-op", async () => {
    const { ctx, orgId } = await freshCtx()
    const cfg = config([
      { identifier: "crm", adapter: "crm.adapter.yaml", credentials: { token: "tok-1" } },
    ])
    const first = await applyOnce(ctx, cfg)
    expect(first.changed).toEqual(["apiConnectors.crm.adapter", "apiConnectors.crm.credentials"])
    expect((await getAdapterRow(orgId, "crm"))?.adapter.name).toBe("Fixture CRM")
    expect((await resolveConnectionCredentials(orgId, ctx.actor.userId, "crm"))?.values).toEqual({
      token: "tok-1",
    })
    const second = await applyOnce(ctx, cfg)
    expect(second.changed).toBeUndefined()
    expect(second.unchanged).toEqual(["apiConnectors.crm.adapter", "apiConnectors.crm.credentials"])
    await invalidateConnectionCaches(orgId, "crm")
  })

  test("a config with no admin section acts as the org's admin (the documented recipe)", async () => {
    const { ctx, orgId } = await freshCtx()
    const adminId = ctx.actor.userId
    // A fresh CLI context, as `liaison config apply` builds it: no acting person yet.
    const cli = buildProvisionContext({ log: () => {}, validateByok: false, configDir: dir })
    cli.orgId = orgId
    const cfg = config([
      { identifier: "crm", adapter: "crm.adapter.yaml", credentials: { token: "tok-1" } },
    ])
    await adminProvisioner.apply(cli, { actions: [] }, cfg)
    expect(cli.actor.userId).toBe(adminId)
    const first = await applyOnce(cli, cfg)
    expect(first.changed).toEqual(["apiConnectors.crm.adapter", "apiConnectors.crm.credentials"])
    expect(await adapterUpdater(orgId)).toBe(adminId)
    expect((await resolveConnectionCredentials(orgId, adminId, "crm"))?.values).toEqual({
      token: "tok-1",
    })
    await invalidateConnectionCaches(orgId, "crm")
  })

  test("an org with no active admin: the adapter is saved with no updater, credentials are refused clearly", async () => {
    const slug = `cli-apiconn-noadmin-${crypto.randomUUID().slice(0, 8)}`
    const { orgId } = await ensureOrg({ slug, name: "NoAdminOrg" })
    const cli = buildProvisionContext({ log: () => {}, validateByok: false, configDir: dir })
    cli.orgId = orgId
    await adminProvisioner.apply(cli, { actions: [] }, config([]))
    expect(cli.actor.userId).toBe("")
    const adapterOnly = await applyOnce(
      cli,
      config([{ identifier: "crm", adapter: "crm.adapter.yaml" }]),
    )
    expect(adapterOnly.changed).toEqual(["apiConnectors.crm.adapter"])
    expect(await adapterUpdater(orgId)).toBeNull()
    await expect(
      applyOnce(
        cli,
        config([{ identifier: "crm", adapter: "crm.adapter.yaml", credentials: { token: "t" } }]),
      ),
    ).rejects.toThrow(/needs a person to connect it: add an `admin` section/)
    await invalidateConnectionCaches(orgId, "crm")
  })

  test("rewrites only what changed (an inline adapter, then a credential)", async () => {
    const { ctx } = await freshCtx()
    await applyOnce(
      ctx,
      config([{ identifier: "crm", adapter: "crm.adapter.yaml", credentials: { token: "tok-1" } }]),
    )
    const inline = {
      id: "crm",
      name: "Fixture CRM v2",
      version: "2",
      baseUrl: "https://crm.example.com",
      auth: { type: "bearer" },
      operations: [
        {
          name: "list_companies",
          description: "Companies.",
          kind: "read",
          method: "GET",
          path: "/companies",
          params: { type: "object", properties: {} },
          fields: ["id"],
        },
      ],
    }
    const a = await applyOnce(
      ctx,
      config([{ identifier: "crm", adapter: inline, credentials: { token: "tok-1" } }]),
    )
    expect(a.changed).toEqual(["apiConnectors.crm.adapter"])
    const b = await applyOnce(
      ctx,
      config([{ identifier: "crm", adapter: inline, credentials: { token: "tok-2" } }]),
    )
    expect(b.changed).toEqual(["apiConnectors.crm.credentials"])
  })

  test("a moved API host deletes the stored credential; apply enters the config's again (P2-SK1)", async () => {
    const { ctx, orgId } = await freshCtx()
    await applyOnce(
      ctx,
      config([{ identifier: "crm", adapter: "crm.adapter.yaml", credentials: { token: "tok-1" } }]),
    )
    const moved = {
      id: "crm",
      name: "Fixture CRM",
      version: "1",
      baseUrl: "https://crm-eu.example.com",
      auth: { type: "bearer" },
      operations: [
        {
          name: "list_companies",
          description: "Companies.",
          kind: "read",
          method: "GET",
          path: "/companies",
          params: { type: "object", properties: {} },
          fields: ["id"],
        },
      ],
    }
    const plan = await apiConnectorsProvisioner.plan(
      ctx,
      config([{ identifier: "crm", adapter: moved }]),
    )
    expect(plan.actions.join("\n")).toContain("stored credentials are deleted")
    // The plan and the log name the setting that moved (field names, never values).
    expect(plan.actions.join("\n")).toMatch(/deleted, baseUrl(, [a-z]+)* changed\)/i)
    const logs: string[] = []
    ctx.log = (line: string) => logs.push(line)
    // The config still carries the credential: it is entered again for the new host.
    const reentered = await applyOnce(
      ctx,
      config([{ identifier: "crm", adapter: moved, credentials: { token: "tok-1" } }]),
    )
    expect(reentered.changed).toEqual([
      "apiConnectors.crm.adapter",
      "apiConnectors.crm.credentials",
    ])
    expect(logs.join("\n")).toMatch(
      /api connection 'crm': adapter updated \(baseUrl(, [a-z]+)* changed\)/i,
    )
    expect(logs.join("\n")).not.toContain("tok-1")
    expect((await resolveConnectionCredentials(orgId, ctx.actor.userId, "crm"))?.values).toEqual({
      token: "tok-1",
    })
    // Without credentials in the config, the moved connection is left pending.
    const pending = await applyOnce(
      ctx,
      config([{ identifier: "crm", adapter: "crm.adapter.yaml" }]),
    )
    expect(pending.pending?.map((p) => p.kind)).toEqual(["credentials"])
    expect(await resolveConnectionCredentials(orgId, ctx.actor.userId, "crm")).toBeNull()
    await invalidateConnectionCaches(orgId, "crm")
  })

  test("an invalid adapter is exit 2 with the issue path, before any write", async () => {
    const { ctx, orgId } = await freshCtx()
    writeFileSync(join(dir, "bad.adapter.yaml"), ADAPTER_YAML("1").replace("https://", "http://"))
    const cfg = config([{ identifier: "bad", adapter: "bad.adapter.yaml" }])
    const err = await apiConnectorsProvisioner.plan(ctx, cfg).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConfigError)
    expect(String((err as ConfigError).message)).toContain("baseUrl")
    expect(await getAdapterRow(orgId, "bad")).toBeNull()
  })

  test("refuses an adapter path outside the config directory", async () => {
    const { ctx } = await freshCtx()
    for (const adapter of ["../outside.yaml", "/etc/passwd"]) {
      await expect(
        apiConnectorsProvisioner.plan(ctx, config([{ identifier: "crm", adapter }])),
      ).rejects.toBeInstanceOf(ConfigError)
    }
  })

  test("refuses credential fields the auth type does not take", async () => {
    const { ctx } = await freshCtx()
    const cfg = config([
      { identifier: "crm", adapter: "crm.adapter.yaml", credentials: { apiKey: "k" } },
    ])
    await expect(apiConnectorsProvisioner.plan(ctx, cfg)).rejects.toBeInstanceOf(ConfigError)
  })

  test("empty credentials are reported pending, the adapter still lands", async () => {
    const { ctx, orgId } = await freshCtx()
    const r = await applyOnce(
      ctx,
      config([{ identifier: "crm", adapter: "crm.adapter.yaml", credentials: { token: "" } }]),
    )
    expect(r.pending).toEqual([
      {
        kind: "credentials",
        app: "api-connector",
        connection: "api",
        identifier: "crm",
        action: "set the bearer credentials of 'crm' (token)",
      },
    ])
    expect(await getAdapterRow(orgId, "crm")).not.toBeNull()
  })

  test("config verify probes the first parameterless read operation", async () => {
    const { ctx, orgId, slug } = await freshCtx()
    await applyOnce(
      ctx,
      config([{ identifier: "crm", adapter: "crm.adapter.yaml", credentials: { token: "tok-v" } }]),
    )
    await invalidateConnectionCaches(orgId, "crm")
    const { exitCode, report } = await runConfigVerify({
      config: config([{ identifier: "crm", adapter: "crm.adapter.yaml" }], slug),
      log: () => {},
    })
    expect(exitCode).toBe(0)
    expect(report.results).toEqual([
      {
        app: "api-connector",
        connection: "crm",
        status: "PASS",
        identity: "list_companies: HTTP 200, 1 item(s)",
      },
    ])
    expect(seen).toEqual(["https://crm.example.com/companies"])
  })
})
