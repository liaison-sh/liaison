// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * TELLING THE CONVERSATION WHAT WAS PICKED.
 *
 * The agent shows the picker card (`kernel__drive_picker`) and ends its turn
 * ("choose the file there"). When the person picks, the conversation the card
 * came from gets what a completed connect card gets (secret-requests/announce.ts):
 *
 *  1. A system line (`metadata.type = 'drive-picker-result'`) naming what was
 *     picked. The agent's transcript replays it as a fact with the files'
 *     Drive ids (system-event-replay.ts), so it reads them in one call.
 *  2. ONE turn of the agent that showed the card, off that line, so it carries
 *     on with what the person asked for.
 *
 * Where the card came from is never read from the browser: the tool call mints
 * an origin (this module, in Redis) bound to the person, the conversation and
 * the agent, and the card only hands its id to the picker ticket. A pick saved
 * under a ticket of another person or workspace, or after the origin expired,
 * announces nothing. Picks made from Settings or Knowledge carry no origin and
 * post nowhere. The line also records the card's origin and every picked id:
 * the card lists "picked here" from it (cardPickIds), so picks stay
 * account-wide and the card needs no record of its own. Best effort, after the picks were saved: a failure is logged,
 * never turned into a failed save.
 */
import { randomBytes } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import type { PickedItem } from "~/apps/google-drive/drive-mode"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { messages } from "~/db/schema/kernel"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { appsLogger as log } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { loadUserName } from "~/modules/approvals/event-data"
import { type FollowUpTurnPayload, runFollowUpTurn } from "~/modules/secret-requests/announce"
import { sendMessage } from "~/modules/threads/message"

/** How long a card shown in a conversation still announces its picks. */
const ORIGIN_TTL_SECONDS = 24 * 60 * 60
const originKey = (id: string) => `drive-picker:origin:${id}`
const turnKey = (messageId: string) => `drive-picker:turn:${messageId}`

export const PICK_ORIGIN_RE = /^[A-Za-z0-9_-]{32,64}$/

/** The job that runs the agent's turn off the pick line. */
export const DRIVE_PICKER_TURN_JOB = "drive-picker-turn"

/** The most picked items one line names; the rest are counted. */
const LINE_ITEMS_MAX = 20

/** Scopes a reader of the line holds: it names files of the person's Drive. */
const LINE_SCOPES = ["google-drive:accounts:read"]

export interface PickOrigin {
  orgId: string
  userId: string
  threadId: string
  agentId: string | null
}

/** A card shown in a conversation: where its picks are announced. */
export async function createPickOrigin(origin: PickOrigin): Promise<string> {
  const id = randomBytes(24).toString("base64url")
  await redis.set(originKey(id), JSON.stringify(origin), "EX", ORIGIN_TTL_SECONDS)
  return id
}

async function readPickOrigin(id: string): Promise<PickOrigin | null> {
  if (!PICK_ORIGIN_RE.test(id)) return null
  const raw = await redis.get(originKey(id))
  if (!raw) return null
  try {
    return JSON.parse(raw) as PickOrigin
  } catch {
    return null
  }
}

/** The line, in plain words: who picked what. */
export function drivePickLineContent(byName: string, items: readonly PickedItem[]): string {
  const names = items.slice(0, LINE_ITEMS_MAX).map((i) => i.name)
  const more = items.length > LINE_ITEMS_MAX ? ` and ${items.length - LINE_ITEMS_MAX} more` : ""
  const what = items.length === 1 ? "1 item" : `${items.length} items`
  return `${byName} picked ${what} in Google Drive: ${names.join(", ")}${more}.`
}

/**
 * Post the pick line in the conversation the card came from, as the person who
 * picked, and enqueue the turn of the agent that showed the card.
 */
