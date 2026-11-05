// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, asc, sql as drizzleSql, eq, isNull } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { messages, threadParticipants, threads } from "~/db/schema/kernel"
import {
  checkScopeTaint,
  type ScopeTaintBlockedError,
  type TaintOriginRows,
  toScopeTaintBlockedError,
  UNKNOWN_TURN_TAINT,
} from "~/modules/agent/scopes/scope-taint"
import { resolveAuditAgentId } from "~/modules/audit/resolve-agent"
import { writeAuditLog } from "~/modules/audit/service"
import { hasScope, loadEffectivePermissions } from "~/modules/permissions/permissions"

export interface VisibilityMessage {
  requiredScopes: string[]
  disclosureList: string[] | null
}

export interface VisibilityViewer {
  userId: string
  grants: string[]
}

/**
 * App-level mirror of the messages SELECT policy's scope/disclosure half:
 * `viewer.grants covers every requiredScopes entry OR viewer.userId in disclosureList`.
 * Room membership is the caller's check. Scope coverage uses `hasScope`, so a
 * `*`, `<prefix>:*` or parent grant covers its children exactly as elsewhere in the
 * API. An empty requiredScopes array is visible to every member, grants or not.
 * Fails closed: a missing requiredScopes array or an empty scope string never
 * satisfies the scope branch, and an empty viewer id never matches the disclosure list.
 */
export function isMessageVisible(message: VisibilityMessage, viewer: VisibilityViewer): boolean {
  const { requiredScopes, disclosureList } = message
  // Every element must be a STRING before it reaches hasScope. A non-string
  // entry used to throw a TypeError out of `required.split`, which aborted the
  // whole caller (context assembly) instead of excluding the one row that could
  // not be read. Fail closed means EXCLUDE the row, never abort the turn.
  const scopesHeld =
    Array.isArray(requiredScopes) &&
    requiredScopes.every((s) => typeof s === "string" && hasScope(s, viewer.grants))
  if (scopesHeld) return true
  return (
    viewer.userId !== "" && Array.isArray(disclosureList) && disclosureList.includes(viewer.userId)
  )
}

/**
 * DOES THIS VIEWER HOLD EVERY SCOPE ON THE ROW?
 *
 * Narrower than `isMessageVisible` on purpose: that predicate also lets a
 * DISCLOSED viewer read the row, and a disclosed viewer is precisely somebody
 * who does not hold the scopes. The read path projects `requiredScopes` on a
 * row only to viewers this returns true for, so the owner of a reply can see
 * why it is hidden to the rest of the room while nobody learns a scope name
 * they do not already hold.
 *
 * Fails closed the same way: a missing or unreadable array is not "no scopes",
 * it is "not readable", and nothing is projected.
 */
export function viewerHoldsEveryScope(
  message: Pick<VisibilityMessage, "requiredScopes">,
  viewer: VisibilityViewer,
): boolean {
  const { requiredScopes } = message
  if (!Array.isArray(requiredScopes)) return false
  return requiredScopes.every((s) => typeof s === "string" && hasScope(s, viewer.grants))
}

/**
 * The visibility facts a LIVE `message` event must carry so the websocket
 * fan-out can run `isMessageVisible` per connection, spread straight into the
 * event's `data`.
 *
 * The fan-out fails closed: a kernel message frame with no `requiredScopes`
 * ARRAY reaches nobody. That default is the whole point, so this helper never
 * manufactures one. `[]` is a positive assertion that the row carries no scoped
 * data, exactly as it is on the write path, and sending it for a row whose
 * scopes could not be read would publish a scoped message to the entire room.
 *
 * So an undeterminable row returns `{}`, i.e. NO keys: the event goes out
 * untagged, the fan-out hides it from everyone, and the message is still read
 * on the next fetch where RLS decides. Losing a live update is recoverable;
 * leaking one is not.
 *
 * A `disclosureList` that is absent, null or unreadable becomes `null`, which
 * only ever narrows: it withholds a live copy from a disclosed-to member rather
 * than inventing a disclosure the row does not have.
 */
