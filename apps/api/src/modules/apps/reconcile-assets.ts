// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import {
  appSeededAssets,
  disabledAppSkills,
  routines,
  subAgentDefinitions,
} from "~/db/schema/kernel"
import {
  announceEventRoutineChange,
  disposeEventRoutineSubscription,
  registerEventRoutineSubscription,
} from "~/infra/jobs/event-routine-subscriber"
import { isScopeSubset } from "~/modules/agent/subruns/sub-agent-definitions"

export interface SeededSkillDecl {
  name: string
  enabledByDefault: boolean
}

/**
 * Default-disabled semantics for seeded app skills. The overlay is
 * inclusion-by-default (absence of a row = enabled). On the FIRST reconcile for
 * `(org, app)` — detected via the `app_seeded_assets` marker — seed exactly ONE
 * org-wide (userId NULL) disabledBy:'seed' row for each enabledByDefault:false
 * skill that has no existing row, then record the marker. Every subsequent
 * reconcile/boot is a no-op for skill seeding: this is what makes the §3.4 /
 * §9 #10 invariant hold — a user who *enabled* a default-off skill (by deleting
 * its seed row) keeps it enabled forever after, and a user who *disabled* an
 * enabledByDefault:true skill keeps it disabled. Reconcile never re-seeds.
 *
 * Uses `withPrivilegedDb` (NOT the request-scoped `ctx.db`) — and this is
 * MANDATORY, not a stylistic choice (M3). The reconciler runs inside
 * `registerApps`'s per-org skill loop as a SYSTEM actor seeding org-wide
 * (userId NULL) rows. The RLS INSERT policy `disabled_app_skills_insert` has
 * WITH CHECK requiring `kernel:skills:write`, which the registration context
 * does not carry, so a request-scoped insert would be REJECTED.
 * `withPrivilegedDb` sets the privileged role that bypasses RLS. Do NOT
 * "simplify" this to `ctx.db`.
 */
export async function reconcileDefaultDisabledSkills(
  orgId: string,
  appName: string,
  skills: SeededSkillDecl[],
): Promise<void> {
  await withPrivilegedDb(orgId, "reconcile-default-disabled-skills", async (tx) => {
    // First-install gate: if the marker exists, seeding already happened once —
    // the user owns the toggle state thereafter. Strictly no-op.
    const [marker] = await tx
      .select({ id: appSeededAssets.id })
      .from(appSeededAssets)
      .where(and(eq(appSeededAssets.orgId, orgId), eq(appSeededAssets.appName, appName)))
      .limit(1)
    if (marker) return

    const defaultOff = skills.filter((s) => s.enabledByDefault === false)
    if (defaultOff.length > 0) {
      const existing = await tx
        .select({ skillName: disabledAppSkills.skillName })
        .from(disabledAppSkills)
        .where(and(eq(disabledAppSkills.orgId, orgId), eq(disabledAppSkills.appName, appName)))
      const seen = new Set(existing.map((r) => r.skillName)) // any provenance, any user-scope
      for (const s of defaultOff) {
        if (seen.has(s.name)) continue
        // DO NOTHING: two processes can set up a new org at once (the api that
        // created it, a worker running its first job); both pass the marker
        // check, and the second insert would otherwise fail its registration.
        await tx
          .insert(disabledAppSkills)
          .values({
            orgId,
            userId: null,
            appName,
            skillName: s.name,
            disabledBy: "seed",
          })
          .onConflictDoNothing()
      }
    }
    // Record the first-install marker (idempotent: unique on (org, app)).
    await tx.insert(appSeededAssets).values({ orgId, appName }).onConflictDoNothing()
  })
}

export interface AgentDecl {
  whenToUse: string
  systemPrompt: string
  scopeCeiling: string[]
  toolAllowlist?: string[]
  toolDenylist?: string[]
  skills?: string[]
  defaultMaxSteps?: number
  defaultTimeoutMs?: number
  contextProfile?: string
}

/**
 * Install-seed an app's `agents` into `sub_agent_definitions` (upsert by
 * `(orgId, agentType)`). Each agent's `scopeCeiling` must be a subset of the
 * app's granted scopes — a manifest declaring a ceiling that exceeds what the
 * app itself can do is rejected at seed time (the producer side of the §5
 * contract). `isScopeSubset` is the canonical coverage predicate (`*`, `:*`,
 * bare-prefix aware).
 */
