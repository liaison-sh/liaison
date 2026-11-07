// SPDX-License-Identifier: FSL-1.1-ALv2
import { generateText } from "ai"
import { and, eq, isNull, or } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { threads } from "~/db/schema/kernel"
import { isManagedEdition } from "~/lib/edition"
import { offlineSideCalls } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import {
  meterSideCall,
  type PreCheckResult,
  preCheck,
  resolveUnmeteredSideCall,
  selectSideCallModelForOrg,
} from "~/modules/agent/credits/credit-meter"
import { resolveSideCallModel } from "~/modules/agent/providers/side-call-model"
import { isReservedDemoOrg, isVisitorDemoOrg } from "~/modules/demo/demo-spend"

const log = rootLogger.child({ module: "auto-title" })

/**
 * Auto-generate a title for an agent chat thread using the cheapest available LLM.
 * Called fire-and-forget after the first agent reply completes.
 */
export async function autoTitleAgentChat(params: {
  threadId: string
  userMessage: string
  agentReply: string
  orgId: string
  /**
   * The agent whose turn this title follows (A11). Passed EXPLICITLY because
   * this runs fire-and-forget after the turn, outside every run frame: there
   * is nothing here to read an identity from, and the caller is the last place
   * that still knows it. `null` is a positive "no agent acted".
   */
  agentId?: string | null
}) {
  const { threadId, userMessage, agentReply, orgId } = params

  const [thread] = await withPrivilegedDb(orgId, "auto-title-agent-chat-read", (tx) =>
    tx
      .select({ title: threads.title, type: threads.type })
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.orgId, orgId)))
      .limit(1),
  )
  if (!thread || thread.type !== "agent_chat" || thread.title) return

  // The model call runs with no transaction open: it takes its own privileged
  // reads (the model settings), and a slot held across a provider round trip
  // starves the pool.
  const title = await generateTitleWithLLM(orgId, userMessage, agentReply)
  if (!title) return

  await withPrivilegedDb(orgId, "auto-title-agent-chat", async (tx) => {
    // Only a thread still untitled: a title set meanwhile (by hand, or by a
    // concurrent turn) wins.
    const updated = await tx
      .update(threads)
      .set({ title, updatedAt: new Date() })
      .where(
        and(
          eq(threads.id, threadId),
          eq(threads.orgId, orgId),
          or(isNull(threads.title), eq(threads.title, "")),
        ),
      )
      .returning({ id: threads.id })
    if (updated.length === 0) return

    // F2 — the auto-title is a DURABLE state transition: the thread's title
    // changed in the DB, so the WS notification must survive a crash and replay
    // on reconnect (a client that closed its laptop during the first agent reply
    // would otherwise never see the title). Queue it on the transactional outbox
    // (tx.queueEvent) instead of a fire-and-forget broadcastEphemeral. Frame shape
    // is unchanged, so the existing `thread:update` WS handler applies it verbatim.
    await tx.queueEvent({
      app: "kernel",
      entity: "thread",
      action: "update",
      entityId: threadId,
      orgId,
      actorId: "system",
      actorType: "system",
      agentId: params.agentId ?? null,
      data: { id: threadId, type: "agent_chat", changes: { title } },
    })
  })
}

async function generateTitleWithLLM(
  orgId: string,
  userMessage: string,
  agentReply: string,
): Promise<string> {
  // A reserved demo org titles its chats by heuristic: a title is not worth a
  // share of the spend ceiling that org lives under. No query on a normal
  // deployment.
  if (await isReservedDemoOrg(orgId)) return heuristicTitle(userMessage)
  // A demo VISITOR org reaches the box key only through a reservation, and
  // this side call has none: its title comes from the first message too.
  if (await isVisitorDemoOrg(orgId)) return heuristicTitle(userMessage)
  // A test server on placeholder keys calls no provider (see offlineSideCalls).
  if (offlineSideCalls()) return heuristicTitle(userMessage)

  const cheapModel = await selectSideCallModelForOrg(orgId, "auto-title-model")
  if (!cheapModel) {
    log.warn({ orgId }, "No auto-eligible model — falling back to heuristic title")
    return heuristicTitle(userMessage)
  }

  // Managed: metered like every side call (`meterSideCall`), the title is a
  // billed call of the org's allowance, and the pre check refuses it (heuristic
  // title) while the org has no credits or payment is required. Self-hosted:
  // no credits, so the call runs on the org's key as it always did, with no
  // pre check that could refuse it.
  let creditCheck: Extract<PreCheckResult, { allowed: true }> | null = null
  let unmetered: Awaited<ReturnType<typeof resolveUnmeteredSideCall>> | null = null
  if (isManagedEdition()) {
    const checked = await preCheck(orgId, cheapModel.modelId)
    if (!checked.allowed) {
      log.warn(
        { orgId, provider: cheapModel.provider, reason: checked.reason },
        "Auto-title model call refused — falling back to heuristic",
      )
      return heuristicTitle(userMessage)
    }
    creditCheck = checked
  } else {
    try {
      unmetered = await resolveUnmeteredSideCall(orgId, cheapModel.modelId)
    } catch (err) {
      log.warn(
        { err, orgId, provider: cheapModel.provider, modelId: cheapModel.modelId },
        "No model or key for auto-title — falling back to heuristic",
      )
      return heuristicTitle(userMessage)
    }
  }

  const truncatedUser = userMessage.slice(0, 500)
  const truncatedReply = agentReply.slice(0, 500)

  let usage: unknown = null
  let providerMetadata: unknown
  let result: Awaited<ReturnType<typeof generateText>>
  try {
    const credit = creditCheck ?? unmetered
    if (!credit) return heuristicTitle(userMessage)
    const model = await resolveSideCallModel(credit)
    result = await generateText({
      model,
      system:
        "Generate a short chat title (3-8 words, no quotes, no punctuation at the end). The title should capture what the conversation is about. Return ONLY the title, nothing else.",
      messages: [
        {
          role: "user" as const,
          content: `User: ${truncatedUser}\n\nAssistant: ${truncatedReply}`,
        },
      ],
    })
    usage = result.usage ?? {}
    providerMetadata = result.providerMetadata
  } finally {
    if (creditCheck) await meterSideCall(orgId, creditCheck, usage, providerMetadata)
  }

  let title = result.text.trim()
  // Strip wrapping quotes if the model adds them
  if (
    (title.startsWith('"') && title.endsWith('"')) ||
    (title.startsWith("'") && title.endsWith("'"))
  ) {
    title = title.slice(1, -1)
  }
  if (title.length > 60) {
    title = `${title.slice(0, 57)}...`
  }
  return title || heuristicTitle(userMessage)
}

/** Last-resort fallback when no LLM is available */
function heuristicTitle(content: string): string {
  let title = content.split("\n")[0].trim()
  const sentenceEnd = title.search(/[.!?]\s/)
  if (sentenceEnd > 0 && sentenceEnd < 80) {
    title = title.slice(0, sentenceEnd + 1)
  }
  if (title.length > 60) {
    title = `${title.slice(0, 57)}...`
  }
  return title
}
