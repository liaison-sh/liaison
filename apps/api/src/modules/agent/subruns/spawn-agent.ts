// SPDX-License-Identifier: FSL-1.1-ALv2
//
// spawnAgent() — kernel primitive that dispatches a fresh-context child agent
// run from any "parent" context (routine handler, LLM chat agent, or sandbox
// app via the RPC bridge).
//
// What spawnAgent does today (Task 3 scope):
//   1. Validate nesting depth (≤ MAX_NESTING_DEPTH)
//   2. Load the sub-agent role definition (E_UNKNOWN_AGENT_TYPE if missing)
//   3. Validate caller-narrowed scopes against parent and role ceiling
//      (E_SCOPE_NOT_SUBSET / E_SCOPE_OUTSIDE_ROLE / E_ROLE_UNAVAILABLE)
//   4. Compute effective scopes (parent ∩ role ∩ requested)
//   5. Clamp maxSteps / timeoutMs / schemaRetryBudget to KERNEL_FLOORS/CEILINGS
//   6. Create a hidden subrun thread (`type='subrun'`, `hidden_from_list=true`)
//   7. Insert a queued `agent_runs` row, root_run_id self-references for roots
//   8. Enqueue a BullMQ job on the `kernel:agent-subrun` queue
//   9. Return a handle with `runId` and `awaitResult()`
//
// What's NOT here yet (Task 4+):
//   * The BullMQ worker that picks up the job and runs the loop
//   * `awaitResult()`'s real pub/sub implementation (stub today; will live in
//     `subrun-await.ts`)
//   * Approval rerouting, audit linkage, system-prompt updates
//
// Actor model: ParentRunContext.actor is an ActorContext (UserContext OR
// SystemContext). The hidden thread's `created_by` is the parent's userId when
// the actor is a user; for SystemContext we currently fall back to the
// installer/admin of the org via DB lookup. Routine integration in Task 4
// will revisit this once routines actually call spawnAgent.

import crypto from "node:crypto"
import { PERSONAL_AGENT_DISPLAY_NAME } from "@liaison/shared"
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import type { ActorContext } from "~/db/rls"
import {
  agentRuns,
  messages as kernelMessages,
  threads as kernelThreads,
  users as kernelUsers,
} from "~/db/schema/kernel"
import { enqueueAppJob, isJobWorkerRegistered, registerJobWorker } from "~/infra/jobs/jobs"
import { rootLogger } from "~/lib/logger"
import { captureSpawnParentFrame, type SpawnParentFrame } from "~/modules/agent/runtime/run-context"
import type { SubRunTokenLimit } from "~/modules/agent/runtime/run-token-limit"
import { isScopeCovered } from "~/modules/agent/scopes/scope-coverage"
import { projectTaintScopesForOrg } from "~/modules/agent/scopes/taint-read-scopes"
import { resolveActingAgentIdForWrite, resolveAgentAuthorName } from "~/modules/threads/message"
import { messageVisibilityFacts } from "~/services/security/visibility"
import { assertOutputSchemaCompiles } from "./finalize-tool"
import { loadSubAgentDefinition } from "./sub-agent-definitions"
import { awaitSubRunResult, markParentIfSubRunReadOutsideText } from "./subrun-await"
import { insertSubrunThread } from "./subrun-thread"

const log = rootLogger.child({ module: "spawn-agent" })

// ---------------------------------------------------------------------------
// Constants — kernel-enforced bounds
// ---------------------------------------------------------------------------

export const KERNEL_FLOORS = {
  maxSteps: 1,
  timeoutMs: 1_000,
  schemaRetryBudget: 0,
} as const

export const KERNEL_DEFAULTS = {
  maxSteps: 25,
  timeoutMs: 60_000,
  schemaRetryBudget: 3,
} as const

// maxSteps ceiling is a runaway BACKSTOP, not a working limit — an opted-in
// exhaustive-sweep routine can use a large per-turn budget (e.g. 80) and lean on
// the supervisor's `length` re-loop to keep processing across turns. The real
// cost guard stays the credit checks (between-turn `checkCredits` + per-step
// `checkMidStep`), never this number.
export const KERNEL_CEILINGS = {
  maxSteps: 400,
  timeoutMs: 600_000,
  schemaRetryBudget: 5,
} as const