export async function reconcileAgents(
  orgId: string,
  appName: string,
  agents: Record<string, AgentDecl>,
  appGrantedScopes: string[],
): Promise<void> {
  for (const [agentType, def] of Object.entries(agents)) {
    if (!isScopeSubset(def.scopeCeiling, appGrantedScopes)) {
      throw new Error(
        `agents.${agentType}: scope ceiling [${def.scopeCeiling.join(", ")}] exceeds app granted scopes [${appGrantedScopes.join(", ")}]`,
      )
    }
  }
  await withPrivilegedDb(orgId, "reconcile-agents", async (tx) => {
    for (const [agentType, def] of Object.entries(agents)) {
      const profile = def.contextProfile ?? "standard"
      await tx
        .insert(subAgentDefinitions)
        .values({
          orgId,
          appName,
          agentType,
          whenToUse: def.whenToUse,
          systemPrompt: def.systemPrompt,
          scopeCeiling: def.scopeCeiling,
          toolAllowlist: def.toolAllowlist ?? null,
          toolDenylist: def.toolDenylist ?? null,
          skills: def.skills ?? [],
          defaultMaxSteps: def.defaultMaxSteps ?? null,
          defaultTimeoutMs: def.defaultTimeoutMs ?? null,
          contextProfile: profile,
        })
        .onConflictDoUpdate({
          target: [subAgentDefinitions.orgId, subAgentDefinitions.agentType],
          set: {
            appName,
            whenToUse: def.whenToUse,
            systemPrompt: def.systemPrompt,
            scopeCeiling: def.scopeCeiling,
            toolAllowlist: def.toolAllowlist ?? null,
            toolDenylist: def.toolDenylist ?? null,
            skills: def.skills ?? [],
            defaultMaxSteps: def.defaultMaxSteps ?? null,
            defaultTimeoutMs: def.defaultTimeoutMs ?? null,
            contextProfile: profile,
            updatedAt: new Date(),
          },
        })
    }
  })
}

/**
 * Uninstall/deactivate: pause every routine the app *instantiated* for this org
 * (appName=<app> AND sourceKind='app'). Distinct status `paused_app_disabled`
 * (Task A1) so a later resume can tell "paused because the app went away" from a
 * user's own `paused_user` pause. Disposes event-routine subscriptions so an
 * uninstalled app's event routines stop firing immediately (the subscriber is
 * process-local; the next boot-load won't re-subscribe a non-active row).
 * Leaves `sub_agent_definitions` rows intact (historical/forkable; re-seeded on
 * reinstall) and does NOT touch user-authored routines (sourceKind='user').
 */
export async function pauseAppRoutinesForOrg(orgId: string, appName: string): Promise<void> {
  const paused = await withPrivilegedDb(orgId, "pause-app-routines", async (tx) =>
    tx
      .update(routines)
      .set({ status: "paused_app_disabled", enabled: false, updatedAt: new Date() })
      .where(
        and(
          eq(routines.orgId, orgId),
          eq(routines.appName, appName),
          eq(routines.sourceKind, "app"),
          eq(routines.status, "active"),
        ),
      )
      .returning({ id: routines.id, kind: routines.kind }),
  )
  // After the commit: dispose here, and announce so every process of the cell does.
  for (const r of paused) {
    if (r.kind !== "event") continue
    await disposeEventRoutineSubscription(r.id)
    await announceEventRoutineChange(r.id, orgId)
  }
}

/**
 * Reinstall/re-enable: resume ONLY the rows a prior uninstall paused
 * (status='paused_app_disabled'). A `paused_user` row stays paused — resume must
 * not clobber a user's own pause. Re-subscribes event routines so they fire
 * again. The boot-load path also covers this on restart; this handles the
 * in-process reinstall.
 */
export async function resumeAppRoutinesForOrg(orgId: string, appName: string): Promise<void> {
  const resumed = await withPrivilegedDb(orgId, "resume-app-routines", async (tx) =>
    tx
      .update(routines)
      .set({ status: "active", enabled: true, updatedAt: new Date() })
      .where(
        and(
          eq(routines.orgId, orgId),
          eq(routines.appName, appName),
          eq(routines.sourceKind, "app"),
          eq(routines.status, "paused_app_disabled"),
        ),
      )
      .returning({
        id: routines.id,
        kind: routines.kind,
        event: routines.event,
        eventFilter: routines.eventFilter,
      }),
  )
  for (const r of resumed) {
    if (r.kind === "event" && r.event) {
      await registerEventRoutineSubscription({
        routineId: r.id,
        orgId,
        event: r.event,
        filter: r.eventFilter ?? null,
      })
      await announceEventRoutineChange(r.id, orgId)
    }
  }
}