export function messageVisibilityFacts(row: {
  requiredScopes?: unknown
  disclosureList?: unknown
}): { requiredScopes: string[]; disclosureList: string[] | null } | Record<string, never> {
  const { requiredScopes, disclosureList } = row
  if (!Array.isArray(requiredScopes) || requiredScopes.some((s) => typeof s !== "string")) {
    return {}
  }
  const disclosed =
    Array.isArray(disclosureList) && disclosureList.every((id) => typeof id === "string")
      ? (disclosureList as string[])
      : null
  return { requiredScopes: requiredScopes as string[], disclosureList: disclosed }
}

/** A message as seen by the run walker: the visibility inputs plus its own id. */
export interface IdentifiedVisibilityMessage extends VisibilityMessage {
  id: string
}

/**
 * One maximal run of consecutive messages the viewer cannot see.
 * `afterMessageId` is the id of the last message the viewer CAN see before the
 * run, or null when the run starts at the top of the thread.
 */
export interface HiddenRun {
  afterMessageId: string | null
  count: number
}

/**
 * Position and size of every contiguous run of hidden messages in an ordered
 * thread, the data the "N messages hidden" marker needs (rendering is not here).
 * Pure: no database access, no IO, the message list is whatever the caller
 * already holds, in thread order.
 *
 * Visibility is `isMessageVisible`, reused as-is, so the marker can never
 * disagree with the read predicate or with the RLS policy that mirrors it.
 *
 * Privacy (A14): a run discloses only that N messages exist and where. The
 * anchor is a message the viewer can already see; a hidden message's id, its
 * required scopes, its author, its timestamp and its content never leave this
 * function. Nothing distinguishes a scope-hidden message from an
 * undisclosed one, and nothing says how many distinct scopes a run spans.
 */
export function countHiddenRuns(
  messages: IdentifiedVisibilityMessage[],
  viewer: VisibilityViewer,
): HiddenRun[] {
  const runs: HiddenRun[] = []
  let lastVisibleId: string | null = null
  let openRun: HiddenRun | null = null
  for (const message of messages) {
    if (isMessageVisible(message, viewer)) {
      lastVisibleId = message.id
      openRun = null
      continue
    }
    if (openRun === null) {
      openRun = { afterMessageId: lastVisibleId, count: 1 }
      runs.push(openRun)
    } else {
      openRun.count += 1
    }
  }
  return runs
}

/**
 * The minimum an item must carry to be filtered for a turn's context.
 *
 * `disclosureList` is OPTIONAL because two of the three sinks do not have the
 * column: `kernel.agent_memory` and `app_knowledge.documents` carry
 * `required_scopes` only, and just `kernel.messages` has `disclosure_list`. An
 * absent list normalises to `null`, i.e. no disclosure, never a wildcard: read
 * as "disclosed to everybody" it would hand every scoped memory row to every
 * turn, which is the leak this module exists to close.
 */
export interface VisibilityFilterableItem {
  requiredScopes: string[]
  disclosureList?: string[] | null
}

