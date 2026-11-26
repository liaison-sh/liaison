// SPDX-License-Identifier: FSL-1.1-ALv2
// A person saves the Stripe webhook signing secret (the settings page, a secret request card and
// `config apply` all end in `setAppSecret`): only a key the manifest lets a person set, only a
// value of the right shape, stored encrypted, a replaced one rolled; and a delivery signed with
// the saved secret verifies. A secret request of kind app_secret points at that key and sees the
// save.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHmac, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { __privileged_db__ as db, sql } from "~/db/connection"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import {
  AppSecretError,
  appSecretStatus,
  setAppSecret,
} from "~/modules/apps/connections/app-secrets"
import { decryptConnectionConfigValue } from "~/modules/apps/connections/service"
import { newStoredSecret, readStoredSecretState } from "~/modules/secret-requests/stored"
import {
  checkTargetRegistered,
  parseSecretTarget,
  requestSecretParams,
  targetScope,
} from "~/modules/secret-requests/targets"
import { buildVerifyBridge } from "~/modules/webhooks/verify-bridge"
import { seedOrgRow } from "~/seed/factories/org/rows"
import { insertSql } from "~/seed/factories/org/test-rows"
import {
  type StripeVerifyBridge,
  verifyStripeDelivery,
} from "../../../../../bundled-apps/stripe/src/verify"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const manifest = JSON.parse(
  readFileSync(join(REPO_ROOT, "bundled-apps", "stripe", "app.manifest.json"), "utf8"),
) as { connections: { stripe: Record<string, unknown> } }

const FIRST = "whsec_firstSavedSecret0123456789"
const SECOND = "whsec_secondSavedSecret012345678"
const BODY = JSON.stringify({ id: "evt_SAVED1", type: "customer.updated" })

let orgId: string

async function storedConfig(): Promise<Record<string, unknown>> {
  const [row] =
    await sql`SELECT config FROM kernel.apps WHERE org_id = ${orgId} AND name = 'stripe'`
  return (typeof row?.config === "string" ? JSON.parse(row.config) : (row?.config ?? {})) as Record<
    string,
    unknown
  >
}

async function deliver(secret: string, atMs = Date.now()) {
  const config = await storedConfig()
  const bridge = buildVerifyBridge({
    readConfig: async (key) =>
      decryptConnectionConfigValue(
        orgId,
        "stripe",
        key,
        config[key] ?? null,
        undefined,
        manifest.connections as never,
      ),
    secretConfigKeys: ["webhookSigningSecret", "webhookSigningSecretPrevious"],
    workersRun: true,
  }) as unknown as StripeVerifyBridge
  const t = Math.floor(atMs / 1000)
  const sig = createHmac("sha256", secret).update(`${t}.${BODY}`).digest("hex")
  return verifyStripeDelivery(
    { headers: { "stripe-signature": `t=${t},v1=${sig}` }, body: BODY, method: "POST", query: {} },
    bridge,
    atMs,
  )
}

const save = (key: string, value: unknown) =>
  setAppSecret({ orgId, appName: "stripe", connectionName: "stripe", key, value })

beforeAll(async () => {
  orgId = await seedOrgRow({ id: randomUUID(), name: "Hook Org", slug: `hook-${randomUUID()}` })
  await db.execute(
    drizzleSql.raw(
      insertSql("kernel.apps", {
        id: randomUUID(),
        org_id: orgId,
        name: "stripe",
        version: "1.0.0",
        status: "active",
      }),
    ),
  )
  connectionConfigRegistry.set([orgId, "stripe", "stripe"], manifest.connections.stripe as never)
})

afterAll(async () => {
  connectionConfigRegistry.delete([orgId, "stripe", "stripe"])
  await sql`DELETE FROM kernel.apps WHERE org_id = ${orgId}`
})

