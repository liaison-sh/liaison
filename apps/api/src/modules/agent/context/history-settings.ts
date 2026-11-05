// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AN ORG'S CONVERSATION HISTORY SETTINGS (`settings.ai.history`).
//
// - `budgetTokens`: how much raw history an agent replays before the older part
//   is summarized into a checkpoint. Absent: the instance default
//   (`AGENT_HISTORY_BUDGET_TOKENS`, 256,000). Whatever is set, a model whose
//   window cannot hold it gets less (`historyBudget`, checkpoint.ts).
// - `warmCompaction`: an idle thread is summarized just before the provider's
//   prompt cache runs out (warm-compaction.ts). Absent: on.
//
// Read on every bounded history load, so a change applies from the next turn.

import {
  HISTORY_BUDGET_SETTING_MAX,
  HISTORY_BUDGET_SETTING_MIN,
  type HistorySettings,
  type HistorySettingsPatch,
  orgKernelSettingsSchema,
} from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { env } from "~/lib/env"
import { getOrgKernelSettings } from "~/lib/settings"
import { quoteIdent } from "~/lib/sql-utils"

/** What the org's settings say, with the defaults filled in. */
export interface OrgHistorySettings {
  /** The budget cap the org set, or null for the instance default. */
  budgetTokens: number | null
  warmCompaction: boolean
}

/** The instance default history budget cap, in tokens. */
export function instanceHistoryBudgetCap(): number {
  return env.AGENT_HISTORY_BUDGET_TOKENS
}

export async function loadOrgHistorySettings(orgId: string): Promise<OrgHistorySettings> {
  const settings = await withPrivilegedDb(orgId, "history-settings-read", (tx) =>
    getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
  )
  const raw = settings.ai?.history
  const budget = raw?.budgetTokens
  return {
    budgetTokens:
      typeof budget === "number" && Number.isFinite(budget)
        ? Math.min(HISTORY_BUDGET_SETTING_MAX, Math.max(HISTORY_BUDGET_SETTING_MIN, budget))
        : null,
    warmCompaction: raw?.warmCompaction !== false,
  }
}

/** The budget cap this org's threads run under: its own setting, else the instance default. */
export async function orgHistoryBudgetCap(orgId: string): Promise<number> {
  const { budgetTokens } = await loadOrgHistorySettings(orgId)
  return budgetTokens ?? instanceHistoryBudgetCap()
}

export async function historySettingsView(orgId: string): Promise<HistorySettings> {
  const s = await loadOrgHistorySettings(orgId)
  return {
    budgetTokens: s.budgetTokens,
    defaultBudgetTokens: instanceHistoryBudgetCap(),
    minBudgetTokens: HISTORY_BUDGET_SETTING_MIN,
    maxBudgetTokens: HISTORY_BUDGET_SETTING_MAX,
    warmCompaction: s.warmCompaction,
  }
}

/**
 * Change the org's history settings. One statement: the fields the patch names
 * are merged into `{ai,history}`, nothing else in the settings blob is touched.
 * A null budget removes the org's own value (the instance default applies).
 */
export async function setOrgHistorySettings(
  orgId: string,
  patch: HistorySettingsPatch,
): Promise<void> {
  const table = drizzleSql.raw(`${quoteIdent(schemaRef("kernel"))}.${quoteIdent("organizations")}`)
  const set: Record<string, unknown> = {}
  if (patch.budgetTokens !== undefined && patch.budgetTokens !== null) {
    set.budgetTokens = patch.budgetTokens
  }
  if (patch.warmCompaction !== undefined) set.warmCompaction = patch.warmCompaction
  const clearBudget = patch.budgetTokens === null
  await withPrivilegedDb(orgId, "history-settings-set", async (tx) => {
    await tx.execute(drizzleSql`
      UPDATE ${table}
      SET settings = jsonb_set(
            jsonb_set(COALESCE(settings, '{}'::jsonb), '{ai}', COALESCE(settings->'ai', '{}'::jsonb), true),
            '{ai,history}',
            (COALESCE(settings->'ai'->'history', '{}'::jsonb)
              - (CASE WHEN ${clearBudget} THEN 'budgetTokens' ELSE '' END))
              || ${JSON.stringify(set)}::jsonb,
            true
          ),
          updated_at = now()
      WHERE id = ${orgId}::uuid
    `)
  })
}
