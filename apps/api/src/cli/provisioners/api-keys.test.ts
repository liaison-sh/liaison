// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Real-DB unit test for the API keys provisioner (Task 9).
 *
 * Asserts ONLY the raw provisioner result `{label, created, keyPrefix, key?}`
 * (correction #14 — the echo policy / `env.LIAISON_API_KEY` belongs to Task 13).
 *
 * Coverage:
 * - SUPPLIED upsert idempotency: same key twice → exactly ONE row by
 *   (org_id, key_hash), `created:true` then `created:false`; plaintext never in
 *   the result;
 * - GENERATED emitted-once: omit key → minted, plaintext present, keyPrefix len
 *   8; re-run by (org_id, label) → `unchanged`, NO plaintext, count==1;
 * - `created_by` == the admin id;
 * - allowedOrigins `[]` stored as an empty jsonb array;
 * - non-user actor rejected by `apiKeysCreate`'s guard (confirms it is respected).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto, { createHash } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { runAdminOp } from "~/apps/tickets/admin"
import { ticketsRel } from "~/apps/tickets/schema-refs"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { apiKeysProvisioner } from "~/cli/provisioners/api-keys"
import { buildProvisionContext, type ProvisionContext } from "~/cli/provisioners/types"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

/** Seed an org + an admin user and return a context wired with that actor. */
async function freshOrgWithAdmin(): Promise<{
  ctx: ProvisionContext
  orgId: string
  adminId: string
}> {
  const { orgId } = await ensureOrg({
    slug: `cli-apikeys-${crypto.randomUUID().slice(0, 12)}`,
    name: "ApiKeysTestOrg",
  })
  const { userId } = await ensureUser({
    orgId,
    email: `admin-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`,
    name: "Owner",
    password: "pw-apikeys-1!",
    role: "admin",
  })
  const ctx = buildProvisionContext({ log: () => {}, validateByok: false })
  ctx.orgId = orgId
  ctx.actor.userId = userId
  ctx.actor.scopes = ["*"]
  return { ctx, orgId, adminId: userId }
}

interface KeyEntry {
  label: string
  created: boolean
  keyPrefix: string
  key?: string
}

function findKey(result: { section?: unknown }, label: string): KeyEntry {
  const section = result.section as { keys: KeyEntry[] }
  const entry = section.keys.find((k) => k.label === label)
  if (!entry) throw new Error(`no result entry for label '${label}'`)
  return entry
}

async function countByLabel(orgId: string, label: string): Promise<number> {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      SELECT id FROM ${ticketsRel("api_keys")} WHERE org_id = ${orgId} AND label = ${label}
    `),
  )
  return extractRows(rows).length
}

describe("api keys provisioner (Task 9)", () => {
  test("SUPPLIED upsert idempotency: same key twice → one row, created true then false; no plaintext", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    const label = `supplied-${crypto.randomUUID().slice(0, 8)}`
    const suppliedKey = `lia_${crypto.randomUUID().replaceAll("-", "")}`
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      apiKeys: [{ label, key: suppliedKey }],
    }

    const first = await apiKeysProvisioner.apply(ctx, { actions: [] }, config)
    const e1 = findKey(first, label)
    expect(e1.created).toBe(true)
    expect(e1.key).toBeUndefined() // supplied → never echoed
    expect(e1.keyPrefix).toBe(suppliedKey.slice(0, 8))

    const second = await apiKeysProvisioner.apply(ctx, { actions: [] }, config)
    const e2 = findKey(second, label)
    expect(e2.created).toBe(false)
    expect(e2.key).toBeUndefined()

    // Exactly one row by (org_id, key_hash).
    const keyHash = createHash("sha256").update(suppliedKey).digest("hex")
    const rows = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT id FROM ${ticketsRel("api_keys")}
        WHERE org_id = ${orgId} AND key_hash = ${keyHash}
      `),
    )
    expect(extractRows(rows).length).toBe(1)
  })

  test("GENERATED emitted-once: minted with plaintext + 8-char prefix; re-run unchanged, count==1", async () => {
    const { ctx, orgId } = await freshOrgWithAdmin()
    const label = `gen-${crypto.randomUUID().slice(0, 8)}`
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      apiKeys: [{ label }],
    }

    const first = await apiKeysProvisioner.apply(ctx, { actions: [] }, config)
    const e1 = findKey(first, label)
    expect(e1.created).toBe(true)
    expect(typeof e1.key).toBe("string")
    expect((e1.key ?? "").length).toBeGreaterThan(8)
    expect(e1.keyPrefix.length).toBe(8)
    expect(e1.keyPrefix).toBe((e1.key ?? "").slice(0, 8))

    const second = await apiKeysProvisioner.apply(ctx, { actions: [] }, config)
    const e2 = findKey(second, label)
    expect(e2.created).toBe(false)
    expect(e2.key).toBeUndefined() // cannot re-emit plaintext
    expect(second.unchanged).toContain(`apiKeys.${label}`)

    expect(await countByLabel(orgId, label)).toBe(1)
  })

  test("created_by == the admin id; allowedOrigins [] stored as empty jsonb array", async () => {
    const { ctx, orgId, adminId } = await freshOrgWithAdmin()
    const label = `meta-${crypto.randomUUID().slice(0, 8)}`
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      apiKeys: [{ label, allowedOrigins: [] }],
    }
    await apiKeysProvisioner.apply(ctx, { actions: [] }, config)

    const rows = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT created_by, allowed_origins FROM ${ticketsRel("api_keys")}
        WHERE org_id = ${orgId} AND label = ${label}
      `),
    )
    const row = extractRows<{ created_by: string; allowed_origins: unknown }>(rows)[0]
    expect(row.created_by).toBe(adminId)
    expect(
      Array.isArray(row.allowed_origins)
        ? row.allowed_origins
        : JSON.parse(String(row.allowed_origins)),
    ).toEqual([])
  })

  test("non-user actor is rejected by apiKeysCreate's guard", async () => {
    const { orgId } = await freshOrgWithAdmin()
    const result = await withPrivilegedDb(orgId, "t", (tx) =>
      runAdminOp(
        tx,
        orgId,
        "apiKeysCreate",
        { label: `sys-${crypto.randomUUID().slice(0, 8)}` },
        { actorType: "system", userId: crypto.randomUUID() },
      ),
    )
    // Guard returns the error variant rather than minting a key.
    expect("error" in (result as object)).toBe(true)
    expect((result as { error: { message: string } }).error.message).toBe(
      "API keys can only be created by a signed in user, not by an agent or MCP session",
    )
  })

  test("a non user actor with a valid label gets the actor error, not label required", async () => {
    const { orgId } = await freshOrgWithAdmin()
    const result = await withPrivilegedDb(orgId, "t", (tx) =>
      runAdminOp(
        tx,
        orgId,
        "apiKeysCreate",
        { label: `mcp-${crypto.randomUUID().slice(0, 8)}` },
        { actorType: "mcp", userId: crypto.randomUUID() },
      ),
    )
    expect("error" in (result as object)).toBe(true)
    const err = (result as { error: { code: string; message: string } }).error
    expect(err.code).toBe("forbidden")
    expect(err.message).not.toBe("label required")
  })
})
