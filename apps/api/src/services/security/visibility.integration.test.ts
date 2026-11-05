// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Add-member visibility warning (spec-security.md, "Add-member warning", A14):
// before a human is added to a room, the adder is warned when that human would
// land on hidden history. The backend answer is one boolean; the copy and the
// rendering are 4b's.
//
// Everything here is real: real orgs, users, threads, messages with real
// required_scopes and disclosure_list values, and real grant rows read through
// the production permissions path. The adder's own client is a real RLS
// context, so the caller-authorisation half is exercised by the database.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { queryAuditLogPage } from "~/modules/audit/service"
import {
  recordWithheldCapabilityAudit,
  wouldRevealHiddenHistory,
} from "~/services/security/visibility"

const APP = "vwq"
const ALPHA = `${APP}:alpha:read`
const BETA = `${APP}:beta:read`
const GAMMA = `${APP}:gamma:read`

const ORG_ID = crypto.randomUUID()
const tag = ORG_ID.slice(0, 8)

// The adder: a room member holding ALPHA and BETA, never GAMMA. Everything the
// function is asked runs on this person's RLS client.
const ADDER = crypto.randomUUID()
// Candidates, none of them in the room unless the case says so.
const CAND_FULL = crypto.randomUUID() // holds vwq:*, so the whole room is readable
const CAND_NONE = crypto.randomUUID() // holds nothing at all
const CAND_PARTIAL = crypto.randomUUID() // holds ALPHA only
const CAND_LIKE_ADDER = crypto.randomUUID() // holds exactly what the adder holds
const CAND_DISCLOSED = crypto.randomUUID() // holds nothing, but is on a disclosure list
const MEMBER_NO_GRANTS = crypto.randomUUID() // already in the room, holds nothing

const ROOM = crypto.randomUUID() // open, alpha, beta and gamma messages
const EMPTY_ROOM = crypto.randomUUID() // no messages at all
const DISCLOSURE_ROOM = crypto.randomUUID() // one scoped message, disclosed to CAND_DISCLOSED
const DELETED_ROOM = crypto.randomUUID() // one scoped message, soft deleted
const FOREIGN_ROOM = crypto.randomUUID() // same org, the adder is not a participant

// Distinctive fixture strings: the A14 shape case asserts none of them can
// reach the answer.
const OPEN_CONTENT = `${APP}-open-content`
const ALPHA_CONTENT = `${APP}-alpha-content`
const GAMMA_CONTENT = `${APP}-gamma-content`

const messageIds = new Map<string, string>()

function idOf(key: string): string {
  const id = messageIds.get(key)
  if (!id) throw new Error(`fixture message ${key} was not inserted`)
  return id
}

async function addUser(id: string, name: string): Promise<void> {
  await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
    VALUES (${id}, ${ORG_ID}, ${`vis-warn-${name}-${tag}@test.com`}, ${name}, 'x')`
}

async function grant(userId: string, scope: string): Promise<void> {
  await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
    VALUES (${userId}, ${ORG_ID}, ${scope})`
}

async function addThread(id: string, handle: string, participants: string[]): Promise<void> {
  await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by)
    VALUES (${id}, ${ORG_ID}, ${`${handle}-${tag}`}, ${ADDER})`
  for (const userId of participants) {
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${id}, ${userId}, ${ORG_ID})`
  }
}

