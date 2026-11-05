// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WRITES TO `settings.ai.models` (A11). Every write — the admin routes and the
// daily price job — reads the org row FOR UPDATE, changes the models object in
// memory and writes it back as ONE sub-path `jsonb_set`, so two admins (or an
// admin and the job) never overwrite each other's change and nothing else in
// the settings blob is touched.
import { type AiModelsSettings, aiModelsSettingsSchema } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { quoteIdent } from "~/lib/sql-utils"

function orgsTable() {
  return drizzleSql.raw(`${quoteIdent(schemaRef("kernel"))}.${quoteIdent("organizations")}`)
}

export type AiModelsMutation<T> = (
  models: AiModelsSettings,
  tx: PrivilegedDb,
) => Promise<{ next?: AiModelsSettings; result: T }>

/** The models object of a raw settings value (absent or unreadable reads as empty). */
function readModels(raw: unknown): AiModelsSettings {
  const settings = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw
  const value = (settings as { ai?: { models?: unknown } } | null)?.ai?.models
  if (value === undefined || value === null) return {}
  return aiModelsSettingsSchema.parse(value)
}

/**
 * Run `fn` on the org's `ai.models` under a row lock, and write back `next`
 * when it returns one. The mutation must not call the network: it holds the
 * org row.
 */
export async function mutateAiModels<T>(
  orgId: string,
  reason: string,
  fn: AiModelsMutation<T>,
): Promise<T> {
  return withPrivilegedDb(orgId, reason, async (tx) => {
    const rows = extractRows<{ settings: unknown }>(
      await tx.execute(
        drizzleSql`SELECT settings FROM ${orgsTable()} WHERE id = ${orgId}::uuid FOR UPDATE`,
      ),
    )
    const current = readModels(rows[0]?.settings ?? null)
    const { next, result } = await fn(current, tx)
    if (next) {
      const value = JSON.stringify(aiModelsSettingsSchema.parse(next))
      await tx.execute(drizzleSql`
        UPDATE ${orgsTable()}
        SET settings = jsonb_set(
              jsonb_set(
                COALESCE(settings, '{}'::jsonb),
                '{ai}',
                COALESCE(settings->'ai', '{}'::jsonb),
                true
              ),
              '{ai,models}',
              ${value}::jsonb,
              true
            ),
            updated_at = now()
        WHERE id = ${orgId}::uuid
      `)
    }
    return result
  })
}

/**
 * Set or remove one `providerKeys` entry inside a mutation's transaction (a
 * custom server's key lives beside the provider keys).
 */
export async function setProviderKeyEntry(
  tx: PrivilegedDb,
  orgId: string,
  name: string,
  entry: Record<string, string> | null,
): Promise<void> {
  if (entry === null) {
    await tx.execute(drizzleSql`
      UPDATE ${orgsTable()}
      SET settings = settings #- ARRAY['providerKeys', ${name}::text], updated_at = now()
      WHERE id = ${orgId}::uuid
    `)
    return
  }
  await tx.execute(drizzleSql`
    UPDATE ${orgsTable()}
    SET settings = jsonb_set(
          jsonb_set(
            COALESCE(settings, '{}'::jsonb),
            '{providerKeys}',
            COALESCE(settings->'providerKeys', '{}'::jsonb),
            true
          ),
          ARRAY['providerKeys', ${name}::text],
          ${JSON.stringify(entry)}::jsonb,
          true
        ),
        updated_at = now()
    WHERE id = ${orgId}::uuid
  `)
}
