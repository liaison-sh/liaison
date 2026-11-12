// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHO AN AGENT POST REACHES, DECIDED ONCE FOR THE DISPATCH AND THE HANDLER (scope-taint.ts,
// rules 11 and 14).
//
// A post into a kernel thread is stamped with what the turn read (`requiredScopes`), and the
// messages filter hides it from every reader lacking one of those scopes. A post acting for a
// requester is never written hidden from the people it addresses. Given the stamp and where
// the post lands, this answers one of:
//
//   - clear:     every other person of the conversation holds the stamp; written as it is.
//   - disclose:  written inline, with these people on its disclosure list, because
//                a. "dm": the conversation is a plain one of the requester and exactly one other
//                   person (agents do not count): telling that person is the requester's choice;
//                b. "standing": the requester already approved disclosing posts of this thread
//                   (rule 11b) covering every scope of the stamp to every person now lacking it.
//   - requester_lacks: the requester does not hold every scope of the stamp (a routine or agent
//                turn read past its owner's grants). Nobody entitled can disclose it: refused.
//   - gap:       some other person lacks it and nothing above covers them: the dispatch parks
//                the post for the requester's approval (rule 11), and the handler, reached
//                without that approval, refuses rather than writing it hidden.
//
// The standing disclosure is read off the approved posts themselves: a post written by an
// approved rule-11 re-entry carries `metadata.taintDisclosureApprovalId`, its stamp and its
// disclosure list. Those of the same requester in the same thread, whose approval row is
// theirs and was a disclosure, union into (scopes T, audience A). Approving another one widens
// both; nothing else is stored. A person removed from the thread drops out because the list is
// always intersected with the thread's people at write time.

import { sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { threads } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { UNKNOWN_TURN_TAINT } from "~/modules/agent/scopes/scope-taint"
import {
  holdsEveryScope,
  loadOrgMemberGrants,
  type TaintAudienceGap,
  threadPeopleIds,
} from "~/modules/agent/scopes/taint-approval-audience"
import { expandWildcardStamp } from "~/modules/agent/scopes/taint-read-scopes"
import { untitledDmQuery } from "~/modules/threads/thread"

/** Metadata key on a post written by an approved disclosure: the approval that decided it. */
export const TAINT_DISCLOSURE_APPROVAL_KEY = "taintDisclosureApprovalId"

export type PostDisclosureDecision =
  | { kind: "clear" }
  | { kind: "disclose"; via: "dm" | "standing"; disclosureList: string[] }
  | ({ kind: "gap" } & TaintAudienceGap)
  /** The requester does not hold what the post carries: nobody entitled can disclose it. */
  | ({ kind: "requester_lacks" } & TaintAudienceGap)

const UNCOUNTED: PostDisclosureDecision = { kind: "gap", missingScopes: [], lacking: null }

/**
 * Where the post lands: an existing thread, or the people of a thread being created. `newThread`:
 * a titled or forced create, which writes into a thread of its own (no existing conversation, so
 * neither a direct message by dedupe nor a standing disclosure). `noShortcut`: the write also
 * carries unstamped text (a title, references) every later member reads, which only an approval
 * may disclose.
 */
export type PostTarget =
  | { threadId: string }
  | { participantIds: readonly string[]; newThread?: boolean; noShortcut?: boolean }

/**
 * The standing disclosure the requester holds on `threadId` (rule 14): the union of the stamps
 * and of the disclosure lists of their approved disclosed posts there. Null when there is none.
 */
export async function standingPostDisclosure(opts: {
  orgId: string
  requesterUserId: string
  threadId: string
}): Promise<{ scopes: Set<string>; audience: Set<string> } | null> {
  const k = schemaRef("kernel")
  const rows = await withPrivilegedDb(opts.orgId, "agent-post-standing-disclosure", async (tx) =>
    extractRows<{ required_scopes: string[] | null; disclosure_list: string[] | null }>(
      await tx.execute(drizzleSql`
        SELECT m.required_scopes, m.disclosure_list::text[] AS disclosure_list
        FROM ${drizzleSql.raw(k)}.messages m
        JOIN ${drizzleSql.raw(k)}.approval_requests a
          ON a.org_id = m.org_id
         AND a.id::text = m.metadata->>${TAINT_DISCLOSURE_APPROVAL_KEY}
        WHERE m.org_id = ${opts.orgId}::uuid
          AND m.thread_id = ${opts.threadId}::uuid
          AND m.author_type = 'agent'
          AND m.deleted_at IS NULL
          AND m.metadata ? ${TAINT_DISCLOSURE_APPROVAL_KEY}
          AND a.status = 'approved'
          AND a.requested_by = ${opts.requesterUserId}::uuid
          AND (a.metadata->>'taintDisclosedToReaders')::boolean IS TRUE`),
    ),
  )
  if (rows.length === 0) return null
  const scopes = new Set<string>()
  const audience = new Set<string>()
  for (const row of rows) {
    for (const s of row.required_scopes ?? []) scopes.add(s)
    for (const u of row.disclosure_list ?? []) audience.add(u)
  }
  return { scopes, audience }
}

/** The untitled plain thread of exactly these people, the one an untitled create lands in. */
async function existingConversationOf(orgId: string, people: string[]): Promise<string | null> {
  const rows = await withPrivilegedDb(orgId, "agent-post-existing-conversation", async (tx) =>
    extractRows<{ id: string }>(await tx.execute(untitledDmQuery(orgId, [...people].sort()))),
  )
  return rows[0]?.id ?? null
}

/**
 * Decide how a post stamped `stamp`, made for `requesterUserId`, reaches the people of `target`
 * (see the header). Fails closed: an unknown taint, an id that is no account of the org or a
 * failed lookup is an uncounted gap, which nothing discloses to.
 */
export async function decidePostDisclosure(opts: {
  orgId: string
  requesterUserId: string
  stamp: readonly string[]
  target: PostTarget
}): Promise<PostDisclosureDecision> {
  if (opts.stamp.some((s) => UNKNOWN_TURN_TAINT.includes(s))) return UNCOUNTED
  const stamp = expandWildcardStamp(opts.stamp, opts.orgId)
  if (stamp.length === 0) return { kind: "clear" }
  try {
    let threadId: string | null
    let people: string[]
    // A direct message is a plain conversation of exactly two people: not a channel, not
    // discoverable, not titled or pinned, not created from an entity (a task's or a record's
    // discussion). The same shape an untitled create dedupes into (untitledDmQuery).
    let dmShaped = false
    const shortcuts = !("noShortcut" in opts.target && opts.target.noShortcut === true)
    if ("threadId" in opts.target) {
      threadId = opts.target.threadId
      people = await threadPeopleIds(opts.orgId, threadId)
      const [row] = await withPrivilegedDb(opts.orgId, "agent-post-thread-shape", (tx) =>
        tx
          .select({
            type: threads.type,
            title: threads.title,
            discoverable: threads.discoverable,
            isPinned: threads.isPinned,
            createdFrom: threads.createdFrom,
          })
          .from(threads)
          .where(eq(threads.id, threadId as string)),
      )
      dmShaped =
        row?.type === "thread" &&
        row.title === null &&
        row.discoverable === false &&
        row.isPinned === false &&
        row.createdFrom === null
    } else {
      people = [...new Set([opts.requesterUserId, ...opts.target.participantIds])].filter(
        (u) => u !== "",
      )
      threadId = null
      dmShaped = opts.target.newThread !== true
    }
    people = [...new Set([opts.requesterUserId, ...people])]
    const members = await loadOrgMemberGrants(opts.orgId, { userIds: people })
    if (members.length !== people.length) return UNCOUNTED
    const lackers = new Set<string>()
    const missing = new Set<string>()
    const requesterMissing = new Set<string>()
    for (const m of members) {
      if (holdsEveryScope(m.scopes, stamp)) continue
      lackers.add(m.id)
      for (const s of stamp) {
        if (holdsEveryScope(m.scopes, [s])) continue
        missing.add(s)
        if (m.id === opts.requesterUserId) requesterMissing.add(s)
      }
    }
    // Only a requester who holds everything the post carries may disclose it (a routine's or an
    // agent's turn can read past its owner's own grants). Nothing below applies to them.
    if (lackers.has(opts.requesterUserId)) {
      return { kind: "requester_lacks", missingScopes: [...requesterMissing].sort(), lacking: 1 }
    }
    const others = people.filter((u) => u !== opts.requesterUserId)
    const otherLackers = others.filter((u) => lackers.has(u))
    if (otherLackers.length === 0) return { kind: "clear" }
    const gap: PostDisclosureDecision = {
      kind: "gap",
      missingScopes: [...missing].sort(),
      lacking: otherLackers.length,
    }
    if (!shortcuts) return gap
    // A DIRECT MESSAGE: the requester and exactly one other person. Agents are no people here.
    if (dmShaped && others.length === 1) {
      return { kind: "disclose", via: "dm", disclosureList: [opts.requesterUserId, others[0]] }
    }
    // The thread the post writes into: an untitled create lands in the existing conversation.
    if (threadId === null && !("newThread" in opts.target && opts.target.newThread === true)) {
      threadId = await existingConversationOf(opts.orgId, people)
    }
    if (threadId !== null) {
      const standing = await standingPostDisclosure({
        orgId: opts.orgId,
        requesterUserId: opts.requesterUserId,
        threadId,
      })
      if (
        standing !== null &&
        stamp.every((s) => standing.scopes.has(s)) &&
        otherLackers.every((u) => standing.audience.has(u))
      ) {
        return {
          kind: "disclose",
          via: "standing",
          disclosureList: [
            ...new Set([opts.requesterUserId, ...people.filter((u) => standing.audience.has(u))]),
          ],
        }
      }
    }
    return gap
  } catch {
    return UNCOUNTED
  }
}