async function addMessage(
  key: string,
  threadId: string,
  content: string,
  requiredScopes: string[],
  disclosureList: string[] | null,
): Promise<void> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO kernel.messages
      (thread_id, org_id, author_id, content, required_scopes, disclosure_list)
    VALUES (${threadId}, ${ORG_ID}, ${ADDER}, ${content},
      ${requiredScopes}::text[], ${disclosureList}::uuid[])
    RETURNING id`
  messageIds.set(key, row?.id ?? "")
}

/** The adder's real RLS context, built from the adder's real grant rows. */
const adderCtx: UserContext = {
  actorType: "user",
  userId: ADDER,
  orgId: ORG_ID,
  scopes: [ALPHA, BETA],
  dimensionGrants: {},
}

/** Ask the question the way a route would: on the adder's own RLS client. */
async function asksAbout(threadId: string, candidateUserId: string): Promise<boolean> {
  return withRlsContext(adderCtx, (tx) => wouldRevealHiddenHistory(tx, threadId, candidateUserId))
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG_ID}, 'VisWarnOrg', ${`vis-warn-${tag}`})`
  await addUser(ADDER, "adder")
  await addUser(CAND_FULL, "candfull")
  await addUser(CAND_NONE, "candnone")
  await addUser(CAND_PARTIAL, "candpartial")
  await addUser(CAND_LIKE_ADDER, "candlikeadder")
  await addUser(CAND_DISCLOSED, "canddisclosed")
  await addUser(MEMBER_NO_GRANTS, "membernogrants")

  await grant(ADDER, ALPHA)
  await grant(ADDER, BETA)
  await grant(CAND_FULL, `${APP}:*`)
  await grant(CAND_PARTIAL, ALPHA)
  await grant(CAND_LIKE_ADDER, ALPHA)
  await grant(CAND_LIKE_ADDER, BETA)

  await addThread(ROOM, "vis-warn-room", [ADDER, MEMBER_NO_GRANTS])
  await addThread(EMPTY_ROOM, "vis-warn-empty", [ADDER])
  await addThread(DISCLOSURE_ROOM, "vis-warn-disclosure", [ADDER])
  await addThread(DELETED_ROOM, "vis-warn-deleted", [ADDER])
  await addThread(FOREIGN_ROOM, "vis-warn-foreign", [MEMBER_NO_GRANTS])

  await addMessage("open", ROOM, OPEN_CONTENT, [], null)
  await addMessage("alpha", ROOM, ALPHA_CONTENT, [ALPHA], null)
  await addMessage("beta", ROOM, `${APP}-beta-content`, [BETA], null)
  // The adder cannot read this one either: the answer must still account for it.
  await addMessage("gamma", ROOM, GAMMA_CONTENT, [GAMMA], null)
  await addMessage("deleted", DELETED_ROOM, `${APP}-deleted-content`, [GAMMA], null)
  await sql`UPDATE kernel.messages SET deleted_at = now() WHERE id = ${idOf("deleted")}`

  await addMessage(
    "disclosed",
    DISCLOSURE_ROOM,
    `${APP}-disclosed-content`,
    [BETA],
    [CAND_DISCLOSED],
  )
  await addMessage("foreign", FOREIGN_ROOM, `${APP}-foreign-content`, [GAMMA], null)
})

afterAll(async () => {
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
})

describe("wouldRevealHiddenHistory: the add-member visibility warning", () => {
  it("returns true when the thread has a message the candidate grants do not cover", async () => {
    expect(await asksAbout(ROOM, CAND_NONE)).toBe(true)
  })

  it("returns false when every message in the thread is within the candidate grants", async () => {
    expect(await asksAbout(ROOM, CAND_FULL)).toBe(false)
  })

  it("returns true for a candidate who covers part of the thread only", async () => {
    expect(await asksAbout(ROOM, CAND_PARTIAL)).toBe(true)
  })

  it("counts a message the adder cannot see either", async () => {
    // CAND_LIKE_ADDER holds exactly the adder's grants, so the only message
    // hidden from the candidate is the GAMMA one, which is hidden from the
    // adder too. An answer computed from what the ADDER can read would say
    // false here and the warning would never fire.
    expect(await asksAbout(ROOM, CAND_LIKE_ADDER)).toBe(true)
  })

  it("an empty thread hides nothing", async () => {
    expect(await asksAbout(EMPTY_ROOM, CAND_NONE)).toBe(false)
  })

  it("a soft deleted message is not history the candidate would land on", async () => {
    // The only row in this room is soft deleted and GAMMA scoped, which the
    // candidate does not hold: counting it would raise a warning about history
    // nobody can read any more.
    expect(await asksAbout(DELETED_ROOM, CAND_NONE)).toBe(false)
  })

  it("a candidate on a message disclosure list is not hidden from it", async () => {
    expect(await asksAbout(DISCLOSURE_ROOM, CAND_DISCLOSED)).toBe(false)
    // Same room, same message, a candidate who is neither granted nor disclosed.
    expect(await asksAbout(DISCLOSURE_ROOM, CAND_NONE)).toBe(true)
  })

  it("a candidate already in the room is never reported on", async () => {
    // MEMBER_NO_GRANTS holds nothing and would score true on the message set,
    // but they are already a participant: adding them reveals nothing new, and
    // answering would turn the add dialog into a grant oracle on a colleague.
    expect(await asksAbout(ROOM, MEMBER_NO_GRANTS)).toBe(false)
  })

  it("a thread the caller cannot see is never answered for", async () => {
    expect(await asksAbout(FOREIGN_ROOM, CAND_NONE)).toBe(false)
    expect(await asksAbout(crypto.randomUUID(), CAND_NONE)).toBe(false)
  })

  it("the add-member answer says how much is hidden, never what", async () => {
    // A14: a boolean and nothing else. No count, no scope name, no author, no
    // timestamp, no message id, no content, not even the candidate's id.
    const answers = [
      await asksAbout(ROOM, CAND_NONE),
      await asksAbout(ROOM, CAND_PARTIAL),
      await asksAbout(ROOM, CAND_FULL),
    ]
    for (const answer of answers) {
      expect(typeof answer).toBe("boolean")
      const serialised = JSON.stringify(answer)
      expect(["true", "false"]).toContain(serialised)
      const forbidden = [
        ALPHA,
        BETA,
        GAMMA,
        APP,
        OPEN_CONTENT,
        ALPHA_CONTENT,
        GAMMA_CONTENT,
        ADDER,
        CAND_NONE,
        CAND_PARTIAL,
        ORG_ID,
        ROOM,
        ...messageIds.values(),
      ]
      for (const secret of forbidden) {
        expect({ secret, leaked: serialised.includes(secret) }).toEqual({ secret, leaked: false })
      }
    }
  })
})

