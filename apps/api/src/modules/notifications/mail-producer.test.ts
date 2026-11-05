// SPDX-License-Identifier: FSL-1.1-ALv2
// S15 / S16: the kernel's new-email producer, against the real attention table.
// It consumes the mail app's `message:create` event; the mail side of the
// contract (which sync path stamps which origin) is in
// apps/mail/message-origin.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { AppEvent } from "~/infra/events/event-bus"
import type { PushPayload } from "~/modules/push/types"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { BurstTestAccess } from "./burst"
import { type AttentionLiveItem, dispatchAttentionLive } from "./dispatch"
import { newEmailSkipReason, processNewEmailEvent } from "./mail-producer"
import type { RouterDecision } from "./router"

describe("mail producer: new_email attention items", () => {
  let me: minimal.Session
  let orgMailboxOwner: minimal.Session
  const personal = crypto.randomUUID()
  const shared = crypto.randomUUID()
  const imap = crypto.randomUUID()

  const insertAccount = async (
    id: string,
    ownerType: "user" | "org",
    ownerId: string | null,
    provider: string,
    email: string,
    status = "active",
  ) => {
    await sql`INSERT INTO app_mail.accounts
      (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address, sync_status)
      VALUES (${id}, ${me.orgId}, ${crypto.randomUUID()}, ${ownerType}, ${ownerId}, ${provider},
              ${email}, ${status})`
    // A personal mailbox is born `pending_enrollment` and syncs only once
    // `ready`; these fixtures are enrolled mailboxes.
    if (ownerType === "user") {
      await sql`UPDATE app_mail.accounts SET encryption_state = 'ready' WHERE id = ${id}`
    }
  }

  const event = (over: Record<string, unknown> = {}, accountId = personal): AppEvent => {
    const id = crypto.randomUUID()
    return {
      app: "mail",
      entity: "message",
      action: "create",
      entityId: id,
      orgId: me.orgId,
      actorId: "system",
      actorType: "system",
      data: {
        id,
        conversationId: crypto.randomUUID(),
        accountId,
        direction: "inbound",
        from: { name: "Alice Martin", email: "alice@example.com" },
        origin: "incremental",
        labels: ["INBOX", "UNREAD"],
        isRead: false,
        internalDate: Date.now() - 30_000,
        ...over,
      },
    }
  }

  const rows = async () =>
    (await sql`SELECT id, kind, app, summary, metadata, read_at FROM kernel.attention_events
      WHERE user_id = ${me.userId} AND kind = 'new_email' ORDER BY created_at`) as unknown as Array<{
      id: string
      kind: string
      app: string
      summary: string
      metadata: Record<string, any>
    }>

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    me = await minimal.session(org.id)
    orgMailboxOwner = await minimal.session(org.id)
    await insertAccount(personal, "user", me.userId, "gmail", "me@example.com")
    await insertAccount(shared, "org", orgMailboxOwner.userId, "gmail", "support@example.com")
    await insertAccount(imap, "user", me.userId, "imap", "me-imap@example.com")
  })

  beforeEach(async () => {
    // Not a burst (burst.ts): every case starts from none.
    await BurstTestAccess.resetOrg(me.orgId)
    await sql`DELETE FROM kernel.attention_events WHERE user_id IN (${me.userId}, ${orgMailboxOwner.userId})`
    await sql`DELETE FROM kernel.attention_subscriptions WHERE user_id = ${me.userId}`
    await sql`DELETE FROM kernel.user_preferences WHERE user_id = ${me.userId}`
    await sql`UPDATE app_mail.accounts SET sync_status = 'active' WHERE id = ${personal}`
  })

  afterAll(async () => {
    if (me) {
      await sql`DELETE FROM kernel.attention_events WHERE user_id IN (${me.userId}, ${orgMailboxOwner.userId})`
      await sql`DELETE FROM kernel.attention_subscriptions WHERE user_id = ${me.userId}`
      await sql`DELETE FROM kernel.user_preferences WHERE user_id = ${me.userId}`
      await sql`DELETE FROM app_mail.accounts WHERE id IN (${personal}, ${shared}, ${imap})`
    }
    await releaseTestLock()
  })

  it("a 500-message initial sync produces no item", async () => {
    for (let i = 0; i < 500; i++) await processNewEmailEvent(event({ origin: "initial" }))
    expect((await rows()).length).toBe(0)
  })

  it("one incremental message produces one item naming the sender, opening the conversation", async () => {
    const e = event()
    await processNewEmailEvent(e)
    const r = await rows()
    expect(r.length).toBe(1)
    expect(r[0].app).toBe("mail")
    expect(r[0].summary).toBe("New email from Alice Martin")
    expect(r[0].metadata.revision).toBe(1)
    expect(r[0].metadata.link).toEqual({
      tabType: "mail:conversation",
      entityId: (e.data as any).conversationId,
    })
  })

  it("falls back to the address when the sender has no display name", async () => {
    await processNewEmailEvent(event({ from: { email: "bob@example.com" } }))
    expect((await rows())[0].summary).toBe("New email from bob@example.com")
  })

  it("an incremental message during a backfill (syncing) produces one item", async () => {
    await sql`UPDATE app_mail.accounts SET sync_status = 'syncing' WHERE id = ${personal}`
    await processNewEmailEvent(event())
    expect((await rows()).length).toBe(1)
  })

  it("a historyExpired re-sync (re-enters the initial import) produces no item", async () => {
    for (let i = 0; i < 20; i++) await processNewEmailEvent(event({ origin: "initial" }))
    expect((await rows()).length).toBe(0)
  })

  it("promotions, self-sent, old, read, archived, outbound, org mailbox and IMAP produce nothing", async () => {
    await processNewEmailEvent(event({ labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"] }))
    await processNewEmailEvent(event({ labels: ["INBOX", "UNREAD", "CATEGORY_SOCIAL"] }))
    await processNewEmailEvent(event({ labels: ["INBOX", "UNREAD", "CATEGORY_UPDATES"] }))
    await processNewEmailEvent(event({ labels: ["INBOX", "UNREAD", "CATEGORY_FORUMS"] }))
    await processNewEmailEvent(event({ from: { name: "Me", email: "ME@example.com" } }))
    await processNewEmailEvent(event({ internalDate: Date.now() - 16 * 60_000 }))
    await processNewEmailEvent(event({ internalDate: null }))
    await processNewEmailEvent(event({ isRead: true }))
    await processNewEmailEvent(event({ labels: ["UNREAD"] }))
    await processNewEmailEvent(event({ direction: "outbound", origin: "sent" }))
    await processNewEmailEvent(event({}, shared))
    await processNewEmailEvent(event({ origin: "imap" }, imap))
    await processNewEmailEvent(event({ origin: "incremental" }, imap))
    expect((await rows()).length).toBe(0)
    const orgRows = await sql`SELECT 1 FROM kernel.attention_events
      WHERE user_id = ${orgMailboxOwner.userId} AND kind = 'new_email'`
    expect(orgRows.length).toBe(0)
  })

  it("the per-app rule switching mail off suppresses the item", async () => {
    await sql`INSERT INTO kernel.attention_subscriptions (user_id, source, kinds, filters, enabled)
      VALUES (${me.userId}, 'mail', ARRAY['*'], '{}'::jsonb, false)`
    await processNewEmailEvent(event())
    expect((await rows()).length).toBe(0)
  })

  it("rule 7: new email set to off stays in the inbox, unread but quiet, and never goes live", async () => {
    await sql`INSERT INTO kernel.user_preferences (user_id, notification_channels)
      VALUES (${me.userId}, ${JSON.stringify({ mutedGroups: ["mail"] })}::jsonb)`
    const live: RouterDecision[] = []
    await processNewEmailEvent(event(), {
      dispatchLive: async (d: RouterDecision) => {
        live.push(d)
      },
    })
    const [item] = (await rows()) as unknown as Array<{
      read_at: Date | null
      metadata: Record<string, unknown>
    }>
    expect(item?.read_at).toBeNull()
    expect(item?.metadata.quiet).toBe(true)
    for (const d of live) {
      expect(d.channels.push.deliver).toBe(false)
      expect(d.channels.desktop.deliver).toBe(false)
    }
  })

  it("3 emails within 90 s give one item with 3 revisions", async () => {
    await processNewEmailEvent(event({ from: { name: "A", email: "a@x.com" } }))
    await processNewEmailEvent(event({ from: { name: "B", email: "b@x.com" } }))
    await processNewEmailEvent(event({ from: { name: "C", email: "c@x.com" } }))
    const r = await rows()
    expect(r.length).toBe(1)
    expect(r[0].metadata.revision).toBe(3)
    expect(r[0].summary).toBe("3 new emails from A, B and 1 other")
  })

  // P2-TD: every revision goes live, the coalescing update included: one push
  // per email that replaces the previous banner (collapse id = the item), one
  // desktop notification per revision.
  it("each coalesced email re-alerts: collapse id = the item, notifyId carries the revision", async () => {
    const live: Array<{ d: RouterDecision; i: AttentionLiveItem }> = []
    const dispatchLive = async (d: RouterDecision, i: AttentionLiveItem) => {
      live.push({ d, i })
    }
    await processNewEmailEvent(event({ from: { name: "A", email: "a@x.com" } }), { dispatchLive })
    await processNewEmailEvent(event({ from: { name: "B", email: "b@x.com" } }), { dispatchLive })
    const replay = event({ from: { name: "C", email: "c@x.com" } })
    await processNewEmailEvent(replay, { dispatchLive })
    await processNewEmailEvent(replay, { dispatchLive }) // outbox redelivery: no re-alert
    const [item] = await rows()
    expect(live.map((l) => l.i.notifyId)).toEqual([
      `attention:${item.id}:1`,
      `attention:${item.id}:2`,
      `attention:${item.id}:3`,
    ])
    expect(live.every((l) => l.i.collapseId === item.id)).toBe(true)
    expect(live[0].d.group).toBe("mail")
    expect(live[2].i.summary).toBe(item.summary)
  })

  it("a coalescing revision reaches the wire: one push per revision, same collapse id", async () => {
    await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
      VALUES (${me.orgId}, ${me.userId}, 'ios', 'mail-producer-token')`
    // New email is inbox-only by default (rule 2): this person turned its phone cell on.
    await sql`INSERT INTO kernel.user_preferences (user_id, notification_channels)
      VALUES (${me.userId}, ${JSON.stringify({ grid: { mail: { push: true } } })}::jsonb)`
    const pushes: PushPayload[] = []
    const dispatchLive = (d: RouterDecision, i: AttentionLiveItem) =>
      dispatchAttentionLive(d, i, {
        pushDeps: {
          badgeCount: async () => 0,
          send: async (_t, payload) => {
            pushes.push(payload)
            return { kind: "sent" }
          },
        },
      })
    try {
      await processNewEmailEvent(event({ from: { name: "A", email: "a@x.com" } }), { dispatchLive })
      await processNewEmailEvent(event({ from: { name: "B", email: "b@x.com" } }), { dispatchLive })
    } finally {
      await sql`DELETE FROM kernel.push_tokens WHERE token = 'mail-producer-token'`
    }
    const [item] = await rows()
    expect(pushes).toHaveLength(2)
    expect(pushes.map((p) => p.collapseId)).toEqual([item.id, item.id])
    expect(pushes[1].body).toBe(item.summary)
  })

  it("two emails from one sender read as one sender", async () => {
    await processNewEmailEvent(event())
    await processNewEmailEvent(event())
    expect((await rows())[0].summary).toBe("2 new emails from Alice Martin")
  })

  it("a replayed event does not bump the revision (outbox at-least-once)", async () => {
    const e = event()
    await processNewEmailEvent(e)
    await processNewEmailEvent(e)
    const r = await rows()
    expect(r.length).toBe(1)
    expect(r[0].metadata.revision).toBe(1)
  })

  it("an email more than 2 minutes after the item opens a new item", async () => {
    await processNewEmailEvent(event())
    await sql`UPDATE kernel.attention_events SET created_at = now() - interval '3 minutes'
      WHERE user_id = ${me.userId} AND kind = 'new_email'`
    await processNewEmailEvent(event())
    expect((await rows()).length).toBe(2)
  })

  it("a read item is never coalesced into", async () => {
    await processNewEmailEvent(event())
    await sql`UPDATE kernel.attention_events SET read_at = now()
      WHERE user_id = ${me.userId} AND kind = 'new_email'`
    await processNewEmailEvent(event())
    expect((await rows()).length).toBe(2)
  })

  it("the summary never contains the subject or body, even if an event carried them", async () => {
    await processNewEmailEvent(
      event({ subject: "Secret merger terms", snippet: "Secret body", textBody: "Secret body" }),
    )
    const r = await rows()
    expect(r[0].summary).not.toContain("Secret")
    expect(JSON.stringify(r[0].metadata)).not.toContain("Secret")
  })

  it("renders in the recipient's language", async () => {
    await sql`INSERT INTO kernel.user_preferences (user_id, language) VALUES (${me.userId}, 'fr')`
    await processNewEmailEvent(event())
    expect((await rows())[0].summary).toBe("Nouveau mail de Alice Martin")
  })

  it("a mailbox in pending_enrollment (mid-reset) produces nothing", () => {
    const now = Date.now()
    const data = {
      origin: "incremental",
      direction: "inbound",
      labels: ["INBOX", "UNREAD"],
      isRead: false,
      internalDate: now,
      from: { email: "a@x.com" },
    }
    const account = {
      owner_type: "user",
      owner_id: "u",
      provider: "gmail",
      email_address: "me@x.com",
      disconnected_at: null,
    }
    expect(newEmailSkipReason(data, account, now)).toBeNull()
    expect(
      newEmailSkipReason(data, { ...account, encryption_state: "pending_enrollment" }, now),
    ).toBe("mailbox_not_ready")
    expect(newEmailSkipReason({ ...data, origin: "reset" }, account, now)).toBe("origin")
  })
})