/**
 * D5 and S8, spec-security.md: the ONE place context assembly asks "may this
 * turn see this row". Memory rows, knowledge documents and thread-search hits
 * injected into a later turn's prompt are filtered by that turn's CURRENT
 * effective scope, "identically to message visibility, because context assembly
 * runs the same predicate as the read path, not a separate one".
 *
 * That sentence is the whole design, so the body is a filter over
 * `isMessageVisible` and nothing else. No second predicate, no context-only
 * relaxation, no extra branch: a divergence between what a member reads in the
 * UI and what an agent's prompt is allowed to contain IS the vulnerability.
 * This also means the function inherits T10's fail-closed semantics for free.
 * An item whose `requiredScopes` is not a readable array never satisfies the
 * scope branch, so it is excluded rather than treated as the empty set: an
 * untagged row reads as "this row carries no scoped data" to every later
 * reader, which is exactly the claim that cannot be made about a row nobody
 * could parse. Losing a row from one prompt is recoverable; leaking one is not.
 *
 * Order and identity are preserved. The caller gets back the very objects it
 * passed in, in the order it passed them, because it has to read
 * `requiredScopes` off the kept rows immediately afterwards (see below).
 *
 * THE VIEWER IS THE ROOM'S FLOOR, NOT THE AGENT'S CEILING. Nothing here can
 * enforce that, since a viewer is just a userId and a grant list, but passing
 * the agent's own (typically wider) ceiling would reintroduce the Buzz failure
 * mode the threat table names: "agent-as-member reads full channel history". An
 * agent's own read of a channel's history for context is governed by the room's
 * floor at the time it reads, never a privileged blanket read. Callers build
 * the viewer's grants from the turn's effective scope, i.e. `resolveRoomFloor`
 * intersected with the agent's ceiling through `effectiveScopeChannel` /
 * `effectiveScopeDm` (`modules/agent/scopes/effective-scope.ts`), which is what
 * `computeEffectiveScopeForTurn` already returns.
 *
 * HOW SLICE 3 PLUGS THIS IN. `modules/agent/context/context.ts` is frozen for 2b and
 * belongs to slice 3, so this task lands the function only. At the memory
 * recall in `assembleContext` (the `agentMemory` read, currently selecting
 * `content` alone) slice 3:
 *
 *   1. adds `requiredScopes: agentMemory.requiredScopes` to that select, since
 *      the column is read by nothing today and the filter cannot run without it;
 *   2. passes the rows through `filterByVisibility(rows, viewer)` with the
 *      turn's effective scope as `viewer.grants`, not `actor`'s raw grants;
 *   3. calls `turnScopeAccumulator.recordInjected(row.requiredScopes)` for each
 *      KEPT row, and only the kept ones;
 *   4. repeats all three at the other injection sites as they land (knowledge
 *      documents, thread-search hits).
 *
 * `assembleContext` takes neither an accumulator nor an effective scope today,
 * so slice 3 threads both in; that plumbing is the whole of the remaining work.
 *
 * WHY STEP 3 IS NOT OPTIONAL: reading a scoped row into context TAINTS the
 * turn. The accumulated `requiredScopes` is what tags the reply message, what
 * gates each streamed chunk, and what `assertNoScopeTaintedWrite` consults
 * before letting the turn write anywhere. A turn that injects a finance-scoped
 * memory row into its prompt and then answers from it, while still reporting an
 * empty accumulated set, publishes an UNTAGGED reply derived from scoped data
 * to the whole room and may launder it into an untagged sink. That is precisely
 * the "memory side channel" row of the threat table, reopened one layer later.
 * Filtering the read without recording it merely moves the leak from the prompt
 * to the answer. Conversely a row this function DROPPED must never be recorded:
 * the turn never saw it, and taking its scopes would leak their names into the
 * reply's own tag.
 */
export function filterByVisibility<T extends VisibilityFilterableItem>(
  items: T[],
  viewer: VisibilityViewer,
): T[] {
  return items.filter((item) =>
    isMessageVisible(
      { requiredScopes: item.requiredScopes, disclosureList: item.disclosureList ?? null },
      viewer,
    ),
  )
}

