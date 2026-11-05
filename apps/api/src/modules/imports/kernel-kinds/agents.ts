// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Host handlers of the kernel kinds `agents.skill` and `agents.routine`
 * (declared in modules/imports/kernel-kinds.ts).
 *
 * A skill or a routine carries capabilities, so an import never widens what
 * the person running it holds:
 * - a skill's `requiredScopes` must be within the importer's scopes, else the
 *   record fails `scope_ceiling`; an org-shared skill needs `kernel:apps:admin`
 *   as the create tool does; it is owned by the importer's personal agent and
 *   attributed to another author only by a user or app administrator;
 * - a routine's `scopes` must be within BOTH the importer's scopes and its
 *   owner's effective scopes (Q4), else `scope_ceiling`; a routine for someone
 *   else needs the delegate authority the create tool requires and is
 *   personal to that owner; a shared routine needs kernel:apps:admin; it arrives
 *   DISABLED (Q4), so nothing is scheduled, enqueued or subscribed: its owner
 *   turns it on.
 * The create tool's own checks (the event catalog, the prompt coverage
 * guards) run on the record; nothing of an existing skill or routine with the
 * same name is touched (skipped, A14).
 */
import { and, sql as drizzleSql, eq, or } from "drizzle-orm"
import { z } from "zod"
import type { PrivilegedDb } from "~/db"
import { routines, skills, users } from "~/db/schema/kernel"
import { getOrCreatePersonalAgentId } from "~/modules/agent/directory/personal-agent"
import { applyDefaultReportThreads } from "~/modules/agent/routines/routine-report"
import { isScopeCovered } from "~/modules/agent/scopes/scope-coverage"
import { upsertSkillIndexRow } from "~/modules/agent/skills/skill-index"
import {
  hasRoutineDelegateAuthority,
  validateFirmwareReleaseEventTrigger,
  validatePrepareShipmentsCoverage,
  validateRoutineEvent,
} from "~/modules/agent/tools/skills-routines-tools"
import type { HostImportContext, HostImportHandler } from "~/modules/imports/types"
import { hasScope, loadEffectivePermissions } from "~/modules/permissions/permissions"

const scopeList = z.array(z.string().min(1).max(200))

/** The canonical skill record (the declaration's JSON Schema mirrors it). */
export const skillImportRecordSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(100),
    body: z.string().min(1),
    domain: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .max(64)
      .optional(),
    requiredScopes: scopeList.max(100).optional(),
    enabled: z.boolean().optional(),
    visibility: z.enum(["personal", "org"]).optional(),
    authorEmail: z.string().max(320).optional(),
  })
  .strict()

/** The canonical routine record. */
export const routineImportRecordSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(200),
    prompt: z.string().min(1),
    kind: z.enum(["recurring", "scheduled", "event"]),
    cron: z.string().min(1).max(200).optional(),
    timezone: z.string().min(1).max(100).optional(),
    runAt: z.string().min(1).optional(),
    event: z.string().min(1).max(200).optional(),
    scopes: scopeList.max(200),
    visibility: z.enum(["personal", "shared"]).optional(),
    ownerEmail: z.string().max(320).optional(),
  })
  .strict()

/** A record refusal with its code, as the run lists it (`code: message`). */
class AgentsImportRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = "AgentsImportRefusal"
  }
}

/** The scopes of `wanted` that `held` does not cover. */
function uncovered(wanted: string[], held: string[]): string[] {
  return wanted.filter((s) => !isScopeCovered([s], held))
}

/** An ACTIVE org user by email, or null. */
async function activeUserByEmail(
  tx: PrivilegedDb,
  orgId: string,
  email: string,
): Promise<string | null> {
  const e = email.trim().toLowerCase()
  if (!e) return null
  const [row] = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.orgId, orgId),
        eq(users.status, "active"),
        drizzleSql`lower(${users.email}) = ${e}`,
      ),
    )
    .limit(1)
  return row?.id ?? null
}

