// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * SCRIPTING A SERVER-SIDE AGENT TURN from a browser scenario (P4c-T21b).
 *
 * Before P4c-T17 an agent scenario stubbed `**\/api/agent/chat` SSE in the
 * browser and drove the retired panel's CLIENT-side stream. The panel is gone:
 * the api dispatches the turn after `POST /threads/:id/messages` and streams
 * `agent_stream:*` frames over the websocket, so there is nothing left in the
 * browser to intercept.
 *
 * The replacement is one layer lower, on the server: the e2e lane runs with
 * `LIAISON_MODEL_PROVIDER=scripted` (set in `packages/test-helpers/src/worker-env.ts`),
 * and `scriptAgentTurn` registers the steps the model will "produce" for one
 * thread. The tool calls in those steps are executed FOR REAL through the tool
 * bridge, so a scenario still proves the tool, the permission and the world
 * data, not a fixture of them.
 *
 * Usage, per scenario:
 *   1. `const threadId = await agentDmThreadId(env, world.admin.token)`
 *   2. `await scriptAgentTurn(env, { threadId, steps: [...] })`
 *   3. drive the UI: `openAgentConversation` + `sendInConversation` (T21)
 *   4. `await waitForTurnEnd(env, { threadId, token, contains })`
 *   5. assert the rendered result in the conversation.
 *
 * WHY THE TURN END IS OBSERVED OVER THE API, NOT IN THE DOM: the only DOM
 * signal for a running turn is `AgentStateLabel`'s `[data-testid="agent-state"]`,
 * which renders NOTHING for a finished turn — so "absent" is both "done" and
 * "never started", and a scenario waiting on it passes before the turn even
 * begins. `ConversationTab` / `ThreadView` are owned by P4c-T39 right now, so no
 * `data-turn-state` attribute can be added here. The honest observable is the
 * persisted message list, polled exactly as `mail-conversations.scenario.test.ts` does.
 */
import { api, type WorkerEnv } from "@liaison/test-helpers"

/** One model round trip. Tool calls run for real; the next step sees their results. */
export interface ScriptedTurnStep {
  text?: string
  reasoning?: string
  toolCalls?: Array<{ name: string; args?: unknown }>
  delayMs?: number
  /**
   * Answer with what the MODEL WAS SHOWN: a regex source matched against this
   * step's whole serialized prompt, whose first match becomes the step's text
   * (`ECHO_MISS` when absent). Takes precedence over `text`.
   *
   * Reach for it only when the thing under test is deliberately NOT persisted
   * into `metadata.toolCalls` — decrypted mail is the case it exists for
   * (Invariant K keeps it out of `kernel.messages`, so the prompt is the only
   * observable). Anywhere else, assert the real result with `turnToolCalls`.
   */
  echo?: string
}

/** What an `echo` step emits when its pattern is nowhere in the prompt. */
export const ECHO_MISS = "ECHO_MISS"

/** Resolve (idempotently) the caller's personal-agent DM — the one conversation
 *  `openAgentConversation` brings up. `POST /threads/dm` with no `agentId`
 *  resolves the caller's own agent (P4c-T04) and returns the existing row. */
export async function agentDmThreadId(env: WorkerEnv, token: string): Promise<string> {
  const res = await api(env.serverUrl, "/api/threads/dm", { method: "POST", token, body: {} })
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`agentDmThreadId: ${res.status} ${JSON.stringify(res.body)}`)
  }
  const id = (res.body as { data?: { id?: string } }).data?.id
  if (!id) throw new Error(`agentDmThreadId: no thread id in ${JSON.stringify(res.body)}`)
  return id
}

/** Register the steps the agent's next turn(s) in `threadId` will replay. Steps
 *  are consumed in order across as many sends as the scenario makes; once they
 *  run out the thread answers a fixed short line instead of hanging. */
export async function scriptAgentTurn(
  env: WorkerEnv,
  opts: { threadId: string; steps: ScriptedTurnStep[] },
): Promise<void> {
  const res = await api(env.serverUrl, "/api/_test/agent-script", {
    method: "POST",
    body: { threadId: opts.threadId, steps: opts.steps },
  })
  if (res.status !== 200) {
    throw new Error(`scriptAgentTurn: ${res.status} ${JSON.stringify(res.body)}`)
  }
  const data = (res.body as { data?: { providerActive?: boolean } }).data
  if (data?.providerActive !== true) {
    throw new Error(
      "scriptAgentTurn: the server is not running with LIAISON_MODEL_PROVIDER=scripted — " +
        "the script would be ignored and the turn would call a real provider",
    )
  }
}

/** Register the steps every run of `routineId` replays. A routine run gets its
 *  own output thread, created by the worker after `run-now`, so the thread
 *  cannot be named in advance: the routine is. A script registered on the run
 *  thread itself still wins. */
