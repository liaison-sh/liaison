// SPDX-License-Identifier: FSL-1.1-ALv2
import { expandWildcardStamp } from "~/modules/agent/scopes/taint-read-scopes"
import { KERNEL_EVERY_MEMBER_SCOPES } from "~/modules/permissions/every-member-scopes"

/**
 * The scopes a failure notice carries when nothing records what the failed call
 * read (see `approvalFailureRequiredScopes`): an approval row with no
 * `proposing_turn_scopes`, a tool no longer registered, a turn gone with no
 * record. Fail closed to the requester's own scope set. Every
 * turn the requester ran had an effective scope bounded by it (runAgentChat
 * intersects with the actor's scopes), so it covers whatever that turn read.
 * Recomputing an effective scope here could under-tag, because a routine turn
 * acted as a different agent.
 */
export function failureContextRequiredScopes(requesterScopes: string[], orgId?: string): string[] {
  // A grant wildcard in that set is expanded onto the read scopes it covers, never stamped as
  // is (scope-taint.ts, rule 10b): a required `*` is covered only by the grant `*`.
  // A scope every member holds classifies no data, so it narrows no reader (taint-read-scopes.ts).
  return [...new Set(expandWildcardStamp(requesterScopes, orgId))]
    .filter((scope) => !KERNEL_EVERY_MEMBER_SCOPES.includes(scope))
    .sort()
}

/** Re-invoke the agent on the originating thread after a bundle failure. Posts
 *  the structured failure context as a user message, then invokes the agent so
 *  it can complete the outstanding work. Mirrors the routine `agentInvoker`
 *  lazy-import pattern to avoid a job-module → agent-service import cycle. */
export async function runAgentReinvoke(payload: {
  orgId: string
  threadId: string
  bundleId: string
  requesterId: string
  context: string
  /**
   * The agent whose turn proposed the bundle that failed (A11), read off the
   * approval row at the enqueue site because this job runs outside that turn's
   * frame. Absent on a job enqueued BEFORE this field existed: that records no
   * agent, which is the honest answer there, and the audit row still lands.
   */
  agentId?: string | null
}): Promise<void> {
  const { sql: drizzleSql, eq, and } = await import("drizzle-orm")
  const { withRlsContext } = await import("~/db/rls")
  const { sendMessage } = await import("~/modules/threads/message")
  const { invokeAgentForThread } = await import("~/modules/agent/runtime/agent-service")
  const { loadEffectivePermissions } = await import("~/modules/permissions/permissions")
  const { withPrivilegedDb } = await import("~/db/privileged")
  const { bundleFailureRequiredScopes } = await import("~/modules/approvals/result-notice")
  const { messages } = await import("~/db/schema/kernel")

  // Idempotency guard (I-REL-10). The enqueue dedups concurrent jobs by jobId,
  // but a BullMQ retry — or a stale re-enqueue after the job was removed — could
  // re-post the failure prompt and re-invoke the agent (double-charging credits).
  // The reinvoke message is stamped with `{ type: 'bundle-reinvoke', bundleId }`;
  // if one already exists for this bundle we have already reinvoked, so no-op.
  const [existing] = await withPrivilegedDb(payload.orgId, "reinvoke-dedup", (pdb) =>
    pdb
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.threadId, payload.threadId),
          drizzleSql`${messages.metadata} ->> 'type' = 'bundle-reinvoke'`,
          drizzleSql`${messages.metadata} ->> 'bundleId' = ${payload.bundleId}`,
        ),
      )
      .limit(1),
  )
  if (existing) {
    return
  }

  const perms = await withPrivilegedDb(payload.orgId, "reinvoke-perms", (pdb) =>
    loadEffectivePermissions(pdb, payload.requesterId, payload.orgId),
  )

  // A7: a bundle proposed by a turn answering in a REPLY THREAD carries that
  // root on its approval rows (execute-tool), and the failure context goes
  // back into the same reply thread, so the healing turn answers there too
  // (it reads its root off this message).
  const { approvalRequests } = await import("~/db/schema/kernel")
  const [bundleRow] = await withPrivilegedDb(payload.orgId, "reinvoke-reply-root", (pdb) =>
    pdb
      .select({
        replyRootId: drizzleSql<string | null>`${approvalRequests.metadata}->>'replyRootId'`,
      })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.orgId, payload.orgId),
          eq(approvalRequests.originatingThreadId, payload.threadId),
          drizzleSql`(${approvalRequests.bundleId} = ${payload.bundleId} OR ${approvalRequests.id} = ${payload.bundleId})`,
          drizzleSql`${approvalRequests.metadata}->>'replyRootId' IS NOT NULL`,
        ),
      )
      .limit(1),
  )
  const replyRootId = bundleRow?.replyRootId ?? null

  const requiredScopes = await withPrivilegedDb(payload.orgId, "reinvoke-stamp", (pdb) =>
    bundleFailureRequiredScopes(pdb, {
      orgId: payload.orgId,
      bundleId: payload.bundleId,
      requesterScopes: perms.scopes,
    }),
  )

  let messageId = ""
  await withRlsContext(
    {
      actorType: "user",
      userId: payload.requesterId,
      orgId: payload.orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
    },
    async (tx) => {
      const msg = await sendMessage(tx, {
        requiredScopes,
        threadId: payload.threadId,
        userId: payload.requesterId,
        orgId: payload.orgId,
        content: payload.context,
        // Nobody is at the keyboard on a re-invocation: the agent carried from
        // the failed turn is the only attribution the audit row can have (A11),
        // the same shape the routine tick uses. An absent value records null,
        // never the requester's id and never a freshly resolved agent.
        agentId: payload.agentId ?? null,
        metadata: { type: "bundle-reinvoke", bundleId: payload.bundleId },
        replyRootId,
      })
      if (!msg) {
        throw new Error(
          `agent-reinvoke sendMessage returned null — requester ${payload.requesterId} not a participant of thread ${payload.threadId}`,
        )
      }
      messageId = msg.id
    },
  )

  // invokeAgentForThread REQUIRES a non-optional actor — it does a participant
  // lookup keyed on actor.userId. Pass the real requester actor.
  await invokeAgentForThread(
    payload.threadId,
    messageId,
    {
      userId: payload.requesterId,
      orgId: payload.orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
    },
    payload.orgId,
    true, // background: agent re-invocation is a BullMQ-driven job
    undefined, // budget — default
    undefined, // routineId — not a routine tick
    undefined, // seedDiscoveredTools — lean start
    // Anchor history at the failure-context message: it is self-contained (step
    // outcomes + instructions), and the un-anchored routine-thread history has
    // measured OVER the model context window, 400ing the healing turn.
    true,
  )
}

