// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Setup provisioner: stores the features the person chose in the onboarding
 * (`setup.features`) in the kernel settings (`settings.chosenFeatures`). What
 * `liaison setup state` and the agent's `setup_state` count as left is computed
 * from it (connection-guides/setup-features.ts); everything else is a menu.
 *
 * The list replaces the stored one (an answer, not an addition); an unknown id is
 * refused at plan time with the ids that exist.
 */
import { orgKernelSettingsSchema } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { ConfigError } from "~/cli/config/parse"
import type { ProvisioningConfig } from "~/cli/config/schema"
import type { Provisioner, ProvisionPlan, ProvisionResult } from "~/cli/provisioners/types"
import { schemaRef } from "~/db/schema-ref"
import { getOrgKernelSettings } from "~/lib/settings"
import { SETUP_FEATURE_IDS, unknownSetupFeatures } from "~/modules/connection-guides/setup-features"

/** The chosen features, deduplicated, in the catalog's order. */
function normalized(features: readonly string[]): string[] {
  const set = new Set(features)
  return SETUP_FEATURE_IDS.filter((id) => set.has(id))
}

function same(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return a !== undefined && a.length === b.length && a.every((v, i) => v === b[i])
}

export const setupProvisioner: Provisioner<ProvisioningConfig> = {
  key: "setup",

  async plan(ctx, config): Promise<ProvisionPlan> {
    const features = config.setup?.features
    if (!features) return { actions: [] }
    const unknown = unknownSetupFeatures(features)
    if (unknown.length > 0) {
      throw new ConfigError(
        `setup.features: unknown feature${unknown.length === 1 ? "" : "s"} ${unknown.map((u) => `'${u}'`).join(", ")} (one of ${SETUP_FEATURE_IDS.join(", ")})`,
      )
    }
    const want = normalized(features)
    const stored =
      ctx.orgId === ""
        ? null
        : await ctx.priv("cli-plan-setup", (tx) =>
            getOrgKernelSettings(tx, ctx.orgId, orgKernelSettingsSchema),
          )
    const unchanged = stored !== null && same(stored.chosenFeatures, want)
    return {
      ...(ctx.toolPath ? { changes: unchanged ? 0 : 1 } : {}),
      actions: [
        unchanged
          ? `setup features unchanged (${want.join(", ") || "none"})`
          : `set the chosen setup features: ${want.join(", ") || "none"}`,
      ],
    }
  },

  async apply(ctx, _plan, config): Promise<ProvisionResult> {
    const features = config.setup?.features
    if (!features) return {}
    const want = normalized(features)
    const stored = await ctx.priv("cli-setup-read", (tx) =>
      getOrgKernelSettings(tx, ctx.orgId, orgKernelSettingsSchema),
    )
    if (same(stored.chosenFeatures, want)) {
      ctx.log(`setup features already set (${want.join(", ") || "none"})`)
      return { section: { features: want, set: false }, unchanged: ["setup"] }
    }
    const k = drizzleSql.raw(schemaRef("kernel"))
    await ctx.priv("cli-setup-write", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE ${k}.organizations
        SET settings = COALESCE(settings, '{}'::jsonb) ||
          jsonb_build_object('chosenFeatures', ${JSON.stringify(want)}::jsonb),
          updated_at = now()
        WHERE id = ${ctx.orgId}::uuid
      `)
    })
    ctx.log(`setup features set (${want.join(", ") || "none"})`)
    return { section: { features: want, set: true }, changed: ["setup"] }
  },
}
