// SPDX-License-Identifier: FSL-1.1-ALv2

import { isProviderCreditBlockError, type ReasoningLevel } from "@liaison/shared"
import { z } from "zod"
import { SINK_KERNEL_MESSAGES } from "~/modules/agent/scopes/scope-taint"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { envelopeError } from "~/modules/apps/sandbox/bridge/shared"

// `ctx.messages.post(p)` params. Exactly one of `thread_id`/`contact_id` must be
// set; the body is bounded so a missing/oversized payload surfaces as a coded
// `bad_request` envelope rather than a raw `Buffer.byteLength(undefined, …)`
// TypeError leaking to the sandbox.
const messagesPostParamsSchema = z
  .object({
    thread_id: z.string().min(1).optional(),
    contact_id: z.string().min(1).optional(),
    body: z.string(),
    attachment_file_ids: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((p) => (p.thread_id ? 1 : 0) + (p.contact_id ? 1 : 0) === 1, {
    message: "exactly one of thread_id or contact_id must be set",
  })

/**
 * Format an AI SDK / provider stream-error envelope into a human-readable, actionable
 * message for the chaos-debug `agent_run` caller + the judge transcript.
 *
 * Digs a few levels of the nested error envelope for a `.message` string (an OpenAI
 * `server_error` arrives as error.error.error.message); when NO nested message is found
 * it assembles one from the richest envelope signal fields (name/statusCode/code/
 * responseBody/cause) rather than collapsing to a bare `"agent stream error"`. The bare
 * opaque string made a transient provider stream hiccup indistinguishable from a real
 * product fault in the judge transcript (a marco-mondial-relay run hit exactly this: a
 * 1-of-3 stream error judged with the uninformative bare message) — conventions:
 * field-level error observability, never a swallowed mystery.
 */
export function formatStreamError(e: unknown): string {
  let cur: unknown = e
  for (let depth = 0; depth < 5 && cur && typeof cur === "object"; depth++) {
    const o = cur as { message?: unknown; error?: unknown }
    if (typeof o.message === "string" && o.message.trim()) return o.message
    cur = o.error
  }
  if (typeof e === "string") return e
  if (e && typeof e === "object") {
    const a = e as {
      name?: unknown
      statusCode?: unknown
      status?: unknown
      code?: unknown
      responseBody?: unknown
      body?: unknown
      cause?: { name?: unknown; message?: unknown; code?: unknown }
    }
    const parts: string[] = []
    if (typeof a.name === "string" && a.name.trim()) parts.push(a.name)
    const status = a.statusCode ?? a.status
    if (status != null) parts.push(`status=${String(status)}`)
    if (a.code != null) parts.push(`code=${String(a.code)}`)
    const respBody = a.responseBody ?? a.body
    if (typeof respBody === "string" && respBody.trim())
      parts.push(`body=${respBody.slice(0, 300)}`)
    if (a.cause && typeof a.cause === "object") {
      const c = a.cause
      const causeMsg =
        (typeof c.message === "string" && c.message.trim() && c.message) ||
        (typeof c.name === "string" && c.name.trim() && c.name) ||
        (c.code != null && `code=${String(c.code)}`) ||
        null
      if (causeMsg) parts.push(`cause=${causeMsg}`)
    }
    if (parts.length > 0) return `agent stream error (${parts.join(" ")})`
    try {
      const json = JSON.stringify(e)
      if (json && json !== "{}") return `agent stream error ${json.slice(0, 300)}`
    } catch {
      // fall through to the bare default
    }
  }
  return "agent stream error"
}

/** Agent runs and spawns, cross-app executeTool dispatch, and thread messages. */
export function createAgentMethods(ctx: BridgeContext): Record<string, any> {
  const {
    appName,
    approvalContext,
    bridgeActingAgentId,
    bridgeOptions,
    bridgeReadOnlyRun,
    bridgeSpawnParentFrame,
    bridgeTaintOriginStore,
    bridgeTurnTaintScopes,
    callerScopes,
    errorEnvelope,
    inheritedActor,
    logger,
    manifest,
    orgId,
    refuseWriteOnReadOnlyRun,
    requireCapability,
    txDb,
    userId,
    orgScopedAppChannel,
  } = ctx
  return {
    // --- Agent runtime (capability: agent.run) ---
    agent_run: async (paramsJson: string): Promise<string> => {
      try {
        requireCapability("agent.run")
      } catch (e) {
        return errorEnvelope(e)
      }
      const actor = bridgeOptions?.actor
      if (!actor || actor.actorType !== "user") {
        throw new Error(
          "ctx.agent.run: requires a user actor; not available in event-driven handlers (use the tool entry-point instead).",
        )
      }
      const params = JSON.parse(paramsJson) as {
        threadId: string
        prompt: string
        modelId?: string | null
        reasoningLevel?: ReasoningLevel | null
        channel?: string
      }
      let scopedChannel: string | null = null
      if (params.channel) {
        try {
          scopedChannel = orgScopedAppChannel(appName, params.channel)
        } catch (e) {
          return errorEnvelope(e)
        }
      }
      const { getRunAgentChat } = await import("~/modules/agent/runtime/agent-service")
      const { REDIS_PREFIX, publishRedis } = await import("~/lib/redis")
      const chat = await getRunAgentChat()({
        threadId: params.threadId,
        content: params.prompt,
        modelId: params.modelId ?? null,
        // Forward the chaos escalation-ladder reasoning level to the SAME
        // `reasoningLevel` param the product's route/re-invoke path uses; agent-service
        // clamps it per-model (getReasoningCapability) + maps it (buildReasoning).
        reasoningLevel: params.reasoningLevel ?? null,
        actor,
        orgId,
      })
      const fullChannel = scopedChannel ? `${REDIS_PREFIX}${scopedChannel}` : null
      let promptTokens = 0
      let completionTokens = 0
      let finishReason = "stop"
      let text = ""
      // Capture an in-band stream error so a failed turn surfaces the REAL cause
      // (provider spend-cap / quota / 5xx) to the caller instead of being swallowed
      // into a silent empty "stop" message — the blank-turn class (BL-177 spend cap).
      let streamErrorMsg: string | null = null
      const steps: Array<{
        toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }>
        toolResults: Array<{ toolCallId: string; result: unknown }>
      }> = []
      // Mirror agent-service.ts's streaming pipeline EXACTLY (the canonical chat
      // path): `currentStep` is initialized up front and flushed on `finish-step`
      // — the AI SDK v6 stream emits `start-step`/`finish-step` (NOT `step-start`)
      // and carries tool args on `.input` / tool results on `.output`. The old
      // code keyed on `step-start` (a name the SDK never emits) so `currentStep`
      // stayed null and EVERY tool call/result was dropped → `steps` was always
      // empty. A reasoning-model turn that calls tools but emits little closing
      // text then persisted as a fully blank agent message (no text, no recorded
      // tool activity) — the "empty turn" the persona/judge saw. Keep this in
      // lockstep with agent-service.ts so chat and chaos-debug agent_run agree.
      let currentStep: (typeof steps)[number] = { toolCalls: [], toolResults: [] }
      // Surface the REAL cause of a provider/tool stream error (module-level
      // `formatStreamError` — digs the nested envelope, falls back to the richest
      // signal fields instead of a bare opaque "agent stream error").
      const streamErrorMessage = formatStreamError
      for await (const part of chat.fullStream) {
        if (fullChannel) await publishRedis(fullChannel, JSON.stringify(part))
        const p = part as any
        if (p.type === "text-delta") {
          text += String(p.text ?? "")
        } else if (p.type === "error") {
          // AI SDK v6 surfaces a provider/tool error mid-stream as an in-band
          // `error` part, after which the stream ends WITHOUT a `finish`. Mirror
          // agent-service.ts: record it as the terminal `finishReason` so a failed
          // turn is not silently persisted as an empty "stop" message, and LOG it
          // — provider stream errors (e.g. an OpenAI `server_error`) were
          // previously swallowed here, surfacing only as an unexplained blank turn.
          finishReason = "error"
          streamErrorMsg = streamErrorMessage(p.error)
          logger.warn(
            { threadId: params.threadId, err: streamErrorMsg },
            "chaos-debug agent_run: provider stream error (turn persisted empty)",
          )
        } else if (p.type === "tool-call") {
          currentStep.toolCalls.push({
            toolCallId: p.toolCallId,
            toolName: p.toolName,
            args: p.input ?? {},
          })
        } else if (p.type === "tool-result") {
          currentStep.toolResults.push({ toolCallId: p.toolCallId, result: p.output ?? null })
        } else if (p.type === "finish-step") {
          // AI SDK v6 reports per-step usage on `finish-step` (not the outer
          // `finish`). Accumulate across steps — matches agent-service.ts's
          // streaming pipeline so the credit meter sees the same totals
          // regardless of entry point (chat vs chaos-debug agent_run).
          const usage = p.usage as any
          promptTokens += usage?.inputTokens ?? 0
          completionTokens += usage?.outputTokens ?? 0
          if (p.finishReason) finishReason = String(p.finishReason)
          steps.push({ ...currentStep })
          currentStep = { toolCalls: [], toolResults: [] }
        } else if (p.type === "finish") {
          finishReason = String(p.finishReason ?? finishReason)
        }
      }
      // Flush a trailing step if the stream ended without a final `finish-step`
      // (defensive — the SDK normally closes each step). Guarded so a normal
      // run (currentStep already flushed + reset to empty) never double-pushes.
      if (currentStep.toolCalls.length > 0 || currentStep.toolResults.length > 0) {
        steps.push(currentStep)
      }
      // `chat.finalize` can THROW (e.g. the terminal credit re-check / message-persist
      // path raises an HTTPException) when the turn ended on a provider stream error.
      // An un-caught throw here escapes agent_run and is caught by an OUTER layer that
      // turned it into an `errorEnvelope` with an EMPTY message + a NON-AGENT_STREAM_ERROR
      // code — so the chaos bridge re-threw a bare `Error("")` with NO `[chaos-agent-stream-flake]`
      // marker, which `isInfraFlakeError` could not classify → it CRASHED the whole ~50-min
      // journey at this step instead of routing through the bounded infra retry (journey-16
      // marco_week_fulfillment S4). Catch it HERE and surface it as a properly-coded
      // AGENT_STREAM_ERROR envelope carrying the REAL cause (the stream-error message we
      // already captured, else the throw's message) — so (a) the cause is never an empty
      // string (no swallow) and (b) the code routes the transient stream flake through the
      // SAME bounded retry as the no-output path below.
      let result: Awaited<ReturnType<typeof chat.finalize>>
      try {
        result = await chat.finalize({
          usage: { promptTokens, completionTokens },
          finishReason,
          text,
          steps,
          errorDetail: streamErrorMsg ?? undefined,
        })
      } catch (finalizeErr) {
        const msg =
          streamErrorMsg ??
          (finalizeErr instanceof Error && finalizeErr.message
            ? finalizeErr.message
            : `agent finalize failed (${String(finalizeErr)})`)
        logger.warn(
          { threadId: params.threadId, err: msg, finishReason },
          "chaos-debug agent_run: finalize threw — surfacing as AGENT_STREAM_ERROR (classifiable flake)",
        )
        if (fullChannel) {
          await publishRedis(fullChannel, JSON.stringify({ type: "agent-run.error", message: msg }))
        }
        return errorEnvelope({
          code: isProviderCreditBlockError(msg) ? "PROVIDER_CREDIT_BLOCK" : "AGENT_STREAM_ERROR",
          message: msg,
          retryable: false,
        })
      }
      // A turn that ERRORED with no output must SURFACE the real cause, not look
      // like a normal completion (the blank-turn class — a provider spend-cap was
      // swallowed into a silent empty turn, BL-177). Return an error envelope so the
      // chaos-debug handler republishes it as `__chaos_done {error}` and the caller
      // (conductor / sandboxed app) sees the cause. A PROVIDER_CREDIT_BLOCK is tagged
      // distinctly so the loop can HARD-BLOCK instead of grinding every scenario.
      if (finishReason === "error" && !text.trim()) {
        const msg = streamErrorMsg ?? "agent stream error"
        if (fullChannel) {
          await publishRedis(fullChannel, JSON.stringify({ type: "agent-run.error", message: msg }))
        }
        return errorEnvelope({
          code: isProviderCreditBlockError(msg) ? "PROVIDER_CREDIT_BLOCK" : "AGENT_STREAM_ERROR",
          message: msg,
          retryable: false,
        })
      }
      if (fullChannel) {
        await publishRedis(fullChannel, JSON.stringify({ type: "agent-run.complete", result }))
      }
      return JSON.stringify({ result, userMessageId: chat.userMessageId })
    },

    // --- Agent dispatch (capability: agent.spawn + trusted) ---
    // T10 — Allows a TRUSTED sandbox app to dispatch a fresh-context child
    // agent run via spawnAgent(). Untrusted apps are refused (E_NOT_TRUSTED);
    // trusted apps missing the capability declaration are also refused
    // (E_CAPABILITY_NOT_DECLARED via requireCapability). Successful calls
    // return `{ runId }` as a JSON envelope. Sandboxed callers may then
    // await the structured result via `agent_awaitRun` (companion method
    // below, same gating).
    agent_spawn: async (paramsJson: string): Promise<string> => {
      if (!manifest.trusted) {
        return envelopeError(
          "E_NOT_TRUSTED",
          `App "${appName}" is not trusted; agent.spawn refused`,
        )
      }
      try {
        requireCapability("agent.spawn")
      } catch (e) {
        return errorEnvelope(e)
      }
      const actor = bridgeOptions?.actor
      if (!actor) {
        return envelopeError("E_NO_ACTOR", "ctx.agent.spawn: bridge has no actor context")
      }
      const threadId = bridgeOptions?.threadId
      if (!threadId) {
        return envelopeError("E_NO_THREAD", "ctx.agent.spawn: bridge has no thread context")
      }
      const params = JSON.parse(paramsJson) as {
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
      const { spawnAgent } = await import("~/modules/agent/subruns/spawn-agent")
      // The child nests one level below the agent run that called this app tool,
      // read from the frame captured where it was still live (this callback has
      // lost it). Depth 0 only when no agent run called at all (a job, cron,
      // webhook or UI action). Hard-coding 0 here let a depth-2 sub-run start a
      // fresh chain through an app tool, defeating MAX_NESTING_DEPTH and the
      // agent-slot math sized on it; spawnAgent refuses beyond the cap with
      // E_DEPTH_EXCEEDED exactly as the kernel spawn_agent tool does.
      const callerRun = bridgeSpawnParentFrame?.run
      try {
        const handle = await spawnAgent({
          parentRun: {
            // A root turn's run id names no agent_runs row (only sub-runs have
            // one), so only a sub-run caller is recorded as the parent.
            id: callerRun && callerRun.nestingDepth > 0 ? callerRun.runId : null,
            threadId,
            actor,
            nestingDepth: callerRun?.nestingDepth ?? 0,
            ...(callerRun && callerRun.nestingDepth > 0 ? { rootRunId: callerRun.rootRunId } : {}),
          },
          parentFrame: bridgeSpawnParentFrame,
          subagentType: params.subagentType,
          description: params.description,
          prompt: params.prompt,
          input: params.input,
          outputSchema: params.outputSchema,
          scopes: params.scopes,
          toolAllowlist: params.toolAllowlist,
          maxSteps: params.maxSteps,
          timeoutMs: params.timeoutMs,
          schemaRetryBudget: params.schemaRetryBudget,
          continueOnError: params.continueOnError,
        })
        return JSON.stringify({ runId: handle.runId })
      } catch (e) {
        return errorEnvelope(e)
      }
    },

    // Companion to `agent_spawn`: awaits the structured result of a sub-run
    // dispatched earlier. Same gating (trusted + `agent.spawn` capability)
    // applies. Honours the same defaults as the kernel-trusted callers — a
    // generous 10-minute wall-clock so a long-running ticket investigation
    // completes; callers can pass `timeoutMs` to tighten. Returns the same
    // `SubRunResult` envelope the host-side `awaitResult()` returns.
    agent_awaitRun: async (runId: string, optsJson?: string): Promise<string> => {
      if (!manifest.trusted) {
        return envelopeError(
          "E_NOT_TRUSTED",
          `App "${appName}" is not trusted; agent.awaitRun refused`,
        )
      }
      try {
        requireCapability("agent.spawn")
      } catch (e) {
        return errorEnvelope(e)
      }
      const actor = bridgeOptions?.actor
      if (!actor) {
        return envelopeError("E_NO_ACTOR", "ctx.agent.awaitRun: bridge has no actor context")
      }
      const opts = optsJson
        ? (JSON.parse(optsJson) as {
            continueOnError?: boolean
            timeoutMs?: number
          })
        : {}
      const { awaitSubRunResult, markParentIfSubRunReadOutsideText } = await import(
        "~/modules/agent/subruns/subrun-await"
      )
      try {
        const result = await awaitSubRunResult(runId, actor.orgId, {
          continueOnError: opts.continueOnError ?? true,
          timeoutMs: opts.timeoutMs ?? 10 * 60 * 1000,
        })
        await markParentIfSubRunReadOutsideText(runId, actor.orgId)
        return JSON.stringify(result)
      } catch (e) {
        return errorEnvelope(e)
      }
    },

    // --- Cross-app tool invocation + system bridges ---
    //
    // Phase 17 B7 — sandbox envelope translation.
    //
    // `executeToolCore` returns the host-internal `{ data | blocked | error }`
    // shape that Mail / Tickets / etc. consume directly. The sandbox
    // contract is the K4 envelope (`{ status, result | approval_id | code }`)
    // so apps written against the spec see a single shape. Per Amendment 1
    // in the Phase 17 spec, the translation happens only at this bridge
    // boundary; the in-process callers are untouched.
    executeTool: async (targetTool: string, paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson || "{}")
      const idempotencyKey =
        typeof params?.idempotencyKey === "string" ? params.idempotencyKey : undefined
      const { executeToolCore } = await import("~/modules/apps/execute-tool")
      const env = await executeToolCore({
        toolName: targetTool,
        orgId,
        actor: inheritedActor,
        params,
        // The nested dispatch inherits the run's read-only mark across the hop
        // that lost the frame. `executeToolCore` refuses a WRITE target and lets
        // a read through, so a read-only rerun can still gather its answer from
        // another app.
        readOnlyRun: bridgeReadOnlyRun,
        // And the calling turn's scope taint, captured at construction for the
        // same reason: the guard in `executeToolCore` reads the live frame, which
        // this hop has lost, so a tainted turn's write through a sandboxed app
        // would otherwise be judged as a write from no turn at all.
        turnTaintScopes: bridgeTurnTaintScopes,
        // With the store the rows it came from live in, so a write back to a row the
        // turn read is allowed here exactly as it is in frame, and a read made here
        // files its origin into the calling turn exactly as an in-frame read does
        // (A46, A46b).
        ...(bridgeTaintOriginStore !== undefined
          ? { turnTaintOrigins: bridgeTaintOriginStore }
          : {}),
        // And WHICH AGENT is calling, for the same reason: a gated call staged
        // through this hop would otherwise record an approval nobody can trace
        // back to the agent that proposed it (A11).
        actingAgentId: bridgeActingAgentId,
        // And the calling turn's spawn frame, captured at construction for the
        // same reason: a sub-agent the nested app spawns must nest below the
        // calling run, never restart a chain at depth 0 (MAX_NESTING_DEPTH).
        spawnParentFrame: bridgeSpawnParentFrame,
        threadId: bridgeOptions?.threadId,
        callChain: bridgeOptions?.callChain ?? [],
        parentExecutionToken: bridgeOptions?.parentExecutionToken,
        taintState: bridgeOptions?.taintState ?? { taintedSources: [] },
        priority: bridgeOptions?.priority, // inherit the originating dispatch's scheduling class
        // Forward the originating dispatch's origin ACROSS THIS APP BOUNDARY, but
        // "human-ui" never crosses it: a human clicking an UNGATED tool in app A,
        // whose handler cross-calls a GATED tool in app B, must not have that
        // second, DIFFERENT action silently execute just because the click on A
        // looked like a direct human UI call. The requester only approved A.
        // Downgrade to "in-app-agent" so the cross-called tool B is gated like any
        // other non-human-attributed call (this is the fix for the class of bug
        // where absence-of-a-different-signal let a re-entrant hop read as a human
        // click; see execute-tool.ts isDirectHumanCall).
        //
        // "mcp" and "in-app-agent" forward unchanged: real, attributable re-entrant
        // provenance.
        //
        // No bridgeOptions at all (bridgeOptions.origin undefined) means this
        // dispatch never passed through a re-entrant executeToolCore call in the
        // first place — a webhook, job, or routine tick calling ctx.executeTool
        // directly from its own top-level bridge (see webhooks/routes.ts,
        // infra/jobs/jobs.ts, infra/jobs/kernel-jobs.ts, which construct
        // actorType:"user" bridges with no origin at all). That is not an agent
        // either: attribute it "system" so the resulting mutation and its
        // approval card are not falsely stamped as agent-authored.
        origin:
          bridgeOptions?.origin === "mcp"
            ? "mcp"
            : bridgeOptions?.origin === "in-app-agent"
              ? "in-app-agent"
              : bridgeOptions?.origin === "human-ui"
                ? "in-app-agent"
                : "system", // undefined or already "system": no re-entrant origin
        internalCall: {
          callerApp: appName,
          idempotencyKey,
          // This CURRENT invocation is running because a human authorized it
          // WITH THE AUTHORITY TO DO SO: either a direct human-UI outer call
          // whose clicking user holds that outer tool's own `<app>:approve`
          // scope, or a human-approved gated handler re-entry (approvalContext
          // present — decide.ts only reaches a handler after a human decided
          // it). Threaded to executeToolCore so a nested call into a tool
          // `appName`'s manifest DECLARES in `cross_app_calls` executes
          // deterministically instead of parking its own approval, which the
          // outer human never sees and which wedges the outer approval back to
          // pending on "threadId required". This flag is the narrow,
          // declared-target-only carve-out (execute-tool.ts's
          // humanAuthorizedCrossAppCall).
          //
          // NEVER re-derive the human-UI half from `origin`: a "human-ui"
          // origin on an UNGATED outer tool says only that a human clicked,
          // not that they could have approved the nested gated target. The
          // approve-scope answer lives in executeToolCore, which passes the
          // conjunction down as `bridgeOptions.humanAuthorized`.
          humanAuthorized: bridgeOptions?.humanAuthorized === true || approvalContext != null,
          humanAuthorizedVia: approvalContext != null ? "approval" : "human-ui",
          ...(approvalContext ? { outerApprovalRequestId: approvalContext.approvalRequestId } : {}),
        },
      })
      // Phase 17 B7 — Apps that opt into the K4 contract by declaring
      // `cross_app_calls[]` see the translated envelope; legacy apps
      // (Mail, Tickets) keep observing `{ data | blocked | error }` exactly
      // as `executeToolCore` returned it. Translation happens here at the
      // bridge boundary only — internal `executeToolCore` callers are
      // never affected.
      if (manifest.cross_app_calls && manifest.cross_app_calls.length > 0) {
        if ("data" in env) {
          return JSON.stringify({ status: "completed", result: env.data })
        }
        if ("blocked" in env) {
          return JSON.stringify({
            status: "pending_approval",
            approval_id: env.blocked.approvalRequestId ?? null,
          })
        }
        if ("error" in env) {
          // K4 error envelope nests the detail under `error` (see `CrossAppEnvelope`
          // in invoicing/src/cross-app.ts). Emitting the fields FLAT (the pre-fix
          // shape) meant every consumer's `env.error.{code,message}` read undefined,
          // so cross-app errors surfaced as a bare "unknown error" with the real
          // reason silently dropped ([[BL-208]]/[[BL-228]] — the boxtal draft-create
          // "transient" failures; also invoicing deferred-dispatch's "email_failed"
          // fallback). Nest it so the real code/message reaches the caller.
          return JSON.stringify({
            status: "error",
            error: {
              code: env.error.code,
              message: env.error.message,
              retryable: env.error.retryable,
            },
          })
        }
        return JSON.stringify({
          status: "error",
          error: {
            code: "internal_error",
            message: "executeTool: unknown envelope variant",
            retryable: false,
          },
        })
      }
      return JSON.stringify(env)
    },

    // Phase 17 K1 — `ctx.messages.post(p)` bridge. Capability-gated by the
    // `messages.post` manifest declaration; forwards to the kernel-side
    // `postAppMessage` helper. The bridge identity (`appName`, invoking
    // `userId`) is stamped onto the message as `author_id` + metadata
    // (`origin_app_id`, `origin_kind='app_post'`) so the read path can
    // attribute the post to its source app.
    messages_post: async (paramsJson: string): Promise<string> => {
      requireCapability("messages.post")
      try {
        // Inside the try, so the sandbox sees the refusal as its own error
        // envelope and the turn finishes with what it could read.
        refuseWriteOnReadOnlyRun(SINK_KERNEL_MESSAGES, "ctx.messages.post")
        const parsed = messagesPostParamsSchema.safeParse(JSON.parse(paramsJson || "{}"))
        if (!parsed.success) {
          const err = new Error(parsed.error.issues[0]?.message ?? "invalid params") as Error & {
            code: string
          }
          err.code = "bad_request"
          throw err
        }
        const params = parsed.data
        // The body may quote what the calling turn read, and this callback has
        // lost the turn's frame, so the scopes come from the frame captured when
        // the bridge was built (it includes this app tool's own scope). No frame
        // means no turn called the tool. A frame without an accumulator has an
        // unknown taint: fail closed to the turn's effective scope, then the
        // caller's scopes, and refuse the post when neither is known.
        let requiredScopes: string[]
        if (bridgeSpawnParentFrame === null) {
          requiredScopes = []
        } else {
          const known =
            bridgeSpawnParentFrame.taintScopes ??
            bridgeSpawnParentFrame.effectiveScope ??
            callerScopes
          if (known === undefined) {
            const err = new Error(
              "messages.post called from an agent turn whose scope taint is unknown",
            ) as Error & { code: string }
            err.code = "scope_unknown"
            throw err
          }
          requiredScopes = known
        }
        const { postAppMessage } = await import("~/modules/messages/post")
        const result = await postAppMessage(txDb, {
          requiredScopes,
          // The same captured frame the scopes came from also names the agent,
          // so the audit row records which agent's turn posted this (A11).
          agentId: bridgeActingAgentId,
          orgId,
          callingAppId: appName,
          authorUserId: userId,
          thread_id: params.thread_id,
          contact_id: params.contact_id,
          body: params.body,
          attachment_file_ids: params.attachment_file_ids,
          metadata: params.metadata,
        })
        return JSON.stringify(result)
      } catch (err) {
        // Mirror `sequences_allocate`: structured coded errors from
        // `postAppMessage` (`bad_request`, `body_too_large`, `thread_not_found`,
        // `forbidden`, `attachment_unreadable`) and the schema guard above are
        // wrapped so the sandbox sees `{ error: { code, message, retryable } }`
        // instead of a raw throw that loses `.code`.
        return errorEnvelope(err)
      }
    },
  }
}
