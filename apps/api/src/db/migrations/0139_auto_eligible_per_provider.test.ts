// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0139 gives Anthropic an auto model, so auto mode works for an org whose only
// AI key is Anthropic. Runs the migration file itself against the global
// catalog as an existing instance has it (Haiku not auto-eligible), then:
//   - an Anthropic-only org's auto model is Haiku;
//   - a Google org's auto model is unchanged (flash-lite stays the cheapest);
//   - an operator who turns the flag off is respected: auto mode skips the
//     model, and the boot seed does not turn it back on;
//   - a fresh catalog gets the same flag from MODEL_PRICING_SEED;
//   - running the migration on a catalog without the row changes nothing.
// The catalog is global: every row this file touches is restored afterwards.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MODEL_PRICING_SEED } from "@liaison/shared"
import { and, sql as drizzleSql, eq, inArray } from "drizzle-orm"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { modelPricing } from "~/db/schema/kernel"
import { seedModelPricing } from "~/infra/seed-model-pricing"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { byokEncryptionKey } from "~/lib/env"
import { selectAutoModelForOrg } from "~/modules/agent/credits/credit-meter"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MIGRATION = join(import.meta.dir, "0139_auto_eligible_per_provider.sql")
const HAIKU = { provider: "anthropic", modelId: "claude-haiku-4-5" }
const FLASH_LITE = { provider: "google", modelId: "gemini-flash-lite-latest" }
const PROVIDER_ENV = [
  "LIAISON_ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "MISTRAL_API_KEY",
]

async function runMigration(): Promise<void> {
  const statements = readFileSync(MIGRATION, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.replace(/--.*$/gm, "").trim() !== "")
  await withSystemDb("0139-test-run", async (tx) => {
    for (const statement of statements) await tx.execute(drizzleSql.raw(statement))
  })
}

type CatalogRow = typeof modelPricing.$inferSelect
let savedRows: CatalogRow[] = []
/** Catalog rows that existed before this file seeded the catalog. */
let preexisting = new Set<string>()
let savedEnv: Record<string, string | undefined> = {}
const orgIds: string[] = []

async function catalogRow(m: { provider: string; modelId: string }) {
  const [row] = await withSystemDb("0139-test-read", (tx) =>
    tx
      .select()
      .from(modelPricing)
      .where(and(eq(modelPricing.provider, m.provider), eq(modelPricing.modelId, m.modelId))),
  )
  return row
}

async function setEligible(m: { provider: string; modelId: string }, value: boolean) {
  await withSystemDb("0139-test-flag", (tx) =>
    tx
      .update(modelPricing)
      .set({ autoEligible: value })
      .where(and(eq(modelPricing.provider, m.provider), eq(modelPricing.modelId, m.modelId))),
  )
}

/** An org whose only AI key is a BYOK key for `provider`. */
async function orgWithKey(provider: string): Promise<string> {
  const id = randomUUID()
  orgIds.push(id)
  const settings = JSON.stringify({
    providerKeys: {
      [provider]: {
        encrypted: encryptSecret("sk-test", byokEncryptionKey, CryptoContext.byokApiKey),
        maskedHint: "test",
        validatedAt: "2026-10-13T00:00:00.000Z",
      },
    },
  })
  await sql`INSERT INTO kernel.organizations (id, name, slug, settings)
    VALUES (${id}, 'Auto0139', ${`auto-0139-${id.slice(0, 8)}`}, ${settings}::jsonb)`
  return id
}

describe("0139 auto-eligible model per provider", () => {
  beforeAll(async () => {
    await acquireTestLock()
    savedEnv = Object.fromEntries(PROVIDER_ENV.map((k) => [k, process.env[k]]))
    for (const k of PROVIDER_ENV) delete process.env[k]
    preexisting = new Set(
      (
        await withSystemDb("0139-test-pre", (tx) =>
          tx.select({ id: modelPricing.id }).from(modelPricing),
        )
      ).map((r) => r.id),
    )
    // The catalog as an instance seeded before this release has it.
    await seedModelPricing()
    savedRows = [...(await withSystemDb("0139-test-save", (tx) => tx.select().from(modelPricing)))]
    await setEligible(HAIKU, false)
    await setEligible(FLASH_LITE, true)
  })

  afterAll(async () => {
    for (const row of savedRows) await setEligible(row, row.autoEligible)
    // Leave the global catalog as it was: drop what this file's seeding added.
    const added = savedRows.filter((r) => !preexisting.has(r.id)).map((r) => r.id)
    if (added.length > 0) {
      await withSystemDb("0139-test-cleanup", (tx) =>
        tx.delete(modelPricing).where(inArray(modelPricing.id, added)),
      )
    }
    for (const id of orgIds) await sql`DELETE FROM kernel.organizations WHERE id = ${id}`
    for (const k of PROVIDER_ENV) {
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]
      else delete process.env[k]
    }
    await releaseTestLock()
  })

  it("an Anthropic-only org gets the Anthropic auto model once the migration ran", async () => {
    const org = await orgWithKey("anthropic")
    // Before: nothing auto-eligible for its provider, so the global pick.
    expect((await selectAutoModelForOrg(org, "t"))?.provider).not.toBe("anthropic")
    await runMigration()
    expect((await catalogRow(HAIKU))?.autoEligible).toBe(true)
    expect(await selectAutoModelForOrg(org, "t")).toEqual(HAIKU)
  })

  it("a Google org keeps its auto model", async () => {
    const org = await orgWithKey("google")
    await runMigration()
    expect(await selectAutoModelForOrg(org, "t")).toEqual(FLASH_LITE)
  })

  it("an operator who turns the flag off is respected, also by the boot seed", async () => {
    await runMigration()
    await setEligible(HAIKU, false)
    await seedModelPricing()
    expect((await catalogRow(HAIKU))?.autoEligible).toBe(false)
    const org = await orgWithKey("anthropic")
    expect((await selectAutoModelForOrg(org, "t"))?.modelId).not.toBe(HAIKU.modelId)
  })

  it("a fresh catalog gets the flag from the seed, and the migration needs no row", async () => {
    expect(MODEL_PRICING_SEED.find((m) => m.modelId === HAIKU.modelId)?.autoEligible).toBe(true)
    // Only Haiku changes: every other seed flag is what it was.
    const flagged = MODEL_PRICING_SEED.filter((m) => m.autoEligible).map((m) => m.modelId)
    expect(flagged.sort()).toEqual(
      [
        "claude-haiku-4-5",
        "gemini-flash-latest",
        "gemini-flash-lite-latest",
        "gpt-5.4-nano",
        "mistral-small-latest",
      ].sort(),
    )
    const before = await withSystemDb("0139-test-count", (tx) =>
      tx.select({ id: modelPricing.modelId }).from(modelPricing),
    )
    await withSystemDb("0139-test-hide", (tx) =>
      tx
        .update(modelPricing)
        .set({ modelId: "claude-haiku-4-5-hidden" })
        .where(eq(modelPricing.modelId, HAIKU.modelId)),
    )
    try {
      await runMigration()
    } finally {
      await withSystemDb("0139-test-unhide", (tx) =>
        tx
          .update(modelPricing)
          .set({ modelId: HAIKU.modelId })
          .where(eq(modelPricing.modelId, "claude-haiku-4-5-hidden")),
      )
    }
    const after = await withSystemDb("0139-test-count", (tx) =>
      tx.select({ id: modelPricing.modelId }).from(modelPricing),
    )
    expect(after.length).toBe(before.length)
  })
})
