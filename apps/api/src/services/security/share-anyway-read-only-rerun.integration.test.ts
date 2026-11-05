// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Share anyway rerun answers, it does not act (spec-security.md D4, FX7).
//
// A withheld turn that SENT MAIL and is then shared must not send that mail
// again: the requester asked to see an answer they were denied, not to have the
// turn's side effects repeated. So the rerun runs with a read-only catalog --
// every tool that is not `readOnly` is left out, and one called anyway comes
// back refused rather than executed -- while the disclosed answer is still
// written with its disclosure list and is still visible to the requester.
//
// The model is a scripted stream stub; everything else (tool catalog, scope
// accumulator, persistence, RLS) is the real code path.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import type { RlsClient } from "~/db"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { messages, threadParticipants, threads } from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import { AgentServiceTestAccess, invokeAgentForThread } from "~/modules/agent/runtime/agent-service"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import * as toolBridgeModule from "~/modules/agent/tools/tool-bridge"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { sendMessage } from "~/modules/threads/message"
import * as minimal from "~/seed/tiers/minimal"
import { shareAnyway } from "~/services/security/share-anyway"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const MODEL_ID = "claude-haiku-4-5-share-anyway-read-only"
const APP = "rqo"
const READ = `${APP}:alpha:read`
const MAIL = `${APP}:mail:send`
const CEILING = [READ, MAIL]

/** Every send the mail-ish write tool performed, across the whole file. */
const mailsSent: string[] = []
/** Tools the model tried to call that its catalog did not hold. */
const absentToolCalls: string[] = []

type ScriptedTurn = { calls: string[]; text: string }
const script: ScriptedTurn[] = []

