// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The number on the app icon. It has to agree with what the user will find
// when they open the app, which is the read-time predicate's answer and not a
// counter this slice keeps: a badge saying 3 over a list showing 2 is a bug
// report every time.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { countBadge } from "@liaison/shared"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { computeApprovalAttentionItems } from "~/modules/approvals/attention"
import { getEventAttentionItems } from "~/modules/attention/event-provider"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import {
  APPROVAL_BADGE_CAP,
  computeBadgeCount,
  computeUnreadMessageCount,
  readBadge,
} from "~/modules/push/badge-count"
import { listThreads } from "~/modules/threads/thread"

const ORG = "00000000-0000-0000-0000-0000000007c0"
const READER = "00000000-0000-0000-0000-0000000007c1"
const AUTHOR = "00000000-0000-0000-0000-0000000007c2"
const SCOPE = "pennylane:payouts:read"

let unreadThread = ""
let readThread = ""
let scopedThread = ""
let mutedThread = ""

async function makeThread(handle: string, title: string): Promise<string> {
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, title, created_by)
    VALUES (${ORG}, ${handle}, ${title}, ${AUTHOR}) RETURNING id`
  for (const userId of [READER, AUTHOR]) {
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${t.id}, ${userId}, ${ORG})`
  }
  await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
    VALUES (${READER}, ${t.id}, ${ORG})`
  return t.id
}

async function post(threadId: string, content: string, scopes: string[]): Promise<string> {
  const [m] = await sql<{ id: string }[]>`
    INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
    VALUES (${threadId}, ${ORG}, ${AUTHOR}, ${content}, ${scopes}::text[])
    RETURNING id`
  return m.id
}

describe("unread message count (the Messages entry)", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'BadgeOrg', 'badge-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${READER}, ${ORG}, 'badge-reader@t.com', 'Reader', 'x') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${AUTHOR}, ${ORG}, 'badge-author@t.com', 'Author', 'x') ON CONFLICT (id) DO NOTHING`
    unreadThread = await makeThread("badge-unread", "Unread")
    readThread = await makeThread("badge-read", "Read")
    scopedThread = await makeThread("badge-scoped", "Scoped")
    mutedThread = await makeThread("badge-muted", "Muted")

    await post(unreadThread, "one", [])
    await post(unreadThread, "two", [])
    const seen = await post(readThread, "seen", [])
    await sql`UPDATE kernel.user_thread_state SET last_read_message_id = ${seen}
      WHERE user_id = ${READER} AND thread_id = ${readThread}`
    await post(scopedThread, "secret", [SCOPE])
    await post(mutedThread, "noisy", [])
    await sql`UPDATE kernel.user_thread_state SET is_muted = true
      WHERE user_id = ${READER} AND thread_id = ${mutedThread}`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("counts the unread messages of the threads the user is in", async () => {
    // Two unread in one thread, none in the read one, the muted one silent and
    // the scope-tagged one invisible to a reader with no grants.
    expect(await computeUnreadMessageCount(READER, ORG)).toBe(2)
  })

  it("counts a scope-tagged message only for a reader who may see it", async () => {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${READER}, ${ORG}, ${SCOPE}) ON CONFLICT DO NOTHING`
    expect(await computeUnreadMessageCount(READER, ORG)).toBe(3)
    await sql`DELETE FROM kernel.user_scope_grants WHERE user_id = ${READER} AND scope = ${SCOPE}`
    expect(await computeUnreadMessageCount(READER, ORG)).toBe(2)
  })

  it("counts an agent's reply stored under the reader's id, never the reader's own words", async () => {
    // The same notion of "own message" as the thread list's unread count: a
    // row the reader wrote as a person. An agent answering in the reader's DM
    // is stored with the reader's author_id and IS news to them.
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${ORG}, 'role', '@badge-desk', 'Badge Desk', '[]'::jsonb) RETURNING id`
    const dm = await makeThread("badge-dm", "Agent DM")
    try {
      await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
        VALUES (${dm}, ${ORG}, ${READER}, 'user', 'my own question', '{}'::text[])`
      expect(await computeUnreadMessageCount(READER, ORG)).toBe(2)
      await sql`INSERT INTO kernel.messages
          (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes)
        VALUES (${dm}, ${ORG}, ${READER}, 'agent', ${agent!.id}, 'the answer', '{}'::text[])`
      expect(await computeUnreadMessageCount(READER, ORG)).toBe(3)
      // A system line the reader's own action wrote (compaction summary) is
      // theirs too, not news.
      await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
        VALUES (${dm}, ${ORG}, ${READER}, 'system', 'summary', '{}'::text[])`
      expect(await computeUnreadMessageCount(READER, ORG)).toBe(3)
    } finally {
      await sql`DELETE FROM kernel.messages WHERE thread_id = ${dm}`
      await sql`DELETE FROM kernel.user_thread_state WHERE thread_id = ${dm}`
      await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${dm}`
      await sql`DELETE FROM kernel.threads WHERE id = ${dm}`
      await sql`DELETE FROM kernel.agents WHERE id = ${agent!.id}`
    }
  })

  it("counts only the threads the Messages list shows, so the badge equals the list's unread", async () => {
    // Demo walk 2026-10-12: 28 of the owner's 29 were routine output threads,
    // which the Messages list never shows (they are read from the agent's
    // Routines tab), so the badge could not be cleared from where it sits.
    // Approval anchors, subruns, hidden threads and a solo entity thread are
    // the same: not Messages rows, not Messages badge.
    const hidden: string[] = []
    for (const [handle, type] of [
      ["badge-routine", "routine"],
      ["badge-approval", "approval"],
      ["badge-subrun", "subrun"],
    ] as const) {
      const id = await makeThread(handle, handle)
      await sql`UPDATE kernel.threads SET type = ${type} WHERE id = ${id}`
      hidden.push(id)
    }
    const hiddenFlag = await makeThread("badge-hidden", "Hidden")
    await sql`UPDATE kernel.threads SET hidden_from_list = true WHERE id = ${hiddenFlag}`
    hidden.push(hiddenFlag)
    const [solo] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, created_by, created_from)
      VALUES (${ORG}, 'badge-solo', 'Solo', ${AUTHOR}, '{"app":"kernel","entity":"contact","id":"x"}'::jsonb)
      RETURNING id`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${solo!.id}, ${READER}, ${ORG})`
    hidden.push(solo!.id)
    try {
      for (const id of hidden) await post(id, "output", [])
      expect(await computeUnreadMessageCount(READER, ORG)).toBe(2)
      const listed: Awaited<ReturnType<typeof listThreads>> = await withRlsContext(
        {
          actorType: "user",
          userId: READER,
          orgId: ORG,
          scopes: [],
          dimensionGrants: {},
          roles: [],
        },
        (tx) => listThreads(tx, { orgId: ORG, userId: READER, limit: 100 }),
      )
      let listUnread = 0
      for (const t of listed.threads) {
        if (!t.isMuted) listUnread += t.unreadCount
      }
      expect(await computeUnreadMessageCount(READER, ORG)).toBe(listUnread)
    } finally {
      await sql`DELETE FROM kernel.messages WHERE thread_id = ANY(${hidden}::uuid[])`
      await sql`DELETE FROM kernel.user_thread_state WHERE thread_id = ANY(${hidden}::uuid[])`
      await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ANY(${hidden}::uuid[])`
      await sql`DELETE FROM kernel.threads WHERE id = ANY(${hidden}::uuid[])`
    }
  })

  it("counts per thread from the read mark: partial reads, never-opened, archived, deleted, status lines", async () => {
    // The count runs per thread, bounded by the read mark; these pin the
    // per-message predicate it replaced, case by case.
    const partial = await makeThread("badge-partial", "Partial")
    const neverOpened = await makeThread("badge-never", "Never opened")
    const archived = await makeThread("badge-archived", "Archived")
    const threads = [partial, neverOpened, archived]
    try {
      // Read up to the second of four: two after the mark count.
      await post(partial, "p1", [])
      const mark = await post(partial, "p2", [])
      await post(partial, "p3", [])
      await post(partial, "p4", [])
      await sql`UPDATE kernel.messages SET created_at = created_at + (interval '1 second' * position)
        FROM (SELECT id AS mid, ROW_NUMBER() OVER (ORDER BY content) AS position
              FROM kernel.messages WHERE thread_id = ${partial}) o
        WHERE id = o.mid`
      await sql`UPDATE kernel.user_thread_state SET last_read_message_id = ${mark}
        WHERE user_id = ${READER} AND thread_id = ${partial}`
      expect(await computeUnreadMessageCount(READER, ORG)).toBe(2 + 2)

      // No user_thread_state row at all: every message counts.
      await sql`DELETE FROM kernel.user_thread_state WHERE thread_id = ${neverOpened}`
      await post(neverOpened, "n1", [])
      await post(neverOpened, "n2", [])
      expect(await computeUnreadMessageCount(READER, ORG)).toBe(4 + 2)

      // A soft deleted message and a status line never count.
      const gone = await post(neverOpened, "n3", [])
      await sql`UPDATE kernel.messages SET deleted_at = now() WHERE id = ${gone}`
      await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes, metadata)
        VALUES (${neverOpened}, ${ORG}, ${AUTHOR}, 'system', 'Routine running', '{}'::text[], '{"type":"routine-run"}'::jsonb)`
      expect(await computeUnreadMessageCount(READER, ORG)).toBe(6)

      // An archived thread is silent.
      await post(archived, "a1", [])
      await sql`UPDATE kernel.user_thread_state SET is_archived = true
        WHERE user_id = ${READER} AND thread_id = ${archived}`
      expect(await computeUnreadMessageCount(READER, ORG)).toBe(6)

      // A read mark pointing at a message that no longer exists reads as
      // never opened, as before.
      await sql`UPDATE kernel.user_thread_state SET last_read_message_id = gen_random_uuid()
        WHERE user_id = ${READER} AND thread_id = ${partial}`
      expect(await computeUnreadMessageCount(READER, ORG)).toBe(2 + 4 + 2)
    } finally {
      await sql`DELETE FROM kernel.messages WHERE thread_id = ANY(${threads}::uuid[])`
      await sql`DELETE FROM kernel.user_thread_state WHERE thread_id = ANY(${threads}::uuid[])`
      await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ANY(${threads}::uuid[])`
      await sql`DELETE FROM kernel.threads WHERE id = ANY(${threads}::uuid[])`
    }
  })

  it("counts nothing for a user with no threads", async () => {
    expect(await computeUnreadMessageCount(AUTHOR, ORG)).toBe(0)
  })
})