// The private withheld-capability card (spec-security.md A14, "Audit rows"):
// every time the requester is shown it, one audit row records what was withheld,
// so a later review can reconstruct the card without the row carrying the data
// the card withheld. Real rows throughout: a real org, real users, a real agent
// (audit_log.agent_id's FK is enforced), and reads through the real audit_log
// SELECT policy and the real audit read service.
describe("recordWithheldCapabilityAudit: showing the private withheld card is audited", () => {
  const CARD_APP = "wca"
  const PAYOUTS = `${CARD_APP}:payouts:read`
  const SALARIES = `${CARD_APP}:salaries:read`
  const WITHHELD = [PAYOUTS, SALARIES]

  const CARD_ORG = crypto.randomUUID()
  const OTHER_ORG = crypto.randomUUID()
  const cardTag = CARD_ORG.slice(0, 8)

  const REQUESTER = crypto.randomUUID() // the human the card is shown to
  const ROOMMATE = crypto.randomUUID() // another human in the same room
  const OUTSIDER = crypto.randomUUID() // a member of a different org
  const CARD_AGENT = crypto.randomUUID() // the agent whose ceiling the room floored
  const UNKNOWN_AGENT = crypto.randomUUID() // no kernel.agents row: the FK refuses it
  const CARD_ROOM = crypto.randomUUID()

  type CardAuditRow = {
    action: string
    actor_id: string | null
    actor_type: string
    app: string | null
    entity_type: string | null
    entity_id: string | null
    agent_id: string | null
    requester_user_id: string | null
    room_member_snapshot: string[] | null
    effective_scope: string[] | null
    disclosure_list: string[] | null
    metadata: Record<string, unknown> | null
  }

  /** Every withheld-card audit row an org has, oldest first. */
  async function cardAuditRows(orgId: string = CARD_ORG): Promise<CardAuditRow[]> {
    return sql<CardAuditRow[]>`
      SELECT action, actor_id, actor_type, app, entity_type, entity_id, agent_id,
             requester_user_id, room_member_snapshot, effective_scope, disclosure_list, metadata
        FROM kernel.audit_log
       WHERE org_id = ${orgId} AND action = 'withheld_capability_shown'
       ORDER BY timestamp, id`
  }

  const cardCtx = (userId: string, orgId: string): UserContext => ({
    actorType: "user",
    userId,
    orgId,
    scopes: [],
    dimensionGrants: {},
  })

  /** Record a shown card the way its render point would: on the requester's client. */
  async function showCard(params: {
    agentId?: string
    requesterId?: string
    withheldScopes: string[]
  }): Promise<void> {
    const requesterId = params.requesterId ?? REQUESTER
    await withRlsContext(cardCtx(requesterId, CARD_ORG), (tx) =>
      recordWithheldCapabilityAudit(tx, {
        orgId: CARD_ORG,
        agentId: params.agentId ?? CARD_AGENT,
        requesterId,
        roomId: CARD_ROOM,
        withheldScopes: params.withheldScopes,
      }),
    )
  }

  beforeAll(async () => {
    for (const [orgId, name] of [
      [CARD_ORG, "CardOrg"],
      [OTHER_ORG, "CardOtherOrg"],
    ] as const) {
      await sql`INSERT INTO kernel.organizations (id, name, slug)
        VALUES (${orgId}, ${name}, ${`${name.toLowerCase()}-${orgId.slice(0, 8)}`})`
    }
    for (const [id, orgId, name] of [
      [REQUESTER, CARD_ORG, "requester"],
      [ROOMMATE, CARD_ORG, "roommate"],
      [OUTSIDER, OTHER_ORG, "outsider"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${id}, ${orgId}, ${`wca-${name}-${cardTag}@test.com`}, ${name}, 'x')`
    }
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${CARD_AGENT}, ${CARD_ORG}, 'personal', ${`@wca-${cardTag}`}, 'Card agent',
        ${REQUESTER}, ${JSON.stringify(WITHHELD)}::jsonb)`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by)
      VALUES (${CARD_ROOM}, ${CARD_ORG}, ${`wca-room-${cardTag}`}, ${REQUESTER})`
    for (const userId of [REQUESTER, ROOMMATE]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${CARD_ROOM}, ${userId}, ${CARD_ORG})`
    }
  })

  afterAll(async () => {
    for (const orgId of [CARD_ORG, OTHER_ORG]) {
      await sql`DELETE FROM kernel.audit_log WHERE org_id = ${orgId}`
      await sql`DELETE FROM kernel.messages WHERE org_id = ${orgId}`
      await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${orgId}`
      await sql`DELETE FROM kernel.threads WHERE org_id = ${orgId}`
      await sql`DELETE FROM kernel.agents WHERE org_id = ${orgId}`
      await sql`DELETE FROM kernel.users WHERE org_id = ${orgId}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
    }
  })

  it("recordWithheldCapabilityAudit writes one audit_log row with action withheld_capability_shown naming the withheld scopes", async () => {
    const before = (await cardAuditRows()).length
    await showCard({ withheldScopes: WITHHELD })

    const rows = await cardAuditRows()
    expect(rows).toHaveLength(before + 1)
    const row = rows[rows.length - 1]

    expect(row?.action).toBe("withheld_capability_shown")
    // Who was shown the card, and which agent's ceiling the room floored. The
    // agent is recorded independently of the human, as on every agent-turn row.
    expect(row?.actor_id).toBe(REQUESTER)
    expect(row?.actor_type).toBe("user")
    expect(row?.requester_user_id).toBe(REQUESTER)
    expect(row?.agent_id).toBe(CARD_AGENT)
    // Where.
    expect(row?.app).toBe("kernel")
    expect(row?.entity_type).toBe("thread")
    expect(row?.entity_id).toBe(CARD_ROOM)
    // What was withheld: the scope names, in the opaque metadata column.
    expect(row?.metadata?.withheldScopes).toEqual(WITHHELD)
  })

  it("a turn with nothing withheld writes no audit row", async () => {
    const before = (await cardAuditRows()).length
    await showCard({ withheldScopes: [] })
    // No card is shown when nothing was withheld, so there is nothing to record.
    // The guard lives in the function so the render point can call it blind.
    expect(await cardAuditRows()).toHaveLength(before)
  })

  it("the withheld scope names reach the opaque metadata only, never a column a non-audit reader stumbles on", async () => {
    await showCard({ withheldScopes: WITHHELD })
    const rows = await cardAuditRows()
    const row = rows[rows.length - 1]

    // T03's disclosure columns stay null: a private card discloses nothing to
    // anybody, so there is no effective scope, no member snapshot and no
    // disclosure list to record. Putting the withheld names in effective_scope
    // would both mislabel them and expose them to a reader scanning columns.
    expect(row?.effective_scope).toBeNull()
    expect(row?.disclosure_list).toBeNull()
    expect(row?.room_member_snapshot).toBeNull()

    const { metadata: _metadata, ...everythingElse } = row ?? {}
    const serialised = JSON.stringify(everythingElse)
    for (const scope of WITHHELD) {
      expect({ scope, leaked: serialised.includes(scope) }).toEqual({ scope, leaked: false })
    }
  })

  it("another org never reads the card audit row through the audit read path", async () => {
    await showCard({ withheldScopes: WITHHELD })

    // The outsider's own org has no such row.
    const own = await withRlsContext(cardCtx(OUTSIDER, OTHER_ORG), (tx) =>
      queryAuditLogPage(tx, OTHER_ORG, { action: "withheld_capability_shown" }),
    )
    expect(own.entries).toHaveLength(0)
    expect(own.total).toBe(0)

    // Naming the card owner's org from outside it reads nothing either: the
    // audit_log SELECT policy keys on the caller's own org GUC, not the
    // argument, so the filter cannot reach across the boundary.
    const across = await withRlsContext(cardCtx(OUTSIDER, OTHER_ORG), (tx) =>
      queryAuditLogPage(tx, CARD_ORG, { action: "withheld_capability_shown" }),
    )
    expect(across.entries).toHaveLength(0)
    expect(across.total).toBe(0)
  })

  it("the card names live in the audit log alone, never on a surface the room renders", async () => {
    await showCard({ withheldScopes: WITHHELD })

    // Stated plainly, because it is the real boundary: kernel.audit_log is an
    // org-wide append-only log and its SELECT policy admits ANY member of the
    // org, so RLS is not what keeps a roommate out. The gate is the read path
    // itself, /api/audit, mounted under requireScope("kernel:audit:read").
    const roommate = await withRlsContext(cardCtx(ROOMMATE, CARD_ORG), (tx) =>
      queryAuditLogPage(tx, CARD_ORG, { action: "withheld_capability_shown" }),
    )
    expect(roommate.entries.length).toBeGreaterThan(0)

    // What A14 actually requires of this task: recording the card must not put
    // the withheld names anywhere the ROOM shows. Nothing was written to the
    // room, so no message carries them in its content or its scope tag.
    const [leak] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.messages
       WHERE org_id = ${CARD_ORG}
         AND (content LIKE ${`%${CARD_APP}:%`} OR required_scopes && ${WITHHELD}::text[])`
    expect(leak?.n).toBe(0)
  })

  it("a failed card audit insert propagates instead of being swallowed", async () => {
    const before = (await cardAuditRows()).length

    // An unrecorded card is exactly what this task exists to prevent, so a
    // failed INSERT must reach the caller rather than be logged and dropped,
    // which is what writeAuditLog's default would do (T19).
    //
    // The failure is triggered by an org the log has no row for
    // (audit_log_org_fk), NOT by an unknown agent: naming a DELETED agent now
    // costs the row its agent name and nothing else (P4b-D2), which the next
    // case pins. postgres.js is lazy, so the call is awaited in the assertion.
    await expect(
      (async () => {
        await withRlsContext(cardCtx(REQUESTER, CARD_ORG), (tx) =>
          recordWithheldCapabilityAudit(tx, {
            orgId: crypto.randomUUID(),
            agentId: CARD_AGENT,
            requesterId: REQUESTER,
            roomId: CARD_ROOM,
            withheldScopes: WITHHELD,
          }),
        )
      })(),
    ).rejects.toThrow()

    expect(await cardAuditRows()).toHaveLength(before)
  })

  it("an agent deleted since the turn costs the row its agent name, never the row", async () => {
    const before = (await cardAuditRows()).length
    await showCard({ agentId: UNKNOWN_AGENT, withheldScopes: WITHHELD })
    const rows = await cardAuditRows()
    expect(rows).toHaveLength(before + 1)
    const row = rows[rows.length - 1]
    expect(row?.agent_id).toBeNull()
    expect(row?.requester_user_id).toBe(REQUESTER)
  })
})
