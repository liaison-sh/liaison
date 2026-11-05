// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import type { AgentDisplay } from "~/modules/threads/agent-directory"
import {
  CHANNEL_ROW_CAP,
  capChannels,
  chatSections,
  type DiscoverableChannel,
  groupIsEmpty,
  mentionedThreadIds,
  orderedGroup,
  pickAgentDmThread,
  sectionThreads,
  splitUnread,
  type ThreadGroup,
  threadMatchesQuery,
  unjoinedChannels,
} from "~/modules/threads/thread-list-model"
import type { Thread } from "~/modules/threads/thread-store"

const ME = "me"
const iso = (minutesAgo: number) =>
  new Date(Date.UTC(2026, 9, 1, 12, 0) - minutesAgo * 60_000).toISOString()

function thread(id: string, over: Partial<Thread> = {}): Thread {
  return {
    id,
    handle: `@${id}`,
    title: null,
    type: "chat" as Thread["type"],
    createdFrom: null,
    isPinned: false,
    isPinnedByUser: false,
    isMuted: false,
    discoverable: false,
    topic: null,
    description: null,
    participants: [{ id: ME, name: "Me", avatarUrl: null, participantType: "user", agentId: null }],
    lastMessage: null,
    unreadCount: 0,
    updatedAt: iso(60),
    ...over,
  } as Thread
}

const channel = (id: string, title: string, over: Partial<Thread> = {}) =>
  thread(id, { title, discoverable: true, ...over })

const personDm = (id: string, userId: string, name: string, over: Partial<Thread> = {}) =>
  thread(id, {
    participants: [
      { id: ME, name: "Me", avatarUrl: null, participantType: "user", agentId: null },
      { id: userId, name, avatarUrl: null, participantType: "user", agentId: null },
    ],
    ...over,
  })

const agentDm = (id: string, agentId: string, name: string, over: Partial<Thread> = {}) =>
  thread(id, {
    participants: [
      { id: ME, name: "Me", avatarUrl: null, participantType: "user", agentId: null },
      { id: `seat-${agentId}`, name, avatarUrl: null, participantType: "agent", agentId },
    ],
    ...over,
  })

const tiers = (over: Partial<ThreadGroup>): ThreadGroup => ({
  pinned: [],
  userPinned: [],
  unpinned: [],
  ...over,
})

const ids = (rows: Thread[]) => rows.map((t) => t.id)
const NONE: ReadonlySet<string> = new Set()

describe("sectionThreads", () => {
  it("puts titled rooms under Channels and untitled ones under Direct messages, tiers kept", () => {
    const s = sectionThreads(
      tiers({
        pinned: [channel("c-ops", "Ops", { isPinned: true })],
        userPinned: [personDm("d-ann", "ann", "Ann", { isPinnedByUser: true })],
        unpinned: [channel("c-eng", "Engineering"), agentDm("d-scout", "a-scout", "Scout")],
      }),
      ME,
      { agentDmKeys: NONE },
    )
    expect(ids(s.channels.pinned)).toEqual(["c-ops"])
    expect(ids(s.channels.unpinned)).toEqual(["c-eng"])
    expect(ids(s.directMessages.userPinned)).toEqual(["d-ann"])
    expect(ids(s.directMessages.unpinned)).toEqual(["d-scout"])
  })

  it("keeps ONE DM per counterpart across all tiers, the most recent one", () => {
    const s = sectionThreads(
      tiers({
        pinned: [agentDm("d-old", "a-sup", "Support", { isPinned: true, updatedAt: iso(500) })],
        unpinned: [agentDm("d-new", "a-sup", "Support", { updatedAt: iso(5) })],
      }),
      ME,
      { agentDmKeys: NONE },
    )
    expect(ids(orderedGroup(s.directMessages))).toEqual(["d-new"])
  })

  // Walk on demo (2026-10-12, S27/S31): a routine that handed work to @support
  // seated Support Desk in its output thread; the sidebar listed that feed as the
  // "Support Desk" DM (named by the agent) and dropped the owner's real DM with it.
  it("keeps a routine's output thread a channel by its title after a hand-off seats an agent", () => {
    const realDm = agentDm("d-sup", "a-sup", "Support Desk", { updatedAt: iso(300) })
    const feed = agentDm("r-feed", "a-sup", "Support Desk", {
      title: "walk-s27-handoff",
      type: "routine" as Thread["type"],
      updatedAt: iso(1),
    })
    const s = sectionThreads(tiers({ unpinned: [realDm, feed] }), ME, { agentDmKeys: NONE })
    expect(ids(orderedGroup(s.directMessages))).toEqual(["d-sup"])
    expect(ids(orderedGroup(s.channels))).toEqual(["r-feed"])
    expect(threadMatchesQuery(feed, "walk-s27", ME)).toBe(true)
  })

  // Walk on demo (2026-10-12): a channel the user created ("s11-cloud-walk")
  // and then seated their Personal agent in read as the "Personal agent" DM,
  // took the personal DM's head row and hid the real one. A room created as a
  // channel stays a channel by its title whatever its membership.
  it("keeps a titled channel whose only other seat is the personal agent a channel, beside the real DM", () => {
    const realDm = agentDm("d-mine", "a-mine", "Personal agent", {
      type: "agent_chat" as Thread["type"],
      title: "Morning brief questions",
      updatedAt: iso(300),
    })
    const walk = agentDm("c-walk", "a-mine", "Personal agent", {
      type: "thread" as Thread["type"],
      title: "s11-cloud-walk",
      updatedAt: iso(1),
    })
    expect(pickAgentDmThread([walk, realDm], "a-mine", ME)?.id).toBe("d-mine")
    const s = sectionThreads(tiers({ unpinned: [walk, realDm] }), ME, {
      agentDmKeys: new Set(["agent:a-mine"]),
    })
    expect(ids(orderedGroup(s.channels))).toEqual(["c-walk"])
    expect(ids(orderedGroup(s.directMessages))).toEqual([])
    expect(threadMatchesQuery(walk, "s11-cloud", ME)).toBe(true)
  })

  it("keeps a listed agent's DM out of the group, matched by counterpart", () => {
    const mine = agentDm("d-mine", "a-mine", "Liaison")
    const s = sectionThreads(tiers({ unpinned: [mine, personDm("d-ann", "ann", "Ann")] }), ME, {
      agentDmKeys: new Set(["agent:a-mine"]),
    })
    expect(ids(orderedGroup(s.directMessages))).toEqual(["d-ann"])
  })
})

