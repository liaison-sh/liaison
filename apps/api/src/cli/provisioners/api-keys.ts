// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * API keys provisioner (Task 9). Ensures org-scoped `app_tickets.api_keys` rows
 * so a deployment can authenticate the Hub's ticket-create webhook.
 *
 * Two modes per `apiKeys[]` entry:
 * - SUPPLIED `key`: the operator already holds the secret. Hash it
 *   (`hashToken` from lib/crypto), take the 8-char prefix, and `INSERT … ON CONFLICT
 *   (org_id, key_hash) DO NOTHING` (the real unique constraint). `created`
 *   reflects whether a row was actually inserted. The plaintext is NEVER
 *   re-emitted (hash-only) — the report carries only `{label, created, keyPrefix}`.
 * - GENERATED (`key` omitted): SELECT a non-revoked row by `(org_id, label)`;
 *   if present this run is idempotent (`created:false`, no re-mint, plaintext
 *   unrecoverable). Otherwise mint via `runAdminOp(…, 'apiKeysCreate', …)` (the
 *   ONLY callable path — `apiKeysCreate` is module-private) and emit the
 *   plaintext ONCE in the result so the report builder can surface it.
 *
 * Handle: `withPrivilegedDb` (org-scoped) via the `ctx.priv` seam. The admin is
 * ensured first (runtime order org→admin→…→apiKeys) so `ctx.actor.userId` is a
 * real user id for the `created_by` column / the user-actor guard.
 */
import { sql as drizzleSql } from "drizzle-orm"
import { runAdminOp } from "~/apps/tickets/admin"
import { ticketsRel } from "~/apps/tickets/schema-refs"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { readAdminErrorMessage, readMintedKey } from "~/cli/lib/admin-op"
import type { Provisioner, ProvisionPlan, ProvisionResult } from "~/cli/provisioners/types"
import { extractRows } from "~/db"
import { hashToken } from "~/lib/crypto"

/**
 * Per-entry result. `key` is present ONLY for a freshly generated key (emitted
 * once); supplied keys never carry plaintext here. The echo policy in the report
 * builder (Task 13) decides whether a present `key` reaches the `env` output.
 */
export interface ApiKeyResult {
  label: string
  created: boolean
  keyPrefix: string
  /** Plaintext — present ONLY for a freshly generated (minted) key. */
  key?: string
}

interface ApiKeysSection {
  keys: ApiKeyResult[]
}

export const apiKeysProvisioner: Provisioner<ProvisioningConfig> = {
  key: "apiKeys",

  async plan(ctx, config): Promise<ProvisionPlan> {
    const apiKeys = config.apiKeys
    if (!apiKeys || apiKeys.length === 0) return { actions: [] }
    const actions: string[] = []
    for (const entry of apiKeys) {
      if (entry.key) {
        actions.push(`upsert supplied api key '${entry.label}' (by hash)`)
      } else if (ctx.orgId === "") {
        // No org yet (plan runs before the org provisioner's apply) — report the
        // generic intent. `apply` is idempotent by (org_id, label).
        actions.push(`ensure api key '${entry.label}'`)
      } else {
        // Read-only existence check by (org_id, label), non-revoked.
        const rows = await ctx.priv("cli-plan-apikeys", (tx) =>
          tx.execute(drizzleSql`
            SELECT id FROM ${ticketsRel("api_keys")}
            WHERE org_id = ${ctx.orgId} AND label = ${entry.label} AND revoked_at IS NULL
            LIMIT 1
          `),
        )
        actions.push(
          extractRows(rows).length > 0
            ? `api key '${entry.label}' already exists (cannot re-emit)`
            : `generate api key '${entry.label}'`,
        )
      }
    }
    return { actions }
  },

  async apply(ctx, _plan, config): Promise<ProvisionResult> {
    const apiKeys = config.apiKeys
    if (!apiKeys || apiKeys.length === 0) return {}

    const keys: ApiKeyResult[] = []
    const changed: string[] = []
    const unchanged: string[] = []

    for (const entry of apiKeys) {
      const allowedOrigins = entry.allowedOrigins ?? []

      if (entry.key) {
        // SUPPLIED: hash-upsert by (org_id, key_hash).
        const keyHash = hashToken(entry.key)
        const keyPrefix = entry.key.slice(0, 8)
        const inserted = await ctx.priv("cli-apikeys-upsert", (tx) =>
          tx.execute(drizzleSql`
            INSERT INTO ${ticketsRel("api_keys")} (
              id, org_id, key_hash, key_prefix, label, allowed_origins, created_by, created_at, updated_at
            ) VALUES (
              gen_random_uuid(), ${ctx.orgId}, ${keyHash}, ${keyPrefix}, ${entry.label},
              ${JSON.stringify(allowedOrigins)}::jsonb, ${ctx.actor.userId}, now(), now()
            )
            ON CONFLICT (org_id, key_hash) DO NOTHING
            RETURNING id
          `),
        )
        const created = extractRows(inserted).length > 0
        ctx.log(
          created
            ? `api key '${entry.label}' inserted (${keyPrefix}…)`
            : `api key '${entry.label}' already present (${keyPrefix}…)`,
        )
        // Plaintext is NEVER re-emitted for a supplied key (hash-only).
        keys.push({ label: entry.label, created, keyPrefix })
        if (created) changed.push(`apiKeys.${entry.label}`)
        else unchanged.push(`apiKeys.${entry.label}`)
        continue
      }

      // GENERATED: idempotent by (org_id, label), non-revoked.
      const existing = await ctx.priv("cli-apikeys-find", (tx) =>
        tx.execute(drizzleSql`
          SELECT key_prefix FROM ${ticketsRel("api_keys")}
          WHERE org_id = ${ctx.orgId} AND label = ${entry.label} AND revoked_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1
        `),
      )
      const existingRow = extractRows<{ key_prefix: string }>(existing)[0]
      if (existingRow) {
        ctx.log(`api key '${entry.label}' already exists (cannot re-emit plaintext)`)
        keys.push({ label: entry.label, created: false, keyPrefix: existingRow.key_prefix })
        unchanged.push(`apiKeys.${entry.label}`)
        continue
      }

      // Mint via the only callable path (apiKeysCreate is module-private).
      const result = await ctx.priv("cli-apikeys-create", (tx) =>
        runAdminOp(
          tx,
          ctx.orgId,
          "apiKeysCreate",
          { label: entry.label, allowedOrigins },
          { actorType: "user", userId: ctx.actor.userId },
        ),
      )
      const adminErr = readAdminErrorMessage(result)
      if (adminErr) {
        throw new Error(`apiKeysCreate failed for '${entry.label}': ${adminErr}`)
      }
      const minted = readMintedKey(result)
      if (!minted) {
        throw new Error(`apiKeysCreate returned an unexpected shape for '${entry.label}'`)
      }
      ctx.log(`api key '${entry.label}' generated (${minted.keyPrefix}…)`)
      keys.push({
        label: entry.label,
        created: true,
        keyPrefix: minted.keyPrefix,
        key: minted.key,
      })
      changed.push(`apiKeys.${entry.label}`)
    }

    const section: ApiKeysSection = { keys }
    return {
      section,
      ...(changed.length > 0 ? { changed } : {}),
      ...(unchanged.length > 0 ? { unchanged } : {}),
    }
  },
}
