// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Liaison team provisioner: the instance-wide `liaisonTeam` section of
 * `liaison config apply` (and of the `config_liaisonTeam` agent tool). It
 * calls the service behind Settings > System (`setSharing`), so registering,
 * deregistering and the audit row behave the same from every door.
 *
 * Operator only: on a multi-tenant instance (demo mode, managed) only the
 * operator org's admin decides for the server (`canManageInstanceApps`, the
 * rule of the Settings route). `forwardBugReports: true` without registration
 * is refused at plan time with the service's own message.
 *
 * An answer of "no" is an answer: applying `{register: false}` on an instance
 * that was never asked records the decision (`decidedAt`), which turns the
 * setup checklist's `liaisonTeam` item done.
 */
import { ConfigError } from "~/cli/config/parse"
import type { ProvisioningConfig } from "~/cli/config/schema"
import type {
  ProvisionContext,
  Provisioner,
  ProvisionPlan,
  ProvisionResult,
} from "~/cli/provisioners/types"
import { canManageInstanceApps } from "~/modules/apps/operator-org"
import { liaisonTeamEndpoint } from "~/modules/liaison-team/outbox"
import {
  LiaisonTeamError,
  type LiaisonTeamSharing,
  loadSharing,
  setSharing,
} from "~/modules/liaison-team/settings"

type Section = NonNullable<ProvisioningConfig["liaisonTeam"]>

const REGISTRATION_REQUIRED =
  "liaisonTeam.forwardBugReports: turn on registration with the Liaison team (register: true) before allowing bug report forwarding"
const NOT_AVAILABLE =
  "liaisonTeam: sharing with the Liaison team is not available on this server (LIAISON_TEAM_ENDPOINT is empty)"
const NOT_OPERATOR =
  "liaisonTeam: sharing with the Liaison team is decided for the whole server, so only the instance operator's organization can change it (LIAISON_OPERATOR_ORG_ID)"

/** What the section would leave in place, given what is stored. */
function desiredSharing(stored: LiaisonTeamSharing, section: Section): LiaisonTeamSharing {
  const register = section.register ?? stored.register
  const forwardBugReports = register
    ? (section.forwardBugReports ?? stored.forwardBugReports)
    : false
  // The team-only switch is set in Settings only; turning forwarding off turns it off.
  return {
    ...stored,
    register,
    forwardBugReports,
    bugReportsTeamOnly: forwardBugReports && stored.bugReportsTeamOnly,
  }
}

function sharingSummary(w: LiaisonTeamSharing): string {
  return `register ${w.register ? "on" : "off"}, bug report forwarding ${w.forwardBugReports ? "on" : "off"}`
}

async function verifyRequest(ctx: ProvisionContext, section: Section): Promise<LiaisonTeamSharing> {
  // The CLI plans before the org exists on a first run: the operator check
  // then waits for apply, when `org` has set the id.
  if (ctx.orgId !== "" && !(await canManageInstanceApps(ctx.orgId))) {
    throw new ConfigError(NOT_OPERATOR)
  }
  const stored = await loadSharing()
  const want = desiredSharing(stored, section)
  if (section.forwardBugReports === true && !want.register) {
    throw new ConfigError(REGISTRATION_REQUIRED)
  }
  if (want.register && !stored.register && !liaisonTeamEndpoint()) {
    throw new ConfigError(NOT_AVAILABLE)
  }
  return stored
}

/** True when applying `section` changes a switch or records a first answer. */
function sharingWouldChange(stored: LiaisonTeamSharing, section: Section): boolean {
  const w = desiredSharing(stored, section)
  return (
    stored.decidedAt === null ||
    w.register !== stored.register ||
    w.forwardBugReports !== stored.forwardBugReports
  )
}

export const liaisonTeamProvisioner: Provisioner<ProvisioningConfig> = {
  key: "liaisonTeam",

  async plan(ctx, config): Promise<ProvisionPlan> {
    const section = config.liaisonTeam
    if (!section) return { actions: [] }
    const stored = await verifyRequest(ctx, section)
    const w = desiredSharing(stored, section)
    const changed = sharingWouldChange(stored, section)
    return {
      ...(ctx.toolPath ? { changes: changed ? 1 : 0 } : {}),
      actions: [
        changed
          ? `share with the Liaison team: ${sharingSummary(w)}`
          : `Liaison team sharing unchanged (${sharingSummary(w)})`,
      ],
    }
  },

  async apply(ctx, _plan, config): Promise<ProvisionResult> {
    const section = config.liaisonTeam
    if (!section) return {}
    const stored = await verifyRequest(ctx, section)
    if (!sharingWouldChange(stored, section)) {
      ctx.log(`Liaison team sharing already set (${sharingSummary(stored)})`)
      return {
        section: { register: stored.register, forwardBugReports: stored.forwardBugReports },
        unchanged: ["liaisonTeam"],
      }
    }
    try {
      const after = await setSharing(
        {
          ...(section.register !== undefined ? { register: section.register } : {}),
          ...(section.forwardBugReports !== undefined
            ? { forwardBugReports: section.forwardBugReports }
            : {}),
        },
        { userId: ctx.actor.userId || null, orgId: ctx.orgId },
      )
      ctx.log(`Liaison team sharing set (${sharingSummary(after)})`)
      return {
        section: { register: after.register, forwardBugReports: after.forwardBugReports },
        changed: ["liaisonTeam"],
      }
    } catch (err) {
      if (err instanceof LiaisonTeamError) throw new ConfigError(`liaisonTeam: ${err.message}`)
      throw err
    }
  },
}