async function importSkill(tx: PrivilegedDb, ctx: HostImportContext, raw: Record<string, unknown>) {
  const record = skillImportRecordSchema.parse(raw)
  const visibility = record.visibility ?? "org"
  if (visibility === "org" && !hasScope("kernel:apps:admin", ctx.actorScopes)) {
    throw new AgentsImportRefusal("out_of_scope", "an org-shared skill needs kernel:apps:admin")
  }
  const required = Array.from(new Set(record.requiredScopes ?? []))
  const beyond = uncovered(required, ctx.actorScopes)
  if (beyond.length > 0) {
    throw new AgentsImportRefusal(
      "scope_ceiling",
      `the skill requires ${beyond.join(", ")}, which you do not hold`,
    )
  }
  const report: Record<string, unknown> = {}
  let createdBy = ctx.actorUserId
  if (record.authorEmail) {
    // Attributing a skill to someone else is an administrator's call; anyone
    // else's import records them as its author (the source's author is
    // reported back, not written).
    const mayAttribute =
      hasScope("kernel:users:admin", ctx.actorScopes) ||
      hasScope("kernel:apps:admin", ctx.actorScopes)
    const author = mayAttribute ? await activeUserByEmail(tx, ctx.orgId, record.authorEmail) : null
    if (author) createdBy = author
    else {
      report[mayAttribute ? "authorUnresolved" : "authorNotAttributed"] = 1
      report.sourceAuthor = record.authorEmail
    }
  }
  // D9/A15: every skill is owned by an agent; the importer's personal agent,
  // as for a skill the importer writes with the create tool.
  const ownerAgentId = await getOrCreatePersonalAgentId(tx, {
    orgId: ctx.orgId,
    userId: ctx.actorUserId,
  })
  const authorUserId = visibility === "personal" ? ctx.actorUserId : null
  // The same name in the owner's set, among the org-shared skills, or among
  // the importer's personal ones (a personal copy would shadow the org one).
  const taken = await tx
    .select({ id: skills.id })
    .from(skills)
    .where(
      and(
        eq(skills.orgId, ctx.orgId),
        eq(skills.name, record.name),
        or(
          eq(skills.ownerAgentId, ownerAgentId),
          drizzleSql`${skills.authorUserId} IS NULL`,
          eq(skills.authorUserId, ctx.actorUserId),
        ),
      ),
    )
    .limit(1)
  if (taken.length > 0) return { status: "skipped" as const, rows: [], report }
  const [row] = await tx
    .insert(skills)
    .values({
      orgId: ctx.orgId,
      ownerAgentId,
      name: record.name,
      description: record.description,
      body: record.body,
      domain: record.domain ?? null,
      requiredScopes: required,
      enabled: record.enabled ?? true,
      authorUserId,
      createdByUserId: createdBy,
      createdByActorType: "user",
    })
    .returning({ id: skills.id, ownerAgentId: skills.ownerAgentId, name: skills.name })
  await upsertSkillIndexRow(tx, {
    orgId: ctx.orgId,
    ownerAgentId: row!.ownerAgentId,
    skillId: row!.id,
    skillName: row!.name,
  })
  return { status: "created" as const, rows: [{ table: "kernel.skills", id: row!.id }], report }
}

/** The timing columns of a routine kind, as the routines table requires them. */
function routineTiming(record: z.infer<typeof routineImportRecordSchema>, orgId: string) {
  if (record.kind === "recurring") {
    if (!record.cron || !record.timezone) {
      throw new AgentsImportRefusal("invalid_params", "a recurring routine needs cron and timezone")
    }
    return { cron: record.cron, timezone: record.timezone, runAt: null, event: null }
  }
  if (record.kind === "scheduled") {
    const at = record.runAt ? new Date(record.runAt) : null
    if (!at || Number.isNaN(at.getTime())) {
      throw new AgentsImportRefusal("invalid_params", "a scheduled routine needs a valid runAt")
    }
    return { cron: null, timezone: null, runAt: at, event: null }
  }
  if (!record.event) {
    throw new AgentsImportRefusal("invalid_event", "an event routine needs an `event` trigger")
  }
  const eventError = validateRoutineEvent(orgId, record.event)
  if (eventError) throw new AgentsImportRefusal(eventError.error.code, eventError.error.message)
  return { cron: null, timezone: null, runAt: null, event: record.event }
}

