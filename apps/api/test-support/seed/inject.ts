// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Two injections for tests that stage what a live path would deliver:
//
// - `injectInboundMail` runs the REAL tickets inbound matcher
//   (`processInboundMessage`) on a synthetic email, so a run exercises
//   mail-to-ticket at volume without the Gmail push path. The caller
//   namespaces `messageId` so teardown and invariants can scope its deliveries.
// - `injectThreadMessage` writes one message with the author type and metadata
//   the test names (a sub-run card, say); an agent's message speaks as the
//   org's base agent unless the test names another, or, with `speaker:
//   "runtime"`, as the agent the reply path itself would name
//   (`resolveActingAgentIdForWrite`). The product's message post is user-only
//   and strips both, so the row goes in privileged, scoped to the org. Its tag
//   defaults to the one a cleanly ended turn that made no tool call writes
//   (`turnEndRequiredScopes`: none), unless the test names a scoped turn's.
//   `createdAt` places it in the thread's past (HISTORY: the time a message
//   was posted, which no writer takes).
import { and, eq, sql } from "drizzle-orm"
import { processInboundMessage } from "~/apps/tickets/inbound"
import { ticketsRel } from "~/apps/tickets/schema-refs"
import { withPrivilegedDb } from "~/db/privileged"
import { messages, threads } from "~/db/schema/kernel"
import { turnEndRequiredScopes } from "~/modules/agent/runtime/agent-service"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { resolveActingAgentIdForWrite } from "~/modules/threads/message"
import type { SeedContext } from "~/seed/context"
import { seedBaseAgent } from "~/seed/factories/agent/agents"
import { rowsOf } from "~/seed/factories/people/actors"

export interface InboundMailInput {
  fromEmail: string
  fromName?: string
  subject: string
  textBody: string
  /** Stable external id of the delivery. */
  messageId: string
  /** The inbox it reaches; default the org's oldest. */
  inboxId?: string
}

/** The matcher's outcome (`created` / `appended` / `dropped` / `rerouted` with ids); `dropped: no_inbox` when the org has none. */
export async function injectInboundMail(ctx: SeedContext, input: InboundMailInput) {
  const { orgId } = ctx
  return withPrivilegedDb(orgId, "seed-route:inbound-mail", async (tx) => {
    const [inbox] = rowsOf<{ id: string; org_id: string; email_address: string }>(
      await tx.execute(
        sql`SELECT id, org_id, email_address FROM ${ticketsRel("inboxes")}
            WHERE org_id = ${orgId}
              ${input.inboxId ? sql`AND id = ${input.inboxId}` : sql``}
            ORDER BY created_at LIMIT 1`,
      ),
    )
    if (!inbox) return { outcome: "dropped", reason: "no_inbox" } as const
    const parsed = {
      messageId: input.messageId,
      from: { email: input.fromEmail, name: input.fromName },
      to: [{ email: inbox.email_address }],
      subject: input.subject,
      textBody: input.textBody,
      inReplyTo: null,
      headers: { "x-liaison-chaos-synthetic": "1" },
      receivedAt: ctx.now.toISOString(),
    }
    // Seeded mail never acknowledges its (fictional) sender.
    return processInboundMessage(parsed as never, inbox as never, {
      db: tx as never,
      orgId,
      noAcknowledgement: true,
    })
  })
}

export interface ThreadMessageInput {
  threadId: string
  /** The person recorded as author (a member of the org). */
  authorId: string
  content: string
  authorType: "user" | "agent" | "system"
  metadata?: Record<string, unknown>
  /** The speaking agent of an `agent` message; default the org's base agent. */
  authorAgentId?: string
  /** `runtime`: an `agent` message speaks as the agent the reply path would name. */
  speaker?: "base" | "runtime"
  /** Who may read it; default the tag a clean, tool-free turn writes. */
  requiredScopes?: string[]
  /** When it was posted (ISO); default now. */
  createdAt?: string
}

/**
 * The tag a seeded conversational agent reply carries when the test names
 * none: the runtime's own rule for a turn that made no tool call
 * (`turnEndRequiredScopes` on an empty accumulator), the empty set. Pinned against the runtime by
 * `modules/threads/thread-seed-runtime-parity.test.ts`.
 */
export function defaultAgentReplyRequiredScopes(): string[] {
  return turnEndRequiredScopes({
    accumulator: createTurnScopeAccumulator(),
    requesterScopes: [],
  })
}

/** The agent the reply path names for an agent-authored write by `userId` (its own rule). */
export async function speakingAgentIdFor(orgId: string, userId: string): Promise<string> {
  const id = await withPrivilegedDb(orgId, "seed-route:thread-message-speaker", (tx) =>
    resolveActingAgentIdForWrite(tx as never, {
      orgId,
      userId,
      authorType: "agent",
      agentId: null,
    }),
  )
  if (!id) throw new Error(`thread message: no agent speaks for ${userId} in org ${orgId}`)
  return id
}

/** The new message's id; throws when the thread is not the org's. */
export async function injectThreadMessage(
  ctx: SeedContext,
  input: ThreadMessageInput,
): Promise<{ id: string }> {
  const { orgId } = ctx
  const [found] = await withPrivilegedDb(orgId, "seed-route:thread-message-lookup", (tx) =>
    tx
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.id, input.threadId), eq(threads.orgId, orgId)))
      .limit(1),
  )
  if (!found) throw new Error(`thread ${input.threadId} not found in the org`)
  const authorAgentId =
    input.authorType === "agent"
      ? (input.authorAgentId ??
        (input.speaker === "runtime"
          ? await speakingAgentIdFor(orgId, input.authorId)
          : (await seedBaseAgent(orgId)).agentId))
      : null
  const [msg] = await withPrivilegedDb(orgId, "seed-route:thread-message", (tx) =>
    tx
      .insert(messages)
      .values({
        threadId: input.threadId,
        orgId,
        authorId: input.authorId,
        authorType: input.authorType,
        content: input.content,
        metadata: input.metadata ?? null,
        authorAgentId,
        requiredScopes: input.requiredScopes ?? defaultAgentReplyRequiredScopes(),
        ...(input.createdAt ? { createdAt: new Date(input.createdAt) } : {}),
      })
      .returning({ id: messages.id }),
  )
  if (!msg) throw new Error("thread message not written")
  return { id: msg.id }
}