describe("a person saves the webhook signing secret", () => {
  it("nothing set: the status says so, and a delivery cannot verify", async () => {
    expect(await appSecretStatus(orgId, "stripe", "stripe")).toEqual([
      expect.objectContaining({ key: "webhookSigningSecret", set: false, previousUntil: null }),
    ])
    expect(await deliver(FIRST)).toEqual({ ok: false, reason: "missing_secret" })
  })

  it("refuses a value of the wrong shape, and writes nothing", async () => {
    for (const bad of ["", "rk_live_abcdefghijklmnopqrstu", "whsec_short", 42]) {
      const err = await save("webhookSigningSecret", bad).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(AppSecretError)
      expect((err as AppSecretError).code).toBe("invalid_value")
      if (typeof bad === "string" && bad) expect((err as Error).message).not.toContain(bad)
    }
    expect((await storedConfig()).webhookSigningSecret).toBeUndefined()
  })

  it("refuses a key that is not a person's to set: the previous secret, an undeclared key", async () => {
    for (const key of ["webhookSigningSecretPrevious", "webhookSigningSecretPreviousUntil", "x"]) {
      const err = await save(key, FIRST).catch((e: unknown) => e)
      expect((err as AppSecretError).code).toBe("not_settable")
    }
    const missing = await setAppSecret({
      orgId,
      appName: "stripe",
      connectionName: "nope",
      key: "webhookSigningSecret",
      value: FIRST,
    }).catch((e: unknown) => e)
    expect((missing as AppSecretError).code).toBe("not_found")
  })

  it("stores the first secret encrypted, not rolled, and a delivery signed with it verifies", async () => {
    expect(await save("webhookSigningSecret", `  ${FIRST}\n`)).toEqual({
      key: "webhookSigningSecret",
      rolled: false,
      unchanged: false,
    })
    const config = await storedConfig()
    expect(typeof config.webhookSigningSecret).toBe("string")
    expect(config.webhookSigningSecret).not.toContain(FIRST)
    expect(config.webhookSigningSecretPrevious).toBeUndefined()
    expect(await deliver(FIRST)).toMatchObject({ ok: true, replayKey: "evt_SAVED1" })
    expect(await appSecretStatus(orgId, "stripe", "stripe")).toEqual([
      expect.objectContaining({ set: true, previousUntil: null }),
    ])
  })

  it("a new secret rolls the old one: both verify, the status says until when", async () => {
    expect(await save("webhookSigningSecret", SECOND)).toEqual({
      key: "webhookSigningSecret",
      rolled: true,
      unchanged: false,
    })
    expect(await deliver(SECOND)).toMatchObject({ ok: true })
    expect(await deliver(FIRST)).toMatchObject({ ok: true })
    const [status] = await appSecretStatus(orgId, "stripe", "stripe")
    expect(status?.set).toBe(true)
    const until = Date.parse(String(status?.previousUntil))
    expect(until).toBeGreaterThan(Date.now() + 23 * 3_600_000)
    expect(JSON.stringify(status)).not.toContain(FIRST)
    expect(JSON.stringify(status)).not.toContain(SECOND)
  })
})

describe("saving the same secret again", () => {
  it("writes nothing, so the previous secret still verifies until its deadline", async () => {
    const before = await storedConfig()
    expect(await save("webhookSigningSecret", SECOND)).toEqual({
      key: "webhookSigningSecret",
      rolled: false,
      unchanged: true,
    })
    const after = await storedConfig()
    expect(after.webhookSigningSecret).toBe(before.webhookSigningSecret)
    expect(after.webhookSigningSecretPrevious).toBe(before.webhookSigningSecretPrevious)
    expect(await deliver(FIRST)).toMatchObject({ ok: true })
  })
})

describe("a secret request for the webhook signing secret", () => {
  const params = (field: string) =>
    requestSecretParams.parse({
      kind: "app_secret",
      target: { app: "stripe", connection: "stripe", field },
    })

  it("names the key a person sets, and only that one, behind the connection's admin scope", () => {
    const parsed = parseSecretTarget(params("webhookSigningSecret"), orgId)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(checkTargetRegistered(orgId, parsed.target)).toBeNull()
    expect(targetScope(orgId, parsed.target)).toBe("stripe:admin:connection")
    const previous = parseSecretTarget(params("webhookSigningSecretPrevious"), orgId)
    if (!previous.ok) throw new Error("parses")
    expect(checkTargetRegistered(orgId, previous.target)).toContain("webhookSigningSecret")
  })

  it("sees a save made after it was asked, and not before", async () => {
    const parsed = parseSecretTarget(params("webhookSigningSecret"), orgId)
    if (!parsed.ok) throw new Error("parses")
    const before = await readStoredSecretState(orgId, parsed.target, randomUUID())
    expect(newStoredSecret(before, before.fingerprints)).toBeNull()
    await save("webhookSigningSecret", FIRST)
    const after = await readStoredSecretState(orgId, parsed.target, randomUUID())
    expect(newStoredSecret(after, before.fingerprints)).toEqual({
      fingerprint: expect.any(String),
      hint: null,
    })
  })
})