// Owner ruling: sub-agents nest at most two levels below the run that started
// them (root -> child at depth 1 -> grandchild at depth 2). A run at depth 2
// cannot spawn; the refusal reaches the model as a typed tool error.
export const MAX_NESTING_DEPTH = 2

export const AGENT_SUBRUN_JOB_NAME = "agent-subrun"

/**
 * The `agent-subrun` job payload. `parentTaintScopes` is the scope set the
 * parent had touched at spawn time; a job without it leaves the parent's taint
 * undeterminable and the worker fails closed.
 */
export interface SubRunJobPayload {
  orgId: string
  runId: string
  parentTaintScopes?: string[]
  /**
   * The spawning run's hard token limit and shared counter id (S17, A34): the
   * sub-run adds its steps to that counter and makes no model call once it is
   * spent. Absent when the spawning run has no hard limit.
   */
  tokenLimit?: SubRunTokenLimit
}

// ---------------------------------------------------------------------------
// Error class — closed code enum surfaces here and via the worker
// ---------------------------------------------------------------------------

export type SpawnAgentErrorCode =
  | "E_DEPTH_EXCEEDED"
  | "E_UNKNOWN_AGENT_TYPE"
  | "E_SCOPE_NOT_SUBSET"
  | "E_SCOPE_OUTSIDE_ROLE"
  | "E_ROLE_UNAVAILABLE"
  | "E_SYSTEM_ACTOR_MISSING_USER"
  | "E_INVALID_OUTPUT_SCHEMA"