/**
 * Would adding `candidateUserId` to `threadId` leave that person with hidden
 * history already in the room? This is the boolean the add-member warning is
 * conditioned on (spec-security.md, "Add-member warning"); the copy and the
 * rendering live elsewhere.
 *
 * Not pure, unlike countHiddenRuns: the candidate's grants and the room's
 * messages both live in the database, and the candidate is not the actor, so
 * nothing the caller already holds can answer it.
 *
 * Two clients, deliberately:
 *
 * - `db`, the CALLER's RLS client, authorises the question. The thread is read
 *   through it, so a caller who is not a participant reads no row (threads
 *   SELECT policy) and gets a flat false. The function never confirms that a
 *   thread exists, nor answers about a room the asker is not in.
 * - a privileged transaction does the counting. The candidate's grants come
 *   from `loadEffectivePermissions`, the production permissions read path,
 *   which takes a privileged client because a cross-user grant lookup is not
 *   the actor's own row. The message read is privileged for a sharper reason:
 *   RLS on kernel.messages hides rows from the ASKER, while the rows that
 *   matter here are the ones hidden from the CANDIDATE. Run as the candidate it
 *   would return exactly the rows that are not the answer; run as the asker, a
 *   message neither of them can see goes uncounted and the warning never fires.
 *   So the read is privileged and narrowed to the two visibility columns plus
 *   the id: content, author and timestamps are never loaded and so cannot leak
 *   into the result.
 *
 * Privacy (A14): the answer is a bare boolean. It says that history would be
 * hidden, never how much, under what scope, from whom or when. Where the task
 * text is silent, the least revealing option was taken:
 *
 * - a candidate who is ALREADY a participant returns false. Adding them reveals
 *   nothing new, and answering would turn the add dialog into a grant oracle on
 *   a colleague, the enumeration A14 closes everywhere else.
 * - an invisible or unknown thread returns false rather than throwing, so the
 *   function is not an existence oracle either.
 * - soft deleted messages are excluded, matching the thread read path: history
 *   nobody can read any more is not history the candidate would land on.
 */
export async function wouldRevealHiddenHistory(
  db: RlsClient,
  threadId: string,
  candidateUserId: string,
): Promise<boolean> {
  const [thread] = await db
    .select({ orgId: threads.orgId })
    .from(threads)
    .where(eq(threads.id, threadId))
    .limit(1)
  if (!thread) return false
  const orgId = thread.orgId

  const [alreadyIn] = await db
    .select({ userId: threadParticipants.userId })
    .from(threadParticipants)
    .where(
      and(
        eq(threadParticipants.threadId, threadId),
        eq(threadParticipants.userId, candidateUserId),
      ),
    )
    .limit(1)
  if (alreadyIn) return false

  return withPrivilegedDb(orgId, "security:add-member-visibility-warning", async (tx) => {
    const { scopes } = await loadEffectivePermissions(tx, candidateUserId, orgId)
    const history = await tx
      .select({
        id: messages.id,
        requiredScopes: messages.requiredScopes,
        disclosureList: messages.disclosureList,
      })
      .from(messages)
      // org_id is bound as well as the thread id. The thread row this orgId
      // came from was read through the CALLER's RLS client, so pinning it here
      // keeps the privileged read inside the tenant the caller was authorised
      // against instead of trusting the thread id alone.
      .where(
        and(
          eq(messages.threadId, threadId),
          eq(messages.orgId, orgId),
          isNull(messages.deletedAt),
          // A4: the CHANNEL's history, the view a new member lands on. A
          // reply the channel does not show is not part of it.
          drizzleSql`(${messages.replyRootId} IS NULL OR ${messages.alsoInChannel})`,
        ),
      )
      .orderBy(asc(messages.createdAt), asc(messages.id))
    return countHiddenRuns(history, { userId: candidateUserId, grants: scopes }).length > 0
  })
}

/** What one shown withheld-capability card records (spec-security.md A14). */
export interface WithheldCapabilityAuditParams {
  orgId: string
  /** The agent whose ceiling the room floored in the turn behind the card. */
  agentId: string
  /** The one person the card is private to, and the only person it was shown to. */
  requesterId: string
  /** The room the withheld turn ran in. */
  roomId: string
  /** The raw ceiling entries the room narrowed away, as scope strings. */
  withheldScopes: string[]
}

