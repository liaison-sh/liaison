// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { sql } from "~/db/connection"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { CryptoContext, decryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import {
  getOrgAppSettings,
  getOrgKernelSettings,
  getUserAppSettings,
  setOrgAppSettings,
} from "~/lib/settings"

const orgId = "00000000-0000-0000-0000-000000a55001"
const userId = "00000000-0000-0000-0000-000000a55002"

const schema = z.object({
  resend: z.object({
    apiKey: z.string().describe("encrypted").nullable(),
    fromAddress: z.string().nullable(),
  }),
  greeting: z.string(),
})

const userSchema = z.object({ signature: z.object({ text: z.string().nullable() }) })
const userDefaults = { signature: { text: null } }

beforeAll(async () => {
  await withSystemDb("settings-test-setup", async (tx) => {
    await tx.execute(
      drizzleSql`INSERT INTO kernel.organizations (id, name, slug, settings) VALUES (${orgId}, 'S', ${`settings-test-${orgId.slice(-12)}`}, '{}'::jsonb) ON CONFLICT DO NOTHING`,
    )
    await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, status, password_hash, name, auth_version, permission_version)
      VALUES (${userId}, ${orgId}, 's@t.com', 'active', 'h', 'S', 1, 1) ON CONFLICT DO NOTHING
    `)
  })
})

afterAll(async () => {
  await withSystemDb("settings-test-teardown", async (tx) => {
    await tx.execute(drizzleSql`DELETE FROM kernel.users WHERE id = ${userId}`)
    await tx.execute(drizzleSql`DELETE FROM kernel.organizations WHERE id = ${orgId}`)
  })
})

describe("settings accessor", () => {
  it("set then get round-trips an encrypted field via encryptSecret", async () => {
    await withPrivilegedDb(orgId, "test", async (tx) => {
      await setOrgAppSettings(tx, orgId, "tickets", schema, {
        resend: { apiKey: "secret-api-key", fromAddress: "x@y.z" },
        greeting: "hi",
      })
    })
    const stored = (
      await sql`SELECT settings->'tickets'->'resend'->>'apiKey' AS v FROM kernel.organizations WHERE id = ${orgId}`
    )[0] as { v: string }
    expect(stored.v).not.toBe("secret-api-key")
    expect(decryptSecret(stored.v, env.ENCRYPTION_KEY, CryptoContext.orgSettingsSecret)).toBe(
      "secret-api-key",
    )
    const result = await withPrivilegedDb(orgId, "test", (tx) =>
      getOrgAppSettings(tx, orgId, "tickets", schema),
    )
    expect(result.resend.apiKey).toBe("secret-api-key")
    expect(result.greeting).toBe("hi")
  })

  it("user settings lazy-seed on first read", async () => {
    const result = await withPrivilegedDb(orgId, "test", (tx) =>
      getUserAppSettings(tx, userId, "tickets", userSchema, userDefaults),
    )
    expect(result).toEqual(userDefaults)
    const persisted = (
      await sql`SELECT settings->'tickets' AS v FROM kernel.users WHERE id = ${userId}`
    )[0] as { v: unknown }
    expect(persisted.v).toEqual(userDefaults)
  })

  it("kernel settings reads top-level keys (no app namespace)", async () => {
    await withSystemDb("settings-test-kernel", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE kernel.organizations
        SET settings = settings || '{"integrations":{"foo":"bar"}}'::jsonb
        WHERE id = ${orgId}
      `)
    })
    const kernelSchema = z
      .object({
        integrations: z.object({ foo: z.string() }).optional(),
      })
      .passthrough()
    const result = await withPrivilegedDb(orgId, "test", (tx) =>
      getOrgKernelSettings(tx, orgId, kernelSchema),
    )
    expect(result.integrations?.foo).toBe("bar")
  })
})
