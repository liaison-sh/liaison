// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Subscriber for `mcp:resource:updated` events.
 *
 * Upstream MCP servers emit `notifications/resources/updated` over their
 * transport. The per-connection notification handler (Task 17) resolves each
 * notification into a list of `SubscriptionRow`s via
 * `repo.listSubscriptions(connection_id, uri)` and queues one
 * `mcp:resource:updated` event per row inside the orchestrator's privileged
 * transaction. That event lands in the outbox; this handler is the
 * `onEvent`/`subscribeToEvent` callback that fires once per queued row.
 *
 * Per spec §3.8 the routing matrix is:
 *
 *   actorType=agent  + threadId set → system-attributed message into thread
 *   actorType=user   + threadId set → ephemeral WS frame to user
 *   any              + no threadId  → info log only (freestanding subscription)
 */

import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { messages, threads } from "~/db/schema/kernel/threads"
import type { AppEvent } from "~/infra/events/event-bus"
import { getWsManager } from "~/infra/websocket"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "mcp-client/resource-notifier" })

export interface ResourceUpdatedPayload {
  connection_id: string
  uri: string
  subscriber_actor_id: string
  subscriber_actor_type: "user" | "agent"
  thread_id?: string | null
}

/** Narrowing helper so callers don't have to type-assert the event payload. */
function isResourceUpdatedPayload(d: unknown): d is ResourceUpdatedPayload {
  if (!d || typeof d !== "object") return false
  const r = d as Record<string, unknown>
  return (
    typeof r.connection_id === "string" &&
    typeof r.uri === "string" &&
    typeof r.subscriber_actor_id === "string" &&
    (r.subscriber_actor_type === "user" || r.subscriber_actor_type === "agent")
  )
}

/**
 * Sanitize an upstream-supplied URI before it is interpolated into a thread
 * message. The URI comes from an external MCP server, so it must not be able to
 * break out of its code span (backticks), inject markdown/HTML, or smuggle
 * newlines that would let it pose as separate message lines / instructions.
 */
function sanitizeUri(uri: string): string {
  return (
    uri
      // Strip backticks (code-span breakout), angle brackets (markup), and
      // double-quotes. The quote matters because the URI is interpolated into a
      // JSON literal (`{"uri":"<here>"}`) the agent is told to pass: an unescaped
      // `"` would let an upstream MCP server break out of the value and smuggle
      // extra JSON keys / instructions.
      .replace(/[`<>"]/g, "")
      // Strip ASCII control characters (newlines, tabs, CR) so the URI
      // cannot masquerade as separate message lines or instructions.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately stripping control chars from untrusted input
      .replace(/[\x00-\x1f\x7f]/g, "")
      .slice(0, 2048)
  )
}

/**
 * Construct the system message body that lands in a thread when an agent
 * subscriber's resource updates. Exported for tests + parity with the spec.
 * The upstream `uri` is sanitized — it is untrusted external input.
 */
export function buildResourceUpdatedBody(slugOrConnectionId: string, uri: string): string {
  const safeUri = sanitizeUri(uri)
  // Build the argument blob with JSON.stringify so the value is properly escaped
  // rather than string-templated into a hand-written JSON literal — this keeps the
  // URI confined to its value position even if `sanitizeUri` is ever weakened.
  const argBlob = JSON.stringify({ uri: safeUri })
  return (
    `Resource updated: \`${safeUri}\`. ` +
    `Call \`mcp:${slugOrConnectionId}:resource_read\` with \`${argBlob}\` to fetch the new content.`
  )
}

/**
 * Which subscribers one registration serves (A5). The agent route writes a
 * thread message, so it runs once, in the publishing process; the user route
 * sends to this process's sockets, so it runs in every process. `"all"` serves
 * both (a direct call).
 */
export type ResourceUpdatedMode = "agent" | "user" | "all"

export async function handleResourceUpdated(
  event: AppEvent,
  mode: ResourceUpdatedMode = "all",
): Promise<void> {
  if (!isResourceUpdatedPayload(event.data)) {
    log.warn(
      { entity: event.entity, action: event.action },
      "mcp:resource:updated dropped — payload shape mismatch",
    )
    return
  }
  const { connection_id, uri, subscriber_actor_id, subscriber_actor_type, thread_id } = event.data
  if (mode !== "all" && mode !== subscriber_actor_type) return
  const slug = (event.metadata as { slug?: string } | undefined)?.slug ?? connection_id

  if (!thread_id) {
    log.info(
      { connection_id, uri, subscriber_actor_id, subscriber_actor_type },
      "mcp:resource:updated dropped — freestanding subscription has no thread",
    )
    return
  }

  if (subscriber_actor_type === "agent") {
    if (!event.orgId) {
      log.warn({ connection_id, uri }, "mcp:resource:updated agent route missing orgId")
      return
    }
    try {
      await withSystemDb("mcp-resource-msg", async (db) => {
        await db.insert(messages).values({
          threadId: thread_id,
          orgId: event.orgId,
          authorId: subscriber_actor_id,
          authorType: "system",
          content: buildResourceUpdatedBody(slug, uri),
          metadata: {
            kind: "mcp_resource_updated",
            connectionId: connection_id,
            uri,
          },
          // No kernel data: the body is the upstream server's URI and the
          // connection slug, never the resource content (reading it is a
          // separate, gated resource_read call). The URI cannot carry what a
          // turn read either: MCP tools declare neither readOnly nor a write
          // sink, so the tool bridge refuses resource_subscribe on a tainted turn.
          requiredScopes: [],
        })
        await db.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, thread_id))
      })
    } catch (err) {
      log.error(
        { err, connection_id, uri, thread_id },
        "Failed to insert mcp:resource:updated thread message",
      )
    }
    return
  }

  // subscriber_actor_type === "user"
  const ws = getWsManager()
  if (!ws) {
    log.warn(
      { connection_id, uri, subscriber_actor_id },
      "mcp:resource:updated user route — no WebSocketManager registered",
    )
    return
  }
  try {
    await ws.broadcast({
      app: "mcp_manager",
      entity: "resource",
      action: "updated",
      orgId: event.orgId,
      entityId: connection_id,
      data: {
        connectionId: connection_id,
        uri,
        threadId: thread_id,
        subscriberUserId: subscriber_actor_id,
      },
    } as Parameters<typeof ws.broadcast>[0])
  } catch (err) {
    log.error(
      { err, connection_id, uri, subscriber_actor_id },
      "Failed to broadcast mcp:resource:updated WS frame",
    )
  }
}