/**
 * Records that the requester was shown the private withheld-capability card,
 * so a later review can reconstruct exactly what was withheld and why
 * (spec-security.md, "Audit rows", closing paragraph).
 *
 * WHEN THIS IS CALLED: at the RENDER, not when the turn computes a non-empty
 * withheld set. The two are not the same event, and only the first is what A14
 * governs. A turn can withhold a capability with no human anywhere near it: a
 * routine tick (`routine-worker.ts`), a background re-invocation
 * (`reinvoke.ts`) and the Share anyway rerun itself all compute `withheld`, and
 * none of them shows anybody a card. Writing on computation would fill the log
 * with "a card was shown" rows for cards nobody saw, which is precisely the
 * conclusion a later review must not be able to draw. Writing on the render
 * makes each row mean what it says.
 *
 * WHERE 4b MUST CALL IT: no card exists yet, so nothing calls this in
 * production; the render is 4b's. The labels already travel to the requester
 * and stop there: `finalize` in `modules/agent/runtime/agent-service.ts` turns the run
 * frame's raw `withheld` into `describeWithheldCapabilities` labels and returns
 * them as `withheldCapabilities`, which `invokeAgentForThread` passes on to its
 * caller and which the agent chat route (`modules/agent/routes.ts`) currently
 * drops on the floor. 4b closes that last hop, and calls this function once at
 * the same point, on the requester's own RLS client.
 *
 * That call needs the RAW scope names, which the labels deliberately no longer
 * carry (Y2 keeps `withheld` on the run frame precisely so the names never
 * reach anything shared into the room). So 4b threads the raw set from the run
 * frame to its card-delivery point rather than re-deriving it from the labels,
 * which cannot be inverted. Calling this blind is safe: an empty withheld set
 * writes nothing, so the render point needs no condition of its own.
 *
 * PRIVACY (A14): this is an audit record, so unlike the card it MAY name the
 * scopes, but only where audit tooling reads. They go in `metadata`, an opaque
 * jsonb column, never in `effective_scope` (which would both mislabel them and
 * leave them in a column a reader scanning the log stumbles on). T03's
 * disclosure columns stay null: a private card discloses nothing to anybody, so
 * there is no effective scope, no member snapshot and no disclosure list.
 *
 * FAILURE: the row is REQUIRED, unlike the default best-effort audit write: a
 * card shown without its audit row is an unrecorded disclosure of what the
 * room withheld, so a failure propagates. It still goes through the central
 * `writeAuditLog` stamp, and the agent id is resolved against the org first
 * (`resolveAuditAgentId`): an agent deleted since the turn costs this row its
 * agent NAME, never the row, because the composite (agent_id, org_id) foreign
 * key would otherwise abort the caller's whole transaction.
 */
export async function recordWithheldCapabilityAudit(
  db: RlsClient,
  params: WithheldCapabilityAuditParams,
): Promise<void> {
  const { orgId, agentId, requesterId, roomId, withheldScopes } = params
  // Nothing was withheld, so no card was shown and there is nothing to record.
  if (withheldScopes.length === 0) return

  await writeAuditLog(
    db,
    {
      orgId,
      actorId: requesterId,
      actorType: "user",
      app: "kernel",
      entityType: "thread",
      entityId: roomId,
      action: "withheld_capability_shown",
      agentId: await resolveAuditAgentId(db, orgId, agentId),
      requesterUserId: requesterId,
      metadata: { withheldScopes },
    },
    { required: true },
  )
}

