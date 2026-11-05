// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Limits provisioner: the org's caps (`organizations.caps`, modules/org/caps.ts)
 * from the `limits` section of `liaison config apply`.
 *
 * Operator only. `limits` is not one of the agent's config sections
 * (CONFIG_TOOL_SECTIONS, config-tool-input.ts), so no `config_limits` tool
 * exists, and this provisioner refuses to run on the tool path anyway: an org
 * admin acting through their agent must never raise their own caps.
 *
 * A named cap is set (`null` makes it unlimited); a cap the section does not
 * name is kept. Re-running the same section changes nothing.
 */
import { ORG_CAP_KINDS, type OrgCapKind } from "@liaison/shared"
import { ConfigError } from "~/cli/config/parse"
import type { ProvisioningConfig } from "~/cli/config/schema"
import type { Provisioner, ProvisionPlan, ProvisionResult } from "~/cli/provisioners/types"
import { readOrgCaps, setOrgCaps } from "~/modules/org/caps"

type Limits = NonNullable<ProvisioningConfig["limits"]>

function diff(
  current: Record<string, number | undefined>,
  limits: Limits,
): { set: Partial<Record<OrgCapKind, number>>; unset: OrgCapKind[] } {
  const set: Partial<Record<OrgCapKind, number>> = {}
  const unset: OrgCapKind[] = []
  for (const kind of ORG_CAP_KINDS) {
    if (!(kind in limits)) continue
    const want = limits[kind]
    if (want === null || want === undefined) {
      if (current[kind] !== undefined) unset.push(kind)
    } else if (current[kind] !== want) {
      set[kind] = want
    }
  }
  return { set, unset }
}

function refuseToolPath(toolPath: boolean): void {
  if (toolPath) {
    throw new ConfigError("limits: caps are set by whoever runs the server, never through an agent")
  }
}

export const limitsProvisioner: Provisioner<ProvisioningConfig> = {
  key: "limits",

  async plan(ctx, config): Promise<ProvisionPlan> {
    const limits = config.limits
    if (!limits) return { actions: [] }
    refuseToolPath(ctx.toolPath)
    const named = ORG_CAP_KINDS.filter((k) => k in limits)
    if (named.length === 0) return { actions: [] }
    return {
      actions: [`set caps ${named.map((k) => `${k}=${limits[k] ?? "unlimited"}`).join(", ")}`],
    }
  },

  async apply(ctx, _plan, config): Promise<ProvisionResult> {
    const limits = config.limits
    if (!limits) return {}
    refuseToolPath(ctx.toolPath)
    const current = await readOrgCaps(ctx.orgId)
    const change = diff(current as Record<string, number | undefined>, limits)
    if (Object.keys(change.set).length === 0 && change.unset.length === 0) {
      ctx.log("caps unchanged")
      return { section: { caps: current, set: false }, unchanged: ["limits"] }
    }
    const caps = await setOrgCaps(ctx.orgId, change)
    ctx.log(`caps set: ${JSON.stringify(caps)}`)
    return { section: { caps, set: true }, changed: ["limits.caps"] }
  },
}
