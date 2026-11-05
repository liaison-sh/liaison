// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Email-identity provisioner (Task 7). Writes the per-org transactional email
 * identity into the passthrough kernel settings (`settings.email.{from,replyTo}`)
 * so invitations and password resets brand their outbound mail per-org (resolved
 * by `modules/org/email-from.ts`).
 *
 * Handle: `withPrivilegedDb` (org-scoped) via `ctx.priv`. The jsonb merge mirrors
 * the BYOK provisioner's `settings || jsonb_build_object(...)` shape so a value
 * written here is read back identically by `getOrgKernelSettings`.
 *
 * Idempotency: read the current `settings.email`; if BOTH `from` and `replyTo`
 * already equal the config (after the same merge semantics) → skip the write and
 * report `set:false` / `unchanged`. Otherwise merge only the supplied keys
 * (`from`/`replyTo`), leaving any unrelated `settings.email.*` keys intact.
 */
import { orgKernelSettingsSchema } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import type { ProvisioningConfig } from "~/cli/config/schema"
import type { Provisioner, ProvisionPlan, ProvisionResult } from "~/cli/provisioners/types"
import { schemaRef } from "~/db/schema-ref"
import { getOrgKernelSettings } from "~/lib/settings"

interface EmailSection {
  /** The resolved `from` after this run (the config value, or the stored value
   *  if the config did not set it). May be undefined if neither is set. */
  from?: string
  /** The resolved `replyTo` after this run. */
  replyTo?: string
  /** Whether this run wrote (merged) the settings (false = idempotent skip). */
  set: boolean
}

export const emailProvisioner: Provisioner<ProvisioningConfig> = {
  key: "email",

  async plan(ctx, config): Promise<ProvisionPlan> {
    const email = config.email
    if (!email || (email.from === undefined && email.replyTo === undefined)) {
      return { actions: [] }
    }
    // The driver plans before any apply → `ctx.orgId` is unset here (org is
    // created in its apply). Without an org we cannot read the stored email
    // identity; report the set intent. `apply` does the real unchanged compare.
    const stored =
      ctx.orgId === ""
        ? null
        : await ctx.priv("cli-plan-email", (tx) =>
            getOrgKernelSettings(tx, ctx.orgId, orgKernelSettingsSchema),
          )
    const unchanged = stored !== null && isUnchanged(stored.email, email)
    return {
      ...(ctx.toolPath ? { changes: unchanged ? 0 : 1 } : {}),
      actions: [
        unchanged
          ? `email identity unchanged (from=${email.from ?? "—"})`
          : `set email identity (from=${email.from ?? "—"}, replyTo=${email.replyTo ?? "—"})`,
      ],
    }
  },

  async apply(ctx, _plan, config): Promise<ProvisionResult> {
    const email = config.email
    if (!email || (email.from === undefined && email.replyTo === undefined)) {
      return {}
    }

    const stored = await ctx.priv("cli-email-read", (tx) =>
      getOrgKernelSettings(tx, ctx.orgId, orgKernelSettingsSchema),
    )

    if (isUnchanged(stored.email, email)) {
      const section: EmailSection = {
        ...(stored.email?.from !== undefined ? { from: stored.email.from } : {}),
        ...(stored.email?.replyTo !== undefined ? { replyTo: stored.email.replyTo } : {}),
        set: false,
      }
      ctx.log(`email identity already set (from=${section.from ?? "—"})`)
      return { section, unchanged: ["email"] }
    }

    // Merge only the supplied keys onto the existing settings.email object so an
    // unrelated key under settings.email is preserved.
    const merge: Record<string, string> = {}
    if (email.from !== undefined) merge.from = email.from
    if (email.replyTo !== undefined) merge.replyTo = email.replyTo
    const mergeJson = JSON.stringify(merge)

    const k = drizzleSql.raw(schemaRef("kernel"))
    await ctx.priv("cli-email-write", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE ${k}.organizations
        SET settings = COALESCE(settings, '{}'::jsonb) ||
          jsonb_build_object('email',
            COALESCE(settings->'email', '{}'::jsonb) || ${mergeJson}::jsonb
          ),
          updated_at = now()
        WHERE id = ${ctx.orgId}::uuid
      `)
    })

    const resolvedFrom = email.from ?? stored.email?.from
    const resolvedReplyTo = email.replyTo ?? stored.email?.replyTo
    const section: EmailSection = {
      ...(resolvedFrom !== undefined ? { from: resolvedFrom } : {}),
      ...(resolvedReplyTo !== undefined ? { replyTo: resolvedReplyTo } : {}),
      set: true,
    }
    ctx.log(`email identity set (from=${section.from ?? "—"}, replyTo=${section.replyTo ?? "—"})`)
    return { section, changed: ["email"] }
  },
}

/**
 * The merge is a no-op when every supplied key already equals the stored value.
 * (Keys the config does not set are not compared — a partial config only updates
 * what it names.)
 */
function isUnchanged(
  stored: { from?: string; replyTo?: string } | undefined,
  config: { from?: string; replyTo?: string },
): boolean {
  if (config.from !== undefined && stored?.from !== config.from) return false
  if (config.replyTo !== undefined && stored?.replyTo !== config.replyTo) return false
  return true
}