//
// Rule 6, one badge, one meaning: the app icon counts the unread things that
// ask for the person (direct conversations, mentions, replies in reply threads
// they follow, approvals they decide, critical alerts), with the shared
// `countBadge` the web counts with. Channel traffic that names nobody, and
// everything else in the feed, is not in it.

const ASK_ORG = "00000000-0000-0000-0000-0000000008d0"
const ASK_READER = "00000000-0000-0000-0000-0000000008d1"
const ASK_AUTHOR = "00000000-0000-0000-0000-0000000008d2"

let askDm = ""
let askChannel = ""

async function makeAskThread(handle: string, title: string | null): Promise<string> {
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, title, created_by)
    VALUES (${ASK_ORG}, ${handle}, ${title}, ${ASK_AUTHOR}) RETURNING id`
  for (const userId of [ASK_READER, ASK_AUTHOR]) {
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${t.id}, ${userId}, ${ASK_ORG})`
  }
  await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
    VALUES (${ASK_READER}, ${t.id}, ${ASK_ORG})`
  return t.id
}

async function askPost(threadId: string, content: string): Promise<void> {
  await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
    VALUES (${threadId}, ${ASK_ORG}, ${ASK_AUTHOR}, ${content}, '{}'::text[])`
}

async function attention(
  kind: string,
  entityId: string,
  opts: {
    read?: boolean
    emailOnly?: boolean
    urgency?: number
    metadata?: Record<string, unknown>
  } = {},
): Promise<void> {
  const urgency = opts.urgency ?? (kind.endsWith(".critical") ? 90 : 50)
  await sql`INSERT INTO kernel.attention_events
      (org_id, user_id, app, entity_type, entity_id, kind, urgency, summary, actor_type,
       metadata, occurred_at, read_at, digest_eligible_at, email_only, source_key)
    VALUES (${ASK_ORG}, ${ASK_READER}, 'kernel', 'thread', ${entityId}, ${kind}, ${urgency}, 'x', 'user',
      ${JSON.stringify(opts.metadata ?? {})}::jsonb, now(),
      ${opts.read ? new Date().toISOString() : null}::timestamptz, now(), ${opts.emailOnly ?? false},
      ${opts.emailOnly ? `src-${kind}-${entityId}` : null})`
}