export async function scriptRoutineRun(
  env: WorkerEnv,
  opts: { routineId: string; steps: ScriptedTurnStep[] },
): Promise<void> {
  const res = await api(env.serverUrl, "/api/_test/agent-script", {
    method: "POST",
    body: { routineId: opts.routineId, steps: opts.steps },
  })
  if (res.status !== 200) {
    throw new Error(`scriptRoutineRun: ${res.status} ${JSON.stringify(res.body)}`)
  }
  const data = (res.body as { data?: { providerActive?: boolean; routineId?: string } }).data
  if (data?.providerActive !== true || data.routineId !== opts.routineId) {
    throw new Error(
      "scriptRoutineRun: the server did not take a routine script (is it running with " +
        "LIAISON_MODEL_PROVIDER=scripted, and does its test route know routineId?)",
    )
  }
}

/** One tool call as the turn PERSISTED it — `metadata.toolCalls` on the agent
 *  message, which is where the REAL tool's real result lands. */
export interface PersistedToolCall {
  toolCallId: string
  toolName: string
  args?: unknown
  result?: unknown
  status?: string
}

interface ThreadMessage {
  id: string
  content: string | null
  authorType?: "user" | "agent" | "system"
  metadata?: { toolCalls?: PersistedToolCall[]; reasoning?: string } | null
}

async function agentMessages(
  env: WorkerEnv,
  token: string,
  threadId: string,
): Promise<ThreadMessage[]> {
  const res = await api(env.serverUrl, `/api/threads/${threadId}/messages?limit=50`, { token })
  if (res.status !== 200) return []
  const all: ThreadMessage[] = (res.body as { data?: ThreadMessage[] }).data ?? []
  return all.filter((m) => m.authorType === "agent")
}

/**
 * THE REAL TOOL RESULTS OF ONE SCRIPTED TURN.
 *
 * Only the model is scripted: each `toolCalls` step runs for real through the
 * bridge, and the turn persists the call, its arguments and its result into the
 * agent message's `metadata.toolCalls`. That persisted result is the honest
 * place to assert a tool's CONTRACT (payload caps, cross-source hits, a gated
 * call's blocked envelope) — the rendered row only proves the call happened,
 * and `ToolCallRow`'s result `<pre>` is behind `env.DEV`.
 *
 * Scoped to one turn by `contains` (the script's final text), because the DM is
 * worker-scoped and already holds earlier turns' calls. Call it AFTER
 * `waitForTurnEnd`; a turn can persist its tool calls a beat after its text, so
 * this polls for the named tool rather than reading once.
 */
export async function turnToolCalls(
  env: WorkerEnv,
  opts: {
    threadId: string
    token: string
    contains: string
    /** Wait until a call to this tool is present before returning. */
    expect?: string
    timeout?: number
  },
): Promise<PersistedToolCall[]> {
  const deadline = Date.now() + (opts.timeout ?? 30_000)
  let seen: PersistedToolCall[] = []
  while (Date.now() < deadline) {
    const messages = await agentMessages(env, opts.token, opts.threadId)
    const hit = messages.find((m) => m.content?.includes(opts.contains))
    seen = hit?.metadata?.toolCalls ?? []
    if (!opts.expect || seen.some((c) => c.toolName === opts.expect)) {
      if (seen.length > 0 || !opts.expect) return seen
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(
    `turnToolCalls: no ${opts.expect ? `${opts.expect} call` : "tool calls"} on the turn ending ` +
      `${JSON.stringify(opts.contains)} in thread ${opts.threadId}. Saw: ` +
      JSON.stringify(seen.map((c) => c.toolName)),
  )
}

/**
 * Block until the scripted turn has landed its agent reply in `threadId`.
 *
 * `contains` is the reliable form: the script's final text, so the wait cannot
 * settle on an earlier turn's reply. Without it the helper waits for the agent
 * message count to exceed `minCount` (default 0).
 *
 * Returns the matching agent message's content, so a caller can assert on it.
 */
export async function waitForTurnEnd(
  env: WorkerEnv,
  opts: { threadId: string; token: string; contains?: string; minCount?: number; timeout?: number },
): Promise<string> {
  const deadline = Date.now() + (opts.timeout ?? 60_000)
  const minCount = opts.minCount ?? 0
  let last = ""
  while (Date.now() < deadline) {
    const messages = await agentMessages(env, opts.token, opts.threadId)
    if (opts.contains) {
      const hit = messages.find((m) => m.content?.includes(opts.contains as string))
      if (hit?.content) return hit.content
    } else if (messages.length > minCount) {
      return messages[messages.length - 1]?.content ?? ""
    }
    last = messages.map((m) => m.content ?? "").join(" | ")
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(
    `waitForTurnEnd: no agent reply${opts.contains ? ` containing ${JSON.stringify(opts.contains)}` : ""} ` +
      `in thread ${opts.threadId} within the budget. Agent messages so far: ${last || "(none)"}`,
  )
}