async function importRoutine(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
) {
  const record = routineImportRecordSchema.parse(raw)
  const timing = routineTiming(record, ctx.orgId)
  // The create tool's prompt guards (pure; the same refusals).
  const guard =
    validatePrepareShipmentsCoverage(record.prompt) ??
    validateFirmwareReleaseEventTrigger(record.prompt, record.kind)
  if (guard) throw new AgentsImportRefusal(guard.error.code, guard.error.message)

  const report: Record<string, unknown> = {}
  let ownerUserId = ctx.actorUserId
  if (record.ownerEmail) {
    const owner = await activeUserByEmail(tx, ctx.orgId, record.ownerEmail)
    if (owner) ownerUserId = owner
    else report.ownerUnresolved = 1
  }
  const delegated = ownerUserId !== ctx.actorUserId
  if (delegated && !hasRoutineDelegateAuthority(ctx.actorScopes)) {
    throw new AgentsImportRefusal(
      "delegation_forbidden",
      "a routine that runs as another person needs kernel:routines:delegate",
    )
  }
  // A shared routine can be switched on by others than its owner and then
  // runs as that owner: org-shared routines are an app administrator's, and a
  // routine imported for someone else is theirs alone.
  let visibility = record.visibility ?? "personal"
  if (visibility === "shared" && !hasScope("kernel:apps:admin", ctx.actorScopes)) {
    throw new AgentsImportRefusal("out_of_scope", "a shared routine needs kernel:apps:admin")
  }
  if (delegated && visibility === "shared") {
    visibility = "personal"
    report.madePersonal = 1
  }
  // Q4: within what both the importer and the owner hold.
  const scopes = Array.from(new Set(record.scopes))
  const ownerScopes =
    ownerUserId === ctx.actorUserId
      ? ctx.actorScopes
      : (await loadEffectivePermissions(tx, ownerUserId, ctx.orgId)).scopes
  const beyond = Array.from(
    new Set([...uncovered(scopes, ctx.actorScopes), ...uncovered(scopes, ownerScopes)]),
  )
  if (beyond.length > 0) {
    throw new AgentsImportRefusal(
      "scope_ceiling",
      `the routine needs ${beyond.join(", ")}, beyond what you and its owner both hold`,
    )
  }
  const taken = await tx
    .select({ id: routines.id })
    .from(routines)
    .where(
      and(
        eq(routines.orgId, ctx.orgId),
        eq(routines.ownerUserId, ownerUserId),
        eq(routines.name, record.name),
      ),
    )
    .limit(1)
  if (taken.length > 0) return { status: "skipped" as const, rows: [], report }
  const ownerAgentId = await getOrCreatePersonalAgentId(tx, {
    orgId: ctx.orgId,
    userId: ownerUserId,
  })
  const [row] = await tx
    .insert(routines)
    .values({
      orgId: ctx.orgId,
      ownerUserId,
      ownerAgentId,
      name: record.name,
      description: record.description,
      kind: record.kind,
      ...timing,
      prompt: record.prompt,
      scopes,
      visibility,
      // Q4: switched off; its owner turns it on (and the schedule with it).
      enabled: false,
      status: "active",
      createdByUserId: ctx.actorUserId,
      createdByActorType: "user",
    })
    .returning({ id: routines.id })
  return { status: "created" as const, rows: [{ table: "kernel.routines", id: row!.id }], report }
}

export const skillImportHandler: HostImportHandler = {
  importRecord: (tx, ctx, record) => importSkill(tx, ctx, record),
}

export const routineImportHandler: HostImportHandler = {
  importRecord: (tx, ctx, record) => importRoutine(tx, ctx, record),
  /**
   * Where each imported routine's runs post (routine-report.ts): its owner's
   * chat with their personal agent. Opened after the batch commits, under the
   * owner's own authority, so it never rides (or fails) the import's writes.
   */
  async afterCommit(ctx, results) {
    const ids = results.flatMap((r) =>
      r.status === "created"
        ? r.rows.filter((x) => x.table === "kernel.routines").map((x) => x.id)
        : [],
    )
    if (ids.length === 0) return undefined
    await applyDefaultReportThreads(ctx.orgId, ids)
    return undefined
  },
}