describe("pickAgentDmThread", () => {
  it("takes the most recently updated 1:1, never a room with a colleague in it", () => {
    const stale = agentDm("d-stale", "a-mine", "Liaison", { isPinned: true, updatedAt: iso(300) })
    const real = agentDm("d-real", "a-mine", "Liaison", { updatedAt: iso(1) })
    const group = thread("d-group", {
      updatedAt: iso(0),
      participants: [
        { id: ME, name: "Me", avatarUrl: null, participantType: "user", agentId: null },
        { id: "ann", name: "Ann", avatarUrl: null, participantType: "user", agentId: null },
        {
          id: "seat",
          name: "Liaison",
          avatarUrl: null,
          participantType: "agent",
          agentId: "a-mine",
        },
      ],
    })
    expect(pickAgentDmThread([stale, group, real], "a-mine", ME)?.id).toBe("d-real")
    expect(pickAgentDmThread([stale], undefined, ME)).toBeUndefined()
  })
})

describe("capChannels", () => {
  const many = Array.from({ length: CHANNEL_ROW_CAP + 3 }, (_, i) =>
    channel(`c${i}`, `Channel ${i}`, { updatedAt: iso(i) }),
  )

  it("shows the cap and folds the rest, but never folds an unread, pinned or active channel", () => {
    const unreadLast = { ...many[many.length - 1], unreadCount: 2 }
    const group = tiers({
      pinned: [channel("c-pin", "Pinned", { isPinned: true })],
      unpinned: [...many.slice(0, -1), unreadLast],
    })
    const { shown, folded } = capChannels(group, {
      searching: false,
      isActive: (id) => id === `c${CHANNEL_ROW_CAP + 1}`,
    })
    const visible = ids(orderedGroup(shown))
    expect(visible).toHaveLength(CHANNEL_ROW_CAP)
    expect(visible).toEqual(
      expect.arrayContaining(["c-pin", unreadLast.id, `c${CHANNEL_ROW_CAP + 1}`]),
    )
    expect(visible.length + folded.length).toBe(many.length + 1)
  })

  it("folds channels to three rows, pins first then recency (D32)", () => {
    expect(CHANNEL_ROW_CAP).toBe(3)
    const { shown, folded } = capChannels(
      tiers({ pinned: [channel("c-pin", "Pinned", { isPinned: true })], unpinned: many }),
      { searching: false },
    )
    expect(ids(orderedGroup(shown))).toEqual(["c-pin", "c0", "c1"])
    expect(folded).toHaveLength(many.length - 2)
  })

  it("folds nothing while a search is typed", () => {
    const { folded } = capChannels(tiers({ unpinned: many }), { searching: true })
    expect(folded).toEqual([])
  })
})