/**
 * A3, spec-security.md "Scope taint on writes": the WRITE-PATH guard.
 *
 * A turn whose accumulated `requiredScopes` is non-empty has read scoped data.
 * It may write only into a sink whose READS enforce `requiredScopes`, which is
 * the closed list `kernel.messages`, `kernel.agent_memory` and
 * `app_knowledge.documents`. A write anywhere else (projects, tickets,
 * contacts, files, mail, skills, routines) would launder that data past the
 * visibility gate this module implements, so it is refused, never silently
 * allowed. Extending the list is a spec change, not an implementation choice.
 *
 * THE LIST IS NOT REDEFINED HERE. The decision is `checkScopeTaint` and the
 * sinks are `TAINT_ENFORCING_SINKS`, both from `modules/agent/scopes/scope-taint.ts`,
 * so this guard can never drift from the tool bridge's check. In particular the
 * match stays exact and literal: `app_mail.messages` shares a base name with
 * the kernel table and is non-enforcing.
 *
 * FAIL CLOSED ON UNKNOWN TAINT. `turnRequiredScopes` is `null` when the caller
 * is inside a turn but cannot determine what that turn has accumulated. Unknown
 * taint is resolved to the WORST case, a tainted turn, rather than to the empty
 * set: an untagged row reads as "this turn touched no scoped data" to every
 * later reader, which is exactly the claim that cannot be made. A value that is
 * not a string array is treated the same way, so an unreadable input can never
 * buy itself a write. Note that the worst case still permits the three
 * enforcing sinks, because a tainted turn may write them: unknown taint blocks
 * laundering, it does not stop a turn answering.
 *
 * NO TURN AT ALL is the caller's `[]`, not `null`. A human request, a job or a
 * webhook has no accumulated scopes to launder, and the callers follow 2a's
 * convention (`capturedFrameWriteScopes` maps a null frame to `[]`).
 *
 * The refusal is 2a's `toScopeTaintBlockedError` shape carried on an Error, so
 * a boundary that reports by throwing refuses identically to the tool bridge,
 * which reports by returning, and the D2 withheld-capability mechanism can
 * present either one. This mirrors `readOnlyRunBlockedError` in
 * `modules/agent/runtime/read-only-run.ts`, which pairs with the same bridge check.
 */
export const SCOPE_TAINT_BLOCKED_CODE = "E_SCOPE_TAINT_BLOCKED"

export type ScopeTaintBlockedWriteError = Error & ScopeTaintBlockedError & { retryable: false }

export function isScopeTaintBlockedWriteError(err: unknown): err is ScopeTaintBlockedWriteError {
  return err instanceof Error && (err as { code?: unknown }).code === SCOPE_TAINT_BLOCKED_CODE
}

export function scopeTaintBlockedWriteError(
  sinkTable: string,
  taintScopes: readonly string[] = UNKNOWN_TURN_TAINT,
): ScopeTaintBlockedWriteError {
  const err = new Error(
    `${SCOPE_TAINT_BLOCKED_CODE}: this turn has read scoped data and may not write to ${sinkTable}`,
  ) as ScopeTaintBlockedWriteError
  // The result shape's `message` is guidance for the model reading a tool
  // RESULT; this thrown variant keeps its own pinned message.
  const { message: _guidance, ...fields } = toScopeTaintBlockedError(sinkTable, taintScopes)
  Object.assign(err, fields, { retryable: false })
  return err
}

/**
 * Throws when `sinkTable` is outside the enforcing sinks and the turn is (or
 * may be) tainted. Returns silently otherwise.
 */
export function assertNoScopeTaintedWrite(
  sinkTable: string,
  turnRequiredScopes: string[] | null,
  /** The rows this write targets and the rows the turn's reads came from, for the
   *  same-resource allowance (A46). Absent on a caller that knows neither, which
   *  leaves the decision exactly as it was. */
  sameResource?: { rowIds?: readonly string[]; originRows?: TaintOriginRows },
): void {
  const known =
    Array.isArray(turnRequiredScopes) && turnRequiredScopes.every((s) => typeof s === "string")
  const accumulated = known ? (turnRequiredScopes as string[]) : [...UNKNOWN_TURN_TAINT]
  if (checkScopeTaint(accumulated, sinkTable, sameResource).allowed) return
  throw scopeTaintBlockedWriteError(sinkTable, accumulated)
}