export class SpawnAgentError extends Error {
  readonly code: SpawnAgentErrorCode
  /** A refused spawn is the caller's (the model's) mistake, not a server fault: the typed 422
   *  keeps the code and message on the tool result the model reads (execute-tool.ts). */
  readonly status = 422
  constructor(code: SpawnAgentErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParentRunContext {
  /** Null when parent is a routine handler (root spawn). */
  id: string | null
  /** Parent's thread id — surface thread for chat roots, routine thread for
   *  routine roots, hidden subrun thread for nested spawns. */
  threadId: string
  /** Parent's ActorContext (user OR system). */
  actor: ActorContext
  /** 0 for root parent; parent.nestingDepth + 1 propagates downward. */
  nestingDepth: number
  /** Optional explicit root ancestor id; defaults to parentRun.id for roots. */
  rootRunId?: string
}

export interface SpawnAgentParams {
  parentRun: ParentRunContext
  /**
   * The calling turn's frame, captured by a caller that runs where the frame
   * is lost (the sandbox bridge). Wins over the ALS frame; `null` says the
   * caller ran outside any frame. Undefined reads the ALS frame.
   */
  parentFrame?: SpawnParentFrame | null
  subagentType: string
  description: string
  prompt: string
  input?: unknown
  outputSchema?: Record<string, unknown>
  scopes?: string[]
  toolAllowlist?: string[]
  maxSteps?: number
  timeoutMs?: number
  schemaRetryBudget?: number
  continueOnError?: boolean
}

export interface SpawnAgentHandle {
  runId: string
  /** `signal`: the caller's stop, which cancels the sub-run and its children. */
  awaitResult(opts?: { signal?: AbortSignal }): Promise<SubRunResult>
}

export interface SubRunResult {
  ok: boolean
  runId: string
  output: unknown
  summary: string | null
  usage: {
    promptTokens: number
    completionTokens: number
    creditCost: string
  }
  error?: { code: string; message: string }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `child` ⊆ `parent`. Thin alias over the canonical coverage predicate so the
 *  spawn path agrees with the skills/routines and role-registry paths on `*`,
 *  `:*`-glob, and bare-prefix grants. */
export function isScopeSubset(child: string[], parent: string[]): boolean {
  return isScopeCovered(child, parent)
}

export function intersectScopes(a: string[], b: string[]): string[] {
  // Symmetric concrete-scope intersection with glob support.
  // Strategy: take each side's scopes that pass subset against the other.
  const fromA = a.filter((s) => isScopeSubset([s], b))
  const fromB = b.filter((s) => isScopeSubset([s], a) && !fromA.includes(s))
  return [...fromA, ...fromB]
}

type LimitKey = "maxSteps" | "timeoutMs" | "schemaRetryBudget"

export function clamp(
  callSite: number | undefined,
  defaultVal: number | null | undefined,
  key: LimitKey,
): number {
  const requested = callSite ?? defaultVal ?? KERNEL_DEFAULTS[key]
  const clamped = Math.min(Math.max(KERNEL_FLOORS[key], requested), KERNEL_CEILINGS[key])
  if (clamped !== requested) {
    log.warn(
      { event: "limit-floored", key, requested, applied: clamped },
      `spawn-agent: ${key} clamped from ${requested} to ${clamped}`,
    )
  }
  return clamped
}

function actorUserId(actor: ActorContext): string | null {
  return actor.actorType === "user" ? actor.userId : null
}

function actorScopes(actor: ActorContext): string[] {
  if (actor.actorType === "user") return actor.scopes
  return actor.scopes ?? []
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export async function spawnAgent(params: SpawnAgentParams): Promise<SpawnAgentHandle> {
  const { parentRun, subagentType, prompt, input, outputSchema } = params
  const orgId = parentRun.actor.orgId
  // The calling turn: captured by the caller when given, else the ALS frame.
  const frame = params.parentFrame !== undefined ? params.parentFrame : captureSpawnParentFrame()
  // A delegation is bounded by the caller's effective scope. When the calling
  // turn carries one, it (bounded by the actor) is the parent side, including
  // `[]`, which leaves the child nothing: fail closed. Without one the actor's
  // own scopes stay the parent side.
  const turnEffectiveScope = frame?.effectiveScope
  const parentScopes =
    turnEffectiveScope !== undefined
      ? intersectScopes(turnEffectiveScope, actorScopes(parentRun.actor))
      : actorScopes(parentRun.actor)
  // Scope taint crosses the spawn boundary downward: scoped data the parent
  // read may be in the child's instructions. The child starts with what the
  // parent turn had touched before the spawning call (the bridge's pre-call
  // snapshot, so spawn_agent's own scope does not taint the child; a sandbox
  // app tool's capture also holds that tool's own scope, since it read the
  // data), or
  // the accumulator's snapshot when spawned inside a turn but outside a tool
  // call. With no turn at all (a job, cron, webhook or UI action) the spawn is
  // a root run and the child starts clean, like a new chat turn. A turn with no
  // accumulator has an unknown taint, so the child is treated as having touched
  // the parent's full effective scope, projected onto the read scopes it implies
  // like every taint (scope-taint.ts, rule 5).
  const parentTaintScopes =
    frame === null ? [] : projectTaintScopesForOrg(frame.taintScopes ?? parentScopes, orgId)

  // 1) Nesting depth
  if (parentRun.nestingDepth >= MAX_NESTING_DEPTH) {
    throw new SpawnAgentError(
      "E_DEPTH_EXCEEDED",
      `Sub-agents nest at most ${MAX_NESTING_DEPTH} levels deep and this run is already at depth ${parentRun.nestingDepth}, so it cannot spawn another sub-agent. Do the work yourself, or return what you have to the run that spawned you.`,
    )
  }

  // 1b) Output schema: refuse one that cannot compile (invalid, or a pattern the
  // linear-time guard refuses) now, rather than when the child calls finalize.
  if (outputSchema) {
    try {
      assertOutputSchemaCompiles(outputSchema)
    } catch (err) {
      throw new SpawnAgentError(
        "E_INVALID_OUTPUT_SCHEMA",
        `output_schema cannot be used: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // 2) Role definition
  const agentDef = await loadSubAgentDefinition(orgId, subagentType)
  if (!agentDef) {
    throw new SpawnAgentError(
      "E_UNKNOWN_AGENT_TYPE",
      `No sub-agent definition for type "${subagentType}" in org ${orgId}`,
    )
  }

  // 3) Scope narrowing rules
  if (params.scopes) {
    if (!isScopeSubset(params.scopes, parentScopes)) {
      throw new SpawnAgentError(
        "E_SCOPE_NOT_SUBSET",
        `Requested scopes [${params.scopes.join(", ")}] are not a subset of parent's [${parentScopes.join(", ")}]`,
      )
    }
    if (!isScopeSubset(params.scopes, agentDef.scopeCeiling)) {
      throw new SpawnAgentError(
        "E_SCOPE_OUTSIDE_ROLE",
        `Requested scopes [${params.scopes.join(", ")}] exceed role ceiling [${agentDef.scopeCeiling.join(", ")}]`,
      )
    }
  }

  // 4) Effective scopes — parent ∩ role ∩ (callSite | role)
  //
  // Empty `scopeCeiling` is a documented opt-in for "no-scope roles" — pure-LLM
  // workers (summarizers, formatters) that need zero scoped tools. The
  // intersection trivially is `[]` for those roles and is valid; the
  // unavailability check below only fires when the role declares a non-empty
  // ceiling but the parent's set doesn't overlap (i.e. the parent literally
  // can't run anything the role expects). See spec §1.4.8 — amendment for the
  // empty-ceiling carve-out documented in the spec's Amendments section.
  const effectiveScopes = intersectScopes(
    intersectScopes(parentScopes, agentDef.scopeCeiling),
    params.scopes ?? agentDef.scopeCeiling,
  )
  if (effectiveScopes.length === 0 && agentDef.scopeCeiling.length > 0) {
    throw new SpawnAgentError(
      "E_ROLE_UNAVAILABLE",
      `Parent scopes [${parentScopes.join(", ")}] have no intersection with role "${subagentType}" ceiling [${agentDef.scopeCeiling.join(", ")}]`,
    )
  }

  // 5) Limit clamping
  const maxSteps = clamp(params.maxSteps, agentDef.defaultMaxSteps, "maxSteps")
  const timeoutMs = clamp(params.timeoutMs, agentDef.defaultTimeoutMs, "timeoutMs")
  const schemaRetryBudget = clamp(
    params.schemaRetryBudget,
    agentDef.defaultSchemaRetryBudget,
    "schemaRetryBudget",
  )

  // 6) Resolve a createdBy user for the hidden thread. For user actors,
  // straightforward. For system actors, fall back to any user in the org.
  // The thread's createdBy must be a real users.id (FK from threads.created_by
  // is not enforced here, but bootstrap users always exist).
  let creatorUserId = actorUserId(parentRun.actor)
  if (!creatorUserId) {
    const [anyUser] = await withPrivilegedDb(orgId, "spawn-agent-resolve-system-user", (tx) =>
      tx
        .select({ id: kernelUsers.id })
        .from(kernelUsers)
        .where(eq(kernelUsers.orgId, orgId))
        .limit(1),
    )
    if (!anyUser) {
      throw new SpawnAgentError(
        "E_SYSTEM_ACTOR_MISSING_USER",
        `No user found in org ${orgId} to serve as hidden-thread creator for system-actor spawn`,
      )
    }
    creatorUserId = anyUser.id
  }

  // 6b) Inherit taint downward across the spawn boundary. If the parent thread
  // is already tainted (e.g. the parent ran web_fetch, or it inherited taint
  // from one of its own sub-runs), the hidden subrun thread starts tainted too
  // — otherwise a sub-agent of a tainted parent would run trust-boundary tools
  // without the parent's protection.
  const [parentThread] = await withPrivilegedDb(orgId, "spawn-agent-parent-taint", (tx) =>
    tx
      .select({ tainted: kernelThreads.tainted })
      .from(kernelThreads)
      // Org-scope the read as defense-in-depth: withPrivilegedDb uses the
      // BYPASSRLS admin role, so the orgId predicate is the only guard against a
      // cross-org thread id leaking taint state — matching the org-scoping
      // hardening applied to setTaintFlag/checkTaintEscalation in taint.ts.
      .where(and(eq(kernelThreads.id, parentRun.threadId), eq(kernelThreads.orgId, orgId)))
      .limit(1),
  )
  const parentTainted = parentThread?.tainted ?? false

  // 7) Persist hidden thread + agent_runs row in a single privileged tx.
  const result = await withPrivilegedDb(orgId, "spawn-agent-persist", async (tx) => {
    const hiddenThreadId = await insertSubrunThread(tx, {
      orgId,
      subagentType,
      description: params.description,
      createdBy: creatorUserId,
      tainted: parentTainted,
    })

    const runId = crypto.randomUUID()
    const rootRunId = parentRun.rootRunId ?? parentRun.id ?? runId

    const [row] = await tx
      .insert(agentRuns)
      .values({
        id: runId,
        orgId,
        parentRunId: parentRun.id,
        rootRunId,
        threadId: hiddenThreadId,
        parentThreadId: parentRun.threadId,
        // A11 (X11): the agent the SPAWNING turn acted as, from the same
        // captured frame the card event below names. The run's own terminal
        // event fires after this transaction and outside every frame, so this
        // column is the only place that identity can still be read from.
        agentId: frame?.agentId ?? null,
        subagentType,
        actor: parentRun.actor,
        effectiveScopes,
        status: "queued",
        prompt,
        input: (input ?? null) as Record<string, unknown> | null,
        outputSchema: outputSchema ?? null,
        maxSteps,
        timeoutMs,
        schemaRetryBudget,
        nestingDepth: parentRun.nestingDepth + 1,
      })
      .returning()

    // §1.4.5 — write the collapsed `sub_run` card into the parent's thread.
    // authorType: 'agent' for user-actor parents (LLM-driven), 'system' for
    // routine/system actors. content is empty; the discriminator lives in
    // metadata.kind. The frontend renders SubRunCard for this message and
    // updates `metadata.subRun.{status,summary,usage}` in place via WS.
    const cardAuthorType = parentRun.actor.actorType === "user" ? "agent" : "system"
    // A8: an agent-authored card names the speaking agent, the same one the
    // run row and the event below record. The shared resolver falls back to
    // the creator's personal agent when the spawn carried no frame.
    const cardAuthorAgentId = await resolveActingAgentIdForWrite(tx, {
      orgId,
      userId: creatorUserId,
      authorType: cardAuthorType,
      agentId: frame?.agentId ?? null,
    })
    const [cardMsg] = await tx
      .insert(kernelMessages)
      .values({
        threadId: parentRun.threadId,
        orgId,
        authorId: creatorUserId,
        authorType: cardAuthorType,
        authorAgentId: cardAuthorType === "agent" ? cardAuthorAgentId : null,
        content: "",
        metadata: {
          kind: "sub_run",
          subRun: {
            runId,
            hiddenThreadId,
            agentType: subagentType,
            label: params.description.slice(0, 60),
            status: "queued",
            summary: null,
            usage: {
              promptTokens: 0,
              completionTokens: 0,
              creditCost: "0",
            },
          },
        } as Record<string, unknown>,
        // The label is the parent's own words, so the card carries what the
        // parent turn had read, exactly the taint the child starts with.
        requiredScopes: parentTaintScopes,
      })
      .returning({
        id: kernelMessages.id,
        // Read back so the event below takes it off the row instead of assuming
        // it. The insert sets no disclosure list, so it is null today, and null
        // is the correct value to send rather than nothing.
        disclosureList: kernelMessages.disclosureList,
      })

    // Surface the new card via the event bus so connected clients in the
    // parent thread see it immediately (no manual refresh).
    await tx.queueEvent({
      app: "kernel",
      entity: "message",
      action: "create",
      entityId: cardMsg.id,
      orgId,
      actorId: creatorUserId,
      // A11: the spawn persists through its OWN privileged handle, so neither
      // the live frame (the sandbox hop lost it) nor the bridge's handle
      // default reaches this emit. The calling turn is already resolved above,
      // captured or live, and naming it here is the same answer both ways.
      agentId: frame?.agentId ?? null,
      data: {
        id: cardMsg.id,
        threadId: parentRun.threadId,
        authorId: creatorUserId,
        authorType: cardAuthorType,
        // A8: the speaking agent travels with the live frame, and its name is
        // resolved the way the list read resolves it, so the card does not
        // arrive as a generic label and turn into the real agent on the
        // next refetch.
        authorAgentId: cardAuthorType === "agent" ? cardAuthorAgentId : null,
        authorName:
          cardAuthorType === "agent"
            ? await resolveAgentAuthorName(tx as never, {
                orgId,
                authorAgentId: cardAuthorAgentId,
              })
            : PERSONAL_AGENT_DISPLAY_NAME,
        content: "",
        metadata: {
          kind: "sub_run",
          subRun: {
            runId,
            hiddenThreadId,
            agentType: subagentType,
            label: params.description.slice(0, 60),
            status: "queued",
            summary: null,
            usage: {
              promptTokens: 0,
              completionTokens: 0,
              creditCost: "0",
            },
          },
        },
        ...messageVisibilityFacts({
          requiredScopes: parentTaintScopes,
          disclosureList: cardMsg.disclosureList,
        }),
        createdAt: new Date().toISOString(),
      },
    })

    return {
      run: row,
      hiddenThreadId,
      parentCardMessageId: cardMsg.id,
    }
  })

  // 8) Enqueue worker job on the kernel queue. enqueueAppJob accepts (appName,
  // jobName, payload, opts); we use appName='kernel' so it lives on the
  // existing kernel job pool. The worker registration lands in Task 4.
  //
  // Ensure a handler exists right before enqueue. Test suites that call
  // `closeAllQueues()` between files wipe `jobHandlers`, leaving auto-
  // registered placeholders stale — re-running the registration here is
  // idempotent against the live registry and keeps the call safe regardless
  // of teardown ordering.
  registerSpawnAgentPlaceholderWorker()
  // attempts: 1 — the sub-run loop is not safe to blindly replay (it deducts
  // credits and posts messages with no per-run idempotency key). A BullMQ retry
  // would re-run the full LLM loop and double-charge. The worker also has a
  // terminal-state guard (I-REL-11) as defense in depth.
  await enqueueAppJob(
    "kernel",
    AGENT_SUBRUN_JOB_NAME,
    {
      orgId,
      runId: result.run.id,
      parentTaintScopes,
      ...(frame?.tokenLimit ? { tokenLimit: frame.tokenLimit } : {}),
    } satisfies SubRunJobPayload,
    { attempts: 1 },
  )

  return {
    runId: result.run.id,
    awaitResult: async (awaitOpts?: { signal?: AbortSignal }) => {
      const subRunResult = await awaitSubRunResult(result.run.id, orgId, {
        continueOnError: params.continueOnError ?? false,
        timeoutMs: timeoutMs + 30_000,
        ...(awaitOpts?.signal ? { signal: awaitOpts.signal } : {}),
      })
      await markParentIfSubRunReadOutsideText(result.run.id, orgId)
      return subRunResult
    },
  }
}

/**
 * Placeholder worker registration so `enqueueAppJob` finds a handler before
 * Task 4's real subrun worker lands. Tasks 4+ overwrite this via the
 * `registerJobWorker("kernel", AGENT_SUBRUN_JOB_NAME, ...)` call in
 * subrun-worker. Multiple registrations are idempotent — the registry uses
 * a Map keyed on `app-${appName}:${jobName}`.
 *
 * The registration check consults the live `jobHandlers` map (via
 * `isJobWorkerRegistered`) rather than a module-private boolean — that way
 * `closeAllQueues()` (which calls `jobHandlers.clear()` between test files)
 * doesn't leave us with the flag stuck `true` while the handler is gone, a
 * latent test-isolation bug that surfaced as "No handler registered for job
 * kernel:agent-subrun" across the spawn-agent + subrun-worker + sandbox
 * bridge suites whenever they ran together.
 */
export function registerSpawnAgentPlaceholderWorker(): void {
  if (isJobWorkerRegistered("kernel", AGENT_SUBRUN_JOB_NAME)) return
  registerJobWorker<{ orgId: string; runId: string }>(
    "kernel",
    AGENT_SUBRUN_JOB_NAME,
    async (payload) => {
      log.warn(
        { runId: payload.runId, orgId: payload.orgId },
        "spawn-agent placeholder worker called — subrun-worker (Task 4) not yet wired",
      )
    },
  )
}

// Auto-register on import so tests can call spawnAgent without setup.
registerSpawnAgentPlaceholderWorker()

// Re-export for the worker (Task 4) to read agent_runs rows by id.
export async function getAgentRunById(orgId: string, runId: string) {
  return withPrivilegedDb(orgId, "spawn-agent-load-run", async (tx) => {
    const [row] = await tx.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
    return row ?? null
  })
}