/**
 * The asking agent's turn after its scope request was decided
 * (scope-requests/announce.ts). The decision line is already in the thread;
 * this answers it, AS the agent that asked (`actingAgentId`), for the person
 * whose conversation it is, so the turn's scope is that agent's freshly
 * widened ceiling floored by the room exactly as their next typed message
 * would get it. The line itself tells the agent to offer and wait, not act
 * (system-event-replay.ts).
 *
 * Same funnel as the bundle re-invocation above and the routine tick: a
 * background `invokeAgentForThread`, whose reply is persisted, broadcast and
 * notified like any agent reply. Skipped when the agent has already spoken
 * in the thread since the line (this job ran, or the person wrote first and
 * the agent answered with the line in its history): a second turn would only
 * repeat it. Skipped too when the line is gone.
 */
export async function runScopeDecisionTurn(payload: {
  orgId: string
  threadId: string
  messageId: string
  requesterId: string
  agentId: string
}): Promise<void> {
  const { eq, and, gt, or } = await import("drizzle-orm")
  const { invokeAgentForThread } = await import("~/modules/agent/runtime/agent-service")
  const { loadEffectivePermissions } = await import("~/modules/permissions/permissions")
  const { withPrivilegedDb } = await import("~/db/privileged")
  const { messages } = await import("~/db/schema/kernel")

  const { answered, perms } = await withPrivilegedDb(
    payload.orgId,
    "scope-decision-turn-read",
    async (pdb) => {
      const [line] = await pdb
        .select({ createdAt: messages.createdAt })
        .from(messages)
        .where(and(eq(messages.id, payload.messageId), eq(messages.orgId, payload.orgId)))
        .limit(1)
      // Answered already: the agent has spoken since the line, or the person
      // wrote since it. A message typed after the line starts its own turn,
      // which replays the line as an event and answers it; a second, background
      // turn on top of it announced the same grant twice.
      const [reply] = line
        ? await pdb
            .select({ id: messages.id })
            .from(messages)
            .where(
              and(
                eq(messages.threadId, payload.threadId),
                eq(messages.orgId, payload.orgId),
                gt(messages.createdAt, line.createdAt),
                or(
                  and(
                    eq(messages.authorType, "agent"),
                    eq(messages.authorAgentId, payload.agentId),
                  ),
                  and(eq(messages.authorType, "user"), eq(messages.authorId, payload.requesterId)),
                ),
              ),
            )
            .limit(1)
        : []
      return {
        answered: !line || Boolean(reply),
        perms: await loadEffectivePermissions(pdb, payload.requesterId, payload.orgId),
      }
    },
  )
  if (answered) return

  await invokeAgentForThread(
    payload.threadId,
    payload.messageId,
    {
      userId: payload.requesterId,
      orgId: payload.orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
    },
    payload.orgId,
    true, // background: a BullMQ-driven turn, nobody at the keyboard
    undefined, // budget: default
    undefined, // routineId: not a routine tick
    undefined, // seedDiscoveredTools: lean start
    false, // anchorHistory: the agent needs the conversation it asked from
    payload.agentId,
  )
}