describe("the app badge counts direct asks (rule 6)", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ASK_ORG}, 'AskBadgeOrg', 'ask-badge-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${ASK_READER}, ${ASK_ORG}, 'ask-reader@t.com', 'Reader', 'x') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${ASK_AUTHOR}, ${ASK_ORG}, 'ask-author@t.com', 'Author', 'x') ON CONFLICT (id) DO NOTHING`
    askDm = await makeAskThread("ask-dm", null)
    askChannel = await makeAskThread("ask-channel", "support")
    await askPost(askDm, "are you there?")
    await askPost(askDm, "ping")
    for (const n of ["a", "b", "c"]) await askPost(askChannel, n)
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.attention_events WHERE org_id = ${ASK_ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ASK_ORG}`
    await sql`DELETE FROM kernel.reply_thread_followers WHERE org_id = ${ASK_ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ASK_ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ASK_ORG}`
    await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ASK_ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ASK_ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ASK_ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ASK_ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ASK_ORG}`
  })

  it("counts a direct conversation's unread messages, never a channel's", async () => {
    expect(await computeBadgeCount(ASK_READER, ASK_ORG)).toBe(2)
    // The Messages entry keeps its own number: every unread message it lists.
    expect(await computeUnreadMessageCount(ASK_READER, ASK_ORG)).toBe(5)
  })

  it("adds unread mentions, followed replies and critical alerts, and nothing else", async () => {
    await attention("mention", askChannel)
    await attention("thread_followup", "root-1", { metadata: { threadId: askChannel } })
    await attention("monitoring:incident.critical", "inc-1")
    // Not asks: a channel reply row, a read mention, a warning, a digest-only row.
    await attention("thread_reply", askChannel)
    await attention("mention", "old-thread", { read: true })
    await attention("monitoring:incident.warning", "inc-2")
    await attention("monitoring:incident.critical", "inc-3", { emailOnly: true })
    await attention("monitoring:incident.critical", "inc-low", { urgency: 65 })
    expect(await computeBadgeCount(ASK_READER, ASK_ORG)).toBe(5)
  })

  it("does not count a mention twice when it sits in a direct conversation", async () => {
    await attention("mention", askDm)
    expect(await computeBadgeCount(ASK_READER, ASK_ORG)).toBe(5)
  })

  it("rule 7: a muted mention and an off-kind item show in the inbox, unread, and never count", async () => {
    await attention("mention", "muted-thread", { metadata: { quiet: true } })
    await attention("monitoring:incident.critical", "inc-quiet", { metadata: { quiet: true } })
    expect(await computeBadgeCount(ASK_READER, ASK_ORG)).toBe(5)
    const inbox = await withRlsContext(
      { actorType: "user", userId: ASK_READER, orgId: ASK_ORG, scopes: ["*"], dimensionGrants: {} },
      (tx) => getEventAttentionItems(tx, ASK_ORG, ASK_READER),
    )
    const ids = inbox.map((i) => i.entityId)
    expect(ids).toContain("muted-thread")
    expect(ids).toContain("inc-quiet")
    // The shared count the web and the phone use agrees.
    const quietItems = inbox.filter((i) => i.metadata?.quiet === true)
    expect(quietItems).toHaveLength(2)
    expect(countBadge({ threads: [], items: quietItems, viewer: { canGrantAccess: true } })).toBe(0)
  })

  it("drops what was read anywhere", async () => {
    await sql`UPDATE kernel.attention_events SET read_at = now()
      WHERE org_id = ${ASK_ORG} AND kind = 'monitoring:incident.critical'`
    const [last] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.messages WHERE thread_id = ${askDm} ORDER BY created_at DESC LIMIT 1`
    await sql`UPDATE kernel.user_thread_state SET last_read_message_id = ${last!.id}
      WHERE user_id = ${ASK_READER} AND thread_id = ${askDm}`
    const reading = await readBadge(ASK_READER, ASK_ORG)
    expect(reading.count).toBe(2)
  })

  //
  // Rule 6 and the approvals: the badge counts the approvals the person
  // decides with the same rule Home counts its feed with (the shared
  // `countBadge` over the feed's items), read through a bounded query.

  const DECIDE_SCOPE = "badgeapp:approve"
  const PEER_SCOPE = "peerapp:approve"

  async function approval(
    tool: string,
    scope: string,
    opts: { notify?: string[]; status?: string; requestedBy?: string } = {},
  ): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.approval_requests
        (org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
         current_payload, expires_at, requested_by, status, notify_user_ids, approve_scope)
      VALUES (${ASK_ORG}, ${`badge-${crypto.randomUUID().slice(0, 8)}`}, ${askChannel},
        ${askChannel}, ${tool}, '{}'::jsonb, '{}'::jsonb, now() + interval '1 day',
        ${opts.requestedBy ?? ASK_AUTHOR}, ${opts.status ?? "pending"},
        ${opts.notify ?? [ASK_READER]}::uuid[], ${scope})
      RETURNING id`
    return row!.id
  }

  /** Home's number for the approvals: countBadge over the feed the person is shown. */
  async function homeApprovalCount(): Promise<number> {
    const permissions = await withPrivilegedDb(ASK_ORG, "badge-test-permissions", (tx) =>
      loadEffectivePermissions(tx, ASK_READER, ASK_ORG),
    )
    const items = await withRlsContext(
      {
        actorType: "user",
        userId: ASK_READER,
        orgId: ASK_ORG,
        scopes: permissions.scopes,
        dimensionGrants: permissions.dimensionGrants,
        roles: permissions.roles,
      },
      (tx) => computeApprovalAttentionItems(tx, ASK_ORG, ASK_READER),
    )
    return countBadge({ threads: [], items, viewer: { canGrantAccess: false } })
  }

  it("counts the approvals the person decides, as Home does, and folds a peer's own request", async () => {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${ASK_READER}, ${ASK_ORG}, ${DECIDE_SCOPE}), (${ASK_READER}, ${ASK_ORG}, ${PEER_SCOPE}),
             (${ASK_AUTHOR}, ${ASK_ORG}, ${PEER_SCOPE})
      ON CONFLICT DO NOTHING`
    const before = (await readBadge(ASK_READER, ASK_ORG)).count
    try {
      // Theirs to decide.
      await approval("badgeapp:send", DECIDE_SCOPE)
      // Another person's request they could approve themselves: folded.
      await approval("peerapp:send", PEER_SCOPE)
      // Not addressed to them, already decided, or one they cannot decide.
      await approval("badgeapp:send", DECIDE_SCOPE, { notify: [] })
      await approval("badgeapp:send", DECIDE_SCOPE, { status: "approved" })
      await approval("otherapp:send", "otherapp:approve")
      const home = await homeApprovalCount()
      expect(home).toBe(1)
      expect((await readBadge(ASK_READER, ASK_ORG)).count).toBe(before + home)
    } finally {
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ASK_ORG}`
    }
  })

  it("reads the approvals through a bounded query", async () => {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${ASK_READER}, ${ASK_ORG}, ${DECIDE_SCOPE}) ON CONFLICT DO NOTHING`
    const before = (await readBadge(ASK_READER, ASK_ORG)).count
    try {
      await sql`
        INSERT INTO kernel.approval_requests
          (org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
           current_payload, expires_at, requested_by, status, notify_user_ids, approve_scope)
        SELECT ${ASK_ORG}, 'bulk-' || g, ${askChannel}, ${askChannel}, 'badgeapp:send',
          '{}'::jsonb, '{}'::jsonb, now() + interval '1 day', ${ASK_AUTHOR}, 'pending',
          ARRAY[${ASK_READER}]::uuid[], ${DECIDE_SCOPE}
        FROM generate_series(1, ${APPROVAL_BADGE_CAP + 5}) g`
      expect((await readBadge(ASK_READER, ASK_ORG)).count).toBe(before + APPROVAL_BADGE_CAP)
    } finally {
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ASK_ORG}`
    }
  })

  //
  // Rule 5, read once, read everywhere: the phone withdraws a delivered
  // notification only when the server says the exact thing it announced was
  // read (or resolved). A reply of a read channel, a message of a thread the
  // Messages list hides, an item nobody can find: never.

  describe("which delivered notifications are settled (rule 5)", () => {
    const settled = async (keys: string[]) =>
      (await readBadge(ASK_READER, ASK_ORG, keys)).settled.sort()

    async function message(
      threadId: string,
      opts: { replyRootId?: string; alsoInChannel?: boolean } = {},
    ): Promise<{ id: string; at: string }> {
      const [m] = await sql<{ id: string; at: string }[]>`
      INSERT INTO kernel.messages
        (thread_id, org_id, author_id, content, required_scopes, reply_root_id, also_in_channel)
      VALUES (${threadId}, ${ASK_ORG}, ${ASK_AUTHOR}, 'x', '{}'::text[],
        ${opts.replyRootId ?? null}, ${opts.alsoInChannel ?? false})
      RETURNING id, created_at::text AS at`
      return m!
    }

    async function readChannelUpTo(threadId: string, messageId: string): Promise<void> {
      await sql`UPDATE kernel.user_thread_state SET last_read_message_id = ${messageId}
      WHERE user_id = ${ASK_READER} AND thread_id = ${threadId}`
    }

    it("a channel message once the channel is read past it, not before", async () => {
      const m = await message(askChannel)
      expect(await settled([`message/${m.id}`])).toEqual([])
      await readChannelUpTo(askChannel, m.id)
      expect(await settled([`message/${m.id}`])).toEqual([`message/${m.id}`])
    })

    it("a reply only the reply thread shows stays until the reply thread is read, the channel read or not", async () => {
      const root = await message(askChannel)
      await sql`INSERT INTO kernel.reply_thread_followers (root_message_id, thread_id, user_id, org_id)
        VALUES (${root.id}, ${askChannel}, ${ASK_READER}, ${ASK_ORG}) ON CONFLICT DO NOTHING`
      const reply = await message(askChannel, { replyRootId: root.id })
      const after = await message(askChannel)
      // The channel is read past the reply: the reply is still unread.
      await readChannelUpTo(askChannel, after.id)
      expect(await settled([`message/${reply.id}`])).toEqual([])
      await sql`UPDATE kernel.reply_thread_followers SET last_read_at = now()
      WHERE root_message_id = ${root.id} AND user_id = ${ASK_READER}`
      expect(await settled([`message/${reply.id}`])).toEqual([`message/${reply.id}`])
    })

    it("a reply the channel shows too is read by either mark", async () => {
      const root = await message(askChannel)
      const reply = await message(askChannel, { replyRootId: root.id, alsoInChannel: true })
      expect(await settled([`message/${reply.id}`])).toEqual([])
      await readChannelUpTo(askChannel, reply.id)
      expect(await settled([`message/${reply.id}`])).toEqual([`message/${reply.id}`])
    })

    it("a message of an entity's thread (hidden from Messages) is judged by its own read mark", async () => {
      const [task] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, created_by, created_from)
      VALUES (${ASK_ORG}, 'ask-task-thread', 'Task', ${ASK_AUTHOR},
        ${JSON.stringify({ app: "projects", entityType: "task", entityId: "k1" })}::jsonb)
      RETURNING id`
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${task!.id}, ${ASK_READER}, ${ASK_ORG})`
      await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${ASK_READER}, ${task!.id}, ${ASK_ORG})`
      const m = await message(task!.id)
      expect(await settled([`message/${m.id}`])).toEqual([])
      await readChannelUpTo(task!.id, m.id)
      expect(await settled([`message/${m.id}`])).toEqual([`message/${m.id}`])
    })

    it("a deleted message is settled; an unknown key or id never is", async () => {
      const m = await message(askChannel)
      await sql`UPDATE kernel.messages SET deleted_at = now() WHERE id = ${m.id}`
      expect(
        await settled([
          `message/${m.id}`,
          `message/${crypto.randomUUID()}`,
          "message/not-a-uuid",
          "thread/whatever",
          `attention/kernel/approval_request/${crypto.randomUUID()}`,
        ]),
      ).toEqual([`message/${m.id}`])
    })

    it("an approval once decided, and a critical alert once its row is read", async () => {
      const [pending] = await sql<{ id: string }[]>`
      INSERT INTO kernel.approval_requests
        (org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
         current_payload, expires_at, requested_by, notify_user_ids)
      VALUES (${ASK_ORG}, 'settle-approval', ${askChannel}, ${askChannel}, 'badgeapp:send',
        '{}'::jsonb, '{}'::jsonb, now() + interval '1 day', ${ASK_AUTHOR},
        ARRAY[${ASK_READER}]::uuid[])
      RETURNING id`
      const approvalKey = `attention/kernel/approval_request/${pending!.id}`
      await sql`INSERT INTO kernel.attention_events
        (org_id, user_id, app, entity_type, entity_id, kind, urgency, summary, actor_type,
         occurred_at, digest_eligible_at)
      VALUES (${ASK_ORG}, ${ASK_READER}, 'monitoring', 'incident', 'inc-settle',
        'monitoring:incident.critical', 90, 'x', 'system', now(), now())`
      const alertKey = "attention/monitoring/incident/inc-settle"
      try {
        expect(await settled([approvalKey, alertKey])).toEqual([])
        await sql`UPDATE kernel.approval_requests SET status = 'approved' WHERE id = ${pending!.id}`
        await sql`UPDATE kernel.attention_events SET read_at = now()
        WHERE org_id = ${ASK_ORG} AND entity_id = 'inc-settle'`
        expect(await settled([approvalKey, alertKey])).toEqual([approvalKey, alertKey].sort())
      } finally {
        await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ASK_ORG}`
      }
    })
  })
})