export async function announcePicks(
  who: {
    orgId: string
    userId: string
    scopes: string[]
    dimensionGrants: Record<string, string[]>
  },
  originId: string,
  items: readonly PickedItem[],
): Promise<{ messageId: string | null; turnEnqueued: boolean }> {
  try {
    if (items.length === 0) return { messageId: null, turnEnqueued: false }
    const origin = await readPickOrigin(originId)
    // Only the person the card was shown to, in that workspace.
    if (!origin || origin.orgId !== who.orgId || origin.userId !== who.userId) {
      return { messageId: null, turnEnqueued: false }
    }
    const byName = await withPrivilegedDb(who.orgId, "drive-picker-announce-name", (tx) =>
      loadUserName(tx, who.userId),
    )
    const listed = items.slice(0, LINE_ITEMS_MAX).map((i) => ({
      id: i.id,
      name: i.name,
      mimeType: i.mimeType,
    }))
    const message = await withRlsContext(
      {
        actorType: "user",
        orgId: who.orgId,
        userId: who.userId,
        scopes: who.scopes,
        dimensionGrants: who.dimensionGrants,
      },
      (tx) =>
        sendMessage(tx, {
          requiredScopes: LINE_SCOPES,
          orgId: who.orgId,
          userId: who.userId,
          threadId: origin.threadId,
          content: drivePickLineContent(byName, items),
          authorType: "system",
          agentId: origin.agentId,
          metadata: {
            type: "drive-picker-result",
            items: listed,
            count: items.length,
            agentId: origin.agentId,
            // The card's own record: what it picked, read back by cardPickIds.
            origin: originId,
            ids: items.map((i) => i.id),
          },
        }),
    )
    if (!message) {
      log.warn(
        { orgId: who.orgId, threadId: origin.threadId },
        "drive picks not announced: the person is not in the conversation",
      )
      return { messageId: null, turnEnqueued: false }
    }
    if (!origin.agentId) return { messageId: message.id, turnEnqueued: false }
    const payload: FollowUpTurnPayload = {
      orgId: who.orgId,
      threadId: origin.threadId,
      messageId: message.id,
      requesterId: who.userId,
      agentId: origin.agentId,
    }
    try {
      // attempts: 1, like every re-invocation: the turn spends credits and posts
      // a reply, so a retry after a partial run would answer twice.
      await enqueueAppJob("kernel", DRIVE_PICKER_TURN_JOB, payload, {
        jobId: `${DRIVE_PICKER_TURN_JOB}:${message.id}`,
        attempts: 1,
      })
    } catch (err) {
      // The line is posted: the agent reads it on the person's next message.
      log.error(
        { err, orgId: who.orgId, threadId: origin.threadId, messageId: message.id },
        "drive picks announced, but the agent's turn was not enqueued",
      )
      return { messageId: message.id, turnEnqueued: false }
    }
    return { messageId: message.id, turnEnqueued: true }
  } catch (err) {
    log.error({ err, orgId: who.orgId }, "failed to announce Drive picks in their conversation")
    return { messageId: null, turnEnqueued: false }
  }
}

/** The agent's turn off a pick line: once per line (a Redis claim). */
export async function runDrivePickerTurn(payload: FollowUpTurnPayload): Promise<boolean> {
  return runFollowUpTurn(payload, async () => {
    const claimed = await redis.set(turnKey(payload.messageId), "1", "EX", ORIGIN_TTL_SECONDS, "NX")
    return claimed === "OK"
  })
}

/**
 * The ids picked through one card: read from the pick lines it posted in its
 * conversation, by the person it was shown to (picks of anyone else on that
 * thread, or from another card, are not this card's).
 */
export async function cardPickIds(
  who: { orgId: string; userId: string },
  card: { origin: string; threadId: string },
): Promise<string[]> {
  if (!PICK_ORIGIN_RE.test(card.origin)) return []
  const rows = await withPrivilegedDb(who.orgId, "drive-picker-card-picks", (tx) =>
    tx
      .select({ ids: sql<unknown>`${messages.metadata}->'ids'` })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, who.orgId),
          eq(messages.threadId, card.threadId),
          eq(messages.authorId, who.userId),
          eq(messages.authorType, "system"),
          sql`${messages.metadata}->>'type' = 'drive-picker-result'`,
          sql`${messages.metadata}->>'origin' = ${card.origin}`,
        ),
      ),
  )
  const ids = new Set<string>()
  for (const r of rows) {
    if (!Array.isArray(r.ids)) continue
    for (const id of r.ids) if (typeof id === "string") ids.add(id)
  }
  return [...ids]
}