describe("splitUnread", () => {
  it("lifts unread rows into Unread, newest first, and out of their groups", () => {
    const eng = channel("c-eng", "Eng", {
      unreadCount: 3,
      lastMessage: { content: "x", authorId: "a", authorName: "A", createdAt: iso(30) } as never,
    })
    const ann = personDm("d-ann", "ann", "Ann", { unreadCount: 1, updatedAt: iso(2) })
    const ops = channel("c-ops", "Ops")
    const muted = channel("c-noise", "Noise", { unreadCount: 9, isMuted: true })
    const inbox = splitUnread({
      channels: tiers({ unpinned: [eng, ops, muted] }),
      directMessages: tiers({ unpinned: [ann] }),
    })
    expect(ids(inbox.unread)).toEqual(["d-ann", "c-eng"])
    expect(ids(orderedGroup(inbox.channels))).toEqual(["c-ops", "c-noise"])
    expect(groupIsEmpty(inbox.directMessages)).toBe(true)
  })

  it("lets a row from outside the groups (the personal DM) join Unread once", () => {
    const mine = agentDm("d-mine", "a-mine", "Liaison", { unreadCount: 2, updatedAt: iso(1) })
    const inbox = splitUnread(
      { channels: tiers({}), directMessages: tiers({ unpinned: [mine] }) },
      [mine],
    )
    expect(ids(inbox.unread)).toEqual(["d-mine"])
  })
})

describe("chatSections (D32 order)", () => {
  const mine: AgentDisplay = {
    id: "a-mine",
    handle: "@liaison",
    name: "Liaison",
    avatarUrl: null,
    kind: "personal",
    ownerUserId: ME,
  }
  const directory: AgentDisplay[] = [
    { id: "a-fin", handle: "@finance", name: "Finance Desk", avatarUrl: null, kind: "role" },
    mine,
    { id: "a-ann", handle: "@ann-agent", name: "Ann's agent", avatarUrl: null, kind: "personal" },
    { id: "a-ops", handle: "@ops", name: "Operations Desk", avatarUrl: null, kind: "role" },
    { id: "a-sup", handle: "@support", name: "Support Desk", avatarUrl: null, kind: "role" },
  ]
  const build = (
    rows: Thread[],
    over: Partial<Parameters<typeof chatSections>[0]> = {},
  ): ReturnType<typeof chatSections> =>
    chatSections({
      tiers: tiers({ unpinned: rows }),
      threads: rows,
      agents: directory,
      personalAgent: mine,
      currentUserId: ME,
      query: "",
      liftUnread: false,
      ...over,
    })
  const agentIds = (r: ReturnType<typeof chatSections>) => r.agents.map((a) => a.agent.id)

  it("lists the member's own agent first, marked mine, then every role agent, messaged or not", () => {
    const supDm = agentDm("d-sup", "a-sup", "Support Desk")
    const r = build([supDm, personDm("d-ann", "ann", "Ann")])
    expect(agentIds(r)).toEqual(["a-mine", "a-fin", "a-ops", "a-sup"])
    expect(r.agents.map((a) => a.mine)).toEqual([true, false, false, false])
    expect(r.agents.find((a) => a.agent.id === "a-sup")?.thread?.id).toBe("d-sup")
    expect(r.agents.find((a) => a.agent.id === "a-fin")?.thread).toBeUndefined()
  })

  it("keeps role agents' DMs out of Direct messages; people and another member's agent stay there", () => {
    const r = build([
      agentDm("d-sup", "a-sup", "Support Desk"),
      agentDm("d-mine", "a-mine", "Liaison"),
      agentDm("d-annagent", "a-ann", "Ann's agent"),
      personDm("d-ann", "ann", "Ann"),
    ])
    expect(ids(orderedGroup(r.directMessages))).toEqual(["d-annagent", "d-ann"])
    expect(agentIds(r)).not.toContain("a-ann")
  })

  it("narrows the agents by the search, on name or handle", () => {
    expect(agentIds(build([], { query: "desk" }))).toEqual(["a-fin", "a-ops", "a-sup"])
    expect(agentIds(build([], { query: "@supp" }))).toEqual(["a-sup"])
  })

  it("under a filter chip, lists only the agents whose DM passes it", () => {
    const supDm = agentDm("d-sup", "a-sup", "Support Desk", { unreadCount: 2 })
    const r = build([supDm, agentDm("d-mine", "a-mine", "Liaison")], {
      chip: (t) => t.unreadCount > 0,
    })
    expect(agentIds(r)).toEqual(["a-sup"])
  })

  it("on the inbox, an unread agent DM stays in Agents; Unread holds people and channels", () => {
    const supDm = agentDm("d-sup", "a-sup", "Support Desk", { unreadCount: 1, updatedAt: iso(1) })
    const mineDm = agentDm("d-mine", "a-mine", "Liaison", { unreadCount: 4, updatedAt: iso(2) })
    const eng = channel("c-eng", "Eng", { unreadCount: 2, updatedAt: iso(5) })
    const ann = personDm("d-ann", "ann", "Ann", { unreadCount: 1, updatedAt: iso(3) })
    const r = build([supDm, mineDm, eng, ann, channel("c-ops", "Ops")], { liftUnread: true })
    expect(ids(r.unread)).toEqual(["d-ann", "c-eng"])
    expect(agentIds(r)).toEqual(["a-mine", "a-fin", "a-ops", "a-sup"])
    expect(r.agents.find((a) => a.mine)?.thread?.id).toBe("d-mine")
    expect(r.agents.find((a) => a.agent.id === "a-sup")?.thread?.id).toBe("d-sup")
    expect(ids(orderedGroup(r.channels))).toEqual(["c-ops"])
    expect(groupIsEmpty(r.directMessages)).toBe(true)
  })

  it("keeps the member's own agent listed under a chip or a search when asked (the desktop anchor)", () => {
    const read = agentDm("d-mine", "a-mine", "Liaison")
    const chip = (t: Thread) => t.unreadCount > 0
    expect(agentIds(build([read], { chip }))).toEqual([])
    expect(agentIds(build([read], { chip, mineAlwaysListed: true }))).toEqual(["a-mine"])
    expect(agentIds(build([read], { query: "zzz", mineAlwaysListed: true }))).toEqual(["a-mine"])
  })

  it("lists no personal row when the member has no agent of their own", () => {
    expect(agentIds(build([], { personalAgent: undefined }))).toEqual(["a-fin", "a-ops", "a-sup"])
  })
})

