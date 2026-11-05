// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The standard tier's conversations and contacts, written through the kernel
// services the thread and contact routes call, each inside an RLS transaction
// as the person who acts: the creator opens the thread with its first message,
// every line is that person's own post, reactions and a participant's archive
// or mute are theirs too. Nothing carries the seeded marker: the notifications
// these posts raise are part of the world the lanes read (unread counts, the
// home feed).
//
// A participant's archive or mute is set BEFORE the thread's first message.
// The server's outbox turns each post into attention and notifications a moment
// later, and it reads the recipient's mute or archive when it does: a state set
// after the posts raced that delivery, so some runs notified the person who
// muted and others did not (a different count of attention rows and delivery
// log rows from one seed to the next). Set first, it holds for every post.
//
// No message names an agent, so no agent turn is dispatched.
import { createThreadSchema, sendMessageSchema } from "@liaison/shared"
import { sendMessage } from "~/modules/threads/message"
import { addReaction } from "~/modules/threads/reaction"
import { createThread, getThread } from "~/modules/threads/thread"
import { updateThreadState } from "~/modules/threads/thread-state"
import type { SeedContext } from "~/seed/context"
import { actorFor, asUser } from "~/seed/factories/people/actors"
import { resolveContacts } from "~/seed/factories/people/contacts"
import {
  QA_CONTACTS,
  QA_THREADS,
  type QaContactSpec,
  type QaPersonKey,
  type QaThreadKey,
} from "~/seed/world/qa"
import type { StandardPeople } from "./people"

export interface StandardThread {
  id: string
  handle: string
  title: string | null
}

export interface StandardContact {
  id: string
  name: string | null
  email: string | null
}

type Actors = Record<QaPersonKey, Awaited<ReturnType<typeof actorFor>>>

export async function qaActors(ctx: SeedContext, people: StandardPeople): Promise<Actors> {
  const out = {} as Actors
  for (const key of Object.keys(people) as QaPersonKey[]) {
    out[key] = await actorFor(ctx, people[key].id)
  }
  return out
}

/** The admin's own contacts (the resolve route's default audience: the caller). */
export async function seedQaContacts(
  ctx: SeedContext,
  actors: Actors,
): Promise<Record<QaContactSpec["key"], StandardContact>> {
  const resolved = await resolveContacts(ctx, actors.admin, QA_CONTACTS, "owner")
  const out = {} as Record<QaContactSpec["key"], StandardContact>
  for (const [key, contact] of resolved) {
    out[key as QaContactSpec["key"]] = contact
  }
  return out
}

async function post(
  ctx: SeedContext,
  actor: Actors[QaPersonKey],
  threadId: string,
  content: string,
): Promise<string> {
  const body = sendMessageSchema.parse({ content })
  const msg = await asUser(actor, (tx) =>
    sendMessage(tx as never, {
      requiredScopes: [],
      disclosureList: null,
      orgId: ctx.orgId,
      userId: actor.userId,
      threadId,
      content: body.content,
      correlationId: body.correlationId,
      parentMessageId: null,
      replyRootId: null,
      alsoInChannel: false,
    }),
  )
  if (!msg) throw new Error(`standard seed: post in thread ${threadId} was refused`)
  return msg.id
}

/** The fourteen QA threads (`QA_THREADS`), in order. */
export async function seedQaThreads(
  ctx: SeedContext,
  people: StandardPeople,
  actors: Actors,
): Promise<Record<QaThreadKey, StandardThread>> {
  const out = {} as Record<QaThreadKey, StandardThread>
  for (const spec of QA_THREADS) {
    const creator = actors[spec.creator]
    const body = createThreadSchema.parse({
      forceCreate: true,
      participantIds: spec.participants.map((k) => people[k].id),
      ...(spec.title !== undefined ? { title: spec.title } : {}),
      ...(spec.isPinned !== undefined ? { isPinned: spec.isPinned } : {}),
      // A thread with a participant state opens empty; its first message is
      // posted once the state is in place (see the header).
      ...(spec.state ? {} : { initialMessage: { content: spec.first } }),
    })
    const thread = (await asUser(creator, (tx) =>
      createThread(tx as never, {
        orgId: ctx.orgId,
        userId: creator.userId,
        participantIds: body.participantIds,
        title: body.title,
        isPinned: body.isPinned,
        discoverable: body.discoverable,
        createdFrom: body.createdFrom,
        references: body.references,
        initialMessage: body.initialMessage
          ? { ...body.initialMessage, requiredScopes: [] }
          : undefined,
        type: body.type,
        forceCreate: body.forceCreate,
      }),
    )) as { id: string; handle: string; title: string | null; initialMessageId?: string }
    const messageIds: string[] = []
    if (thread.initialMessageId) messageIds.push(thread.initialMessageId)
    if (spec.state) {
      const actor = actors[spec.state.by]
      const { by: _by, ...flags } = spec.state
      const changed = await asUser(actor, async (tx) => {
        const visible = await getThread(tx as never, {
          orgId: ctx.orgId,
          userId: actor.userId,
          threadId: thread.id,
        })
        if (!visible) return null
        return updateThreadState(tx as never, {
          orgId: ctx.orgId,
          userId: actor.userId,
          threadId: thread.id,
          ...flags,
        })
      })
      if (!changed) throw new Error(`standard seed: state of ${spec.key} was refused`)
      messageIds.push(await post(ctx, creator, thread.id, spec.first))
    }
    for (const [who, content] of spec.lines) {
      messageIds.push(await post(ctx, actors[who], thread.id, content))
    }
    for (const r of spec.reactions ?? []) {
      const messageId = messageIds[messageIds.length - 1 - r.fromNewest]
      if (!messageId) throw new Error(`standard seed: ${spec.key} has no message ${r.fromNewest}`)
      const actor = actors[r.by]
      const added = await asUser(actor, (tx) =>
        addReaction(tx as never, {
          orgId: ctx.orgId,
          userId: actor.userId,
          threadId: thread.id,
          messageId,
          emoji: r.emoji,
        }),
      )
      if (!added) throw new Error(`standard seed: reaction on ${spec.key} was refused`)
    }
    out[spec.key] = { id: thread.id, handle: thread.handle, title: thread.title ?? null }
  }
  return out
}