function scriptedStreamText(opts: {
  tools?: Record<string, { execute?: (args: unknown) => Promise<unknown> }>
}) {
  const turn = script.shift() ?? { calls: [], text: "ok" }
  return {
    fullStream: (async function* () {
      for (const [i, toolName] of turn.calls.entries()) {
        const toolDef = opts.tools?.[toolName]
        const toolCallId = `call-ro-${i}`
        yield { type: "tool-call", toolCallId, toolName, input: {} }
        // A tool the catalog does not hold is RECORDED, not thrown. A model
        // knows tool names from the system prompt and will call one it was not
        // given, which is the case that matters here: the rerun must neither
        // execute it nor die, but finish with the answer it can produce.
        if (!toolDef?.execute) {
          absentToolCalls.push(toolName)
          yield {
            type: "tool-result",
            toolCallId,
            toolName,
            input: {},
            output: { ok: false, reason: "tool_not_in_catalog" },
          }
          continue
        }
        const output = await toolDef.execute({})
        yield { type: "tool-result", toolCallId, toolName, input: {}, output }
      }
      yield { type: "text-delta", text: turn.text }
      yield {
        type: "finish-step",
        usage: { inputTokens: 10, outputTokens: 1 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  }
}

describe("the Share anyway rerun runs no write tools", () => {
  let orgId: string
  let requester: string // holds READ and MAIL
  let roomMate: string // holds MAIL only, so the room floor withholds READ
  let agentId: string
  let threadId: string
  let turnId = ""

  async function userWith(scopes: string[]): Promise<string> {
    const user = await minimal.person(orgId)
    await minimal.revokeRole(user.id, "member")
    for (const scope of scopes) await minimal.grantScope(user.id, scope)
    return user.id
  }

  async function actorFor(userId: string): Promise<UserContext> {
    const { scopes } = await withPrivilegedDb(orgId, "test-share-anyway-ro-actor", (tx) =>
      loadEffectivePermissions(tx, userId, orgId),
    )
    return { actorType: "user", userId, orgId, scopes, dimensionGrants: {} }
  }

  async function visibleIds(userId: string): Promise<string[]> {
    return withRlsContext(await actorFor(userId), async (tx) =>
      (
        await tx.select({ id: messages.id }).from(messages).where(eq(messages.threadId, threadId))
      ).map((r) => r.id),
    )
  }

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    AgentServiceTestAccess.setStreamText(scriptedStreamText as never)
    orgId = (await createTestOrg()).id

    // A read tool and a WRITE tool. The write declares its table exactly as the
    // T29/X3 marker requires; the read declares itself readOnly.
    toolRegistry.set([orgId, APP, "alphaTool"], {
      appName: APP,
      name: "alphaTool",
      description: "Read the deal",
      requiredScopes: [READ],
      readOnly: true,
      handler: async () => ({ deal: "42" }),
      params: z.object({}),
    })
    toolRegistry.set([orgId, APP, "sendMail"], {
      appName: APP,
      name: "sendMail",
      description: "Send a mail (a real side effect)",
      requiredScopes: [MAIL],
      writesToTable: "app_mail.messages",
      handler: async () => {
        mailsSent.push(new Date().toISOString())
        return { sent: true }
      },
      params: z.object({}),
    })

    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${orgId}, '10.00000000', '0', 'EUR')
      ON CONFLICT (org_id) DO UPDATE SET included_balance = '10.00000000'`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', ${MODEL_ID}, 'Claude Haiku Read Only', '1.00', '5.00', 200000, true, 'starter')
      ON CONFLICT DO NOTHING`

    requester = await userWith([READ, MAIL])
    roomMate = await userWith([MAIL])
    agentId = await withPrivilegedDb(orgId, "test-share-anyway-ro-agent", async (tx) => {
      // The requester's own personal agent (registration made it), capped to
      // the ceiling: the agent a channel turn resolves for them.
      const [a] = await tx
        .update(agents)
        .set({ scopeCeiling: CEILING })
        .where(and(eq(agents.ownerUserId, requester), eq(agents.kind, "personal")))
        .returning({ id: agents.id })
      if (!a) throw new Error("the requester has no personal agent")
      return a.id
    })
    threadId = await withPrivilegedDb(orgId, "test-share-anyway-ro-thread", async (tx) => {
      const [t] = await tx
        .insert(threads)
        .values({
          orgId,
          handle: `readonly-${crypto.randomUUID().slice(0, 8)}`,
          type: "thread",
          createdBy: requester,
        })
        .returning({ id: threads.id })
      for (const userId of [requester, roomMate]) {
        await tx.insert(threadParticipants).values({ threadId: t.id, userId, orgId })
      }
      return t.id
    })
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([orgId, APP])
    AgentServiceTestAccess.setStreamText()
    await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${MODEL_ID}`
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await releaseTestLock()
  })

  test("the original withheld turn sends the mail: the side effect really happened", async () => {
    turnId = await withPrivilegedDb(orgId, "test-share-anyway-ro-post", async (tx) => {
      const msg = await sendMessage(tx as unknown as RlsClient, {
        requiredScopes: [],
        orgId,
        userId: requester,
        threadId,
        content: "@Liaison mail the summary and tell me the deal",
        authorType: "user",
      })
      if (!msg) throw new Error("could not post into the test thread")
      return msg.id
    })
    script.push({
      calls: [`${APP}__sendMail`],
      text: "Mailed the summary. I could not read the deal here.",
    })

    const outcome = await invokeAgentForThread(threadId, turnId, await actorFor(requester), orgId)

    // The room floor is ceiling ∩ every member: roomMate lacks READ, so the
    // turn could send mail but not read the deal.
    expect(mailsSent).toHaveLength(1)
    expect((outcome.withheldCapabilities ?? []).length).toBeGreaterThan(0)
  })

  test("Share anyway reruns with a read-only catalog: no second mail, and the answer is still disclosed", async () => {
    const mailsBefore = mailsSent.length
    const absentBefore = absentToolCalls.length
    // The rerun TRIES to send the mail again, exactly as the original turn did.
    // Without the read-only catalog it would succeed and the requester's ask to
    // SEE an answer would have posted a second mail.
    script.push({
      calls: [`${APP}__sendMail`, `${APP}__alphaTool`],
      text: "The deal is 42.",
    })
    const buildSpy = spyOn(toolBridgeModule, "buildToolSet")
    let messageIds: string[]
    let rerunCatalog: Record<string, unknown> = {}
    let rerunFrame: RunContext | undefined
    try {
      ;({ messageIds } = await shareAnyway(await actorFor(requester), {
        turnId,
        requesterId: requester,
        roomId: threadId,
        agentId,
      }))
      rerunFrame = buildSpy.mock.calls[0]?.[5]
      rerunCatalog = (buildSpy.mock.results[0]?.value ?? {}) as Record<string, unknown>
    } finally {
      buildSpy.mockRestore()
    }

    // THE POINT: the turn sent mail the first time and sends none the second,
    // even though the rerun asked for it.
    expect(mailsSent).toHaveLength(mailsBefore)
    expect(absentToolCalls.slice(absentBefore)).toEqual([`${APP}__sendMail`])

    // The rerun's catalog holds the read tool and not the write tool.
    expect(rerunFrame?.readOnlyTools).toBe(true)
    const appTools = Object.keys(rerunCatalog)
      .filter((n) => n.startsWith(`${APP}__`))
      .sort()
    expect(appTools).toEqual([`${APP}__alphaTool`])

    // The disclosed answer is still written, still tagged, still disclosed.
    expect(messageIds).toHaveLength(1)
    const sharedId = messageIds[0] ?? ""
    const [row] = await sql<
      { content: string; required_scopes: string[]; disclosure_list: string[] | null }[]
    >`SELECT content, required_scopes, disclosure_list FROM kernel.messages WHERE id = ${sharedId}`
    expect(row?.content).toBe("The deal is 42.")
    expect(row?.required_scopes).toEqual([READ])
    expect([...(row?.disclosure_list ?? [])].sort()).toEqual([requester, roomMate].sort())

    // And the requester can actually read it through the real messages RLS.
    expect(await visibleIds(requester)).toContain(sharedId)
  })

  test("a write tool called during a read-only run is refused, not executed", async () => {
    const mailsBefore = mailsSent.length
    const rootRunId = crypto.randomUUID()
    const frame: RunContext = {
      runId: rootRunId,
      parentRunId: null,
      rootRunId,
      nestingDepth: 0,
    }
    // Built WITHOUT the read-only mark, so the write tool is in the catalog:
    // this is the blind-call / late-marked-frame case the bridge still refuses.
    const tools = buildToolSet(
      orgId,
      await actorFor(requester),
      threadId,
      ALL_DEFERRED_TOOLS_UNLOCKED,
      "agent",
      frame,
    )
    expect(Object.keys(tools)).toContain(`${APP}__sendMail`)

    frame.readOnlyTools = true
    const result = await tools[`${APP}__sendMail`].execute({}, {})

    // Surfaced as a tool RESULT, the way a scope-taint refusal is, so the turn
    // finishes with the answer it can produce instead of failing silently.
    expect(result).toEqual({
      ok: false,
      code: "E_READ_ONLY_RUN_BLOCKED",
      message: expect.stringContaining("NOT EXECUTED"),
      writeTargetTable: "app_mail.messages",
      reason: "read_only_run_blocked",
    })
    expect(mailsSent).toHaveLength(mailsBefore)
  })
})