describe("unjoinedChannels / threadMatchesQuery / mentionedThreadIds", () => {
  it("drops discoverable channels the store already holds, and narrows by query", () => {
    const disc: DiscoverableChannel[] = [
      {
        id: "c-eng",
        handle: "#eng",
        title: "Eng",
        topic: null,
        participantCount: 1,
        agentCount: 0,
      },
      {
        id: "c-art",
        handle: "#art",
        title: "Art",
        topic: null,
        participantCount: 1,
        agentCount: 0,
      },
      {
        id: "c-ops",
        handle: "#ops",
        title: "Ops",
        topic: null,
        participantCount: 1,
        agentCount: 0,
      },
    ]
    const held = [channel("c-eng", "Eng")]
    expect(unjoinedChannels(disc, held, "").map((c) => c.id)).toEqual(["c-art", "c-ops"])
    expect(unjoinedChannels(disc, held, "op").map((c) => c.id)).toEqual(["c-ops"])
  })

  it("matches a conversation by display name or handle", () => {
    const dm = personDm("d-ann", "ann", "Ann Lee")
    expect(threadMatchesQuery(dm, "ANN", ME)).toBe(true)
    expect(threadMatchesQuery(dm, "@d-a", ME)).toBe(true)
    expect(threadMatchesQuery(dm, "bob", ME)).toBe(false)
    expect(threadMatchesQuery(dm, "", ME)).toBe(true)
  })

  it("collects the threads an unread mention points at", () => {
    const base = {
      summary: "",
      urgency: 1,
      occurredAt: iso(1),
      action: { type: "open_url", url: "/" },
    }
    const set = mentionedThreadIds([
      { ...base, id: "1", app: "kernel", entity: "thread", entityId: "t1", kind: "mention" },
      {
        ...base,
        id: "2",
        app: "kernel",
        entity: "thread",
        entityId: "t2",
        kind: "thread_reply",
        alsoKinds: ["mention"],
      },
      { ...base, id: "3", app: "kernel", entity: "thread", entityId: "t3", kind: "thread_reply" },
      { ...base, id: "4", app: "tickets", entity: "ticket", entityId: "t4", kind: "mention" },
    ] as never)
    expect([...set].sort()).toEqual(["t1", "t2"])
  })
})
