// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A SECURE CARD IN AN ORG WITH MEMBERS (walk 2026-10-27, N40/N41/N45).
//
// Live, in an org with members, every `request_secret` (the Google client
// card, the Connect card) parked for approval, and approving it filed the
// request but no card ever appeared: the web draws the card under the tool
// call's own result, and a parked call has none. The agent then said the mail
// was "fully configured and connected".
//
//   1. A turn that read scoped data is judged by the card's real readers (the
//      requester and the conversation's participants, rule 6e), not by every
//      member who reads threads: the card is posted in the turn.
//   2. The same card asked twice is posted once: the second call says so.
//   3. A call that still parks (outside text in a hardened workspace, A7) is
//      approved, and the approval's result line carries the card's id (drawn
//      under it by the web) and a platform line saying nothing is connected.
//
// Driven through the real chat seam (buildToolSet, executeToolCore) and the
// real decision path (decideApproval).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import type { ActorContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { systemEventLine } from "~/modules/agent/context/system-event-replay"
import { connectionClaimVerdict } from "~/modules/agent/runtime/open-cards"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { decideApproval } from "~/modules/approvals/decide"
import { approvalPayloadHash } from "~/modules/approvals/payload-hash"
import { initializedOrgRuntimes, toolRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { getSecretRequest } from "~/modules/secret-requests/service"
import { requestSecretParams } from "~/modules/secret-requests/targets"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// Fresh ids per run: the run's rows stay in the namespace database, dropped with it.
const ORG = crypto.randomUUID()
const OWNER = crypto.randomUUID()
const MEMBER = crypto.randomUUID()
const DM = crypto.randomUUID()
const DM_OUTSIDE = crypto.randomUUID()
const DM_CLAIM = crypto.randomUUID()
const TAG = ORG.slice(0, 8)
const MAIL_READ = "mail:conversations:read"
const BYOK = { kind: "byok", target: { provider: "openrouter" } }
const BYOK_2 = { kind: "byok", target: { provider: "openai" } }

function turnFrame(injected: string[]): RunContext {
  const runId = crypto.randomUUID()
  const turnScopeAccumulator = createTurnScopeAccumulator()
  turnScopeAccumulator.recordInjected(injected)
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    effectiveScope: ["*"],
    turnScopeAccumulator,
  }
}

const owner: ActorContext = {
  actorType: "user",
  userId: OWNER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

async function requestSecret(
  threadId: string,
  frame: RunContext,
  params: unknown,
): Promise<Record<string, unknown>> {
  const tools = buildToolSet(ORG, owner, threadId, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)
  const t = tools.kernel__request_secret
  if (!t?.execute) throw new Error("kernel__request_secret is not in the turn tool set")
  const execute = t.execute
  return (await runContextStore.run(frame, () =>
    execute(params, { toolCallId: `call-${crypto.randomUUID()}`, messages: [] }),
  )) as Record<string, unknown>
}

async function approvalsIn(threadId: string): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM kernel.approval_requests
     WHERE org_id = ${ORG} AND originating_thread_id = ${threadId}`
  return n
}

describe("request_secret in an org with members", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug, settings)
      VALUES (${ORG}, 'Card Render Org', ${`card-render-${TAG}`}, '{"webContentProtection":"hardened"}')
      ON CONFLICT DO NOTHING`
    for (const [id, email] of [
      [OWNER, `card-render-owner-${TAG}@test.com`],
      [MEMBER, `card-render-member-${TAG}@test.com`],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
        VALUES (${id}, ${ORG}, ${email}, ${email}, 'active', 'x') ON CONFLICT DO NOTHING`
    }
    // The owner holds everything; the member reads threads but not mail.
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${OWNER}, ${ORG}, '*'), (${MEMBER}, ${ORG}, 'kernel:threads:read')
      ON CONFLICT DO NOTHING`
    for (const [id, handle] of [
      [DM, `card-render-dm-${TAG}`],
      [DM_OUTSIDE, `card-render-outside-${TAG}`],
      [DM_CLAIM, `card-render-claim-${TAG}`],
    ] as const) {
      await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, tainted)
        VALUES (${id}, ${ORG}, ${handle}, 'agent_chat', ${OWNER}, false) ON CONFLICT DO NOTHING`
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${id}, ${OWNER}, ${ORG}) ON CONFLICT DO NOTHING`
    }
    await ensureAppsForOrg(ORG)
    await registerKernelAgentTools(ORG)
  }, 120_000)

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    initializedOrgRuntimes.delete(ORG)
    await releaseTestLock()
  })

  it("rule 6e: a turn that read mail posts its card when the conversation's people hold mail", async () => {
    const r = await requestSecret(DM, turnFrame([MAIL_READ]), BYOK)
    expect(JSON.stringify(r)).not.toContain("E_SCOPE_TAINT_BLOCKED")
    expect(r.blocked).toBeUndefined()
    expect(r.requestId).toBeString()
    expect(r.card).toBe("posted")
    expect(String(r.note)).toContain("Nothing is saved or configured until the person completes it")
    expect(await approvalsIn(DM)).toBe(0)
  })

  it("rule 6e: a participant lacking what the turn read still keeps the card from being posted inline", async () => {
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${DM}, ${MEMBER}, ${ORG}) ON CONFLICT DO NOTHING`
    try {
      const r = await requestSecret(DM, turnFrame([MAIL_READ]), BYOK_2)
      // Not posted: it parks for a person holding the taint to decide (rule 8b).
      expect(r.requestId).toBeUndefined()
      expect(r.blocked).toBe(true)
    } finally {
      await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${DM} AND user_id = ${MEMBER}`
    }
  })

  it("N45: the same card asked twice is posted once, and the second call says it is already there", async () => {
    const first = await requestSecret(DM, turnFrame([]), BYOK)
    const second = await requestSecret(DM, turnFrame([]), BYOK)
    expect(second.requestId).toBe(first.requestId)
    expect(second.card).toBe("already_posted")
    expect(String(second.note)).toContain("already posted")
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.secret_requests
       WHERE org_id = ${ORG} AND thread_id = ${DM} AND kind = 'byok' AND status = 'pending'
         AND target->>'provider' = 'openrouter'`
    expect(n).toBe(1)
  })

  it("N40/N41: an approved parked card is drawn under its result line, which says nothing is connected", async () => {
    await sql`UPDATE kernel.threads SET tainted = true WHERE id = ${DM_OUTSIDE}`
    const parked = await requestSecret(DM_OUTSIDE, turnFrame([]), BYOK)
    expect(parked.blocked).toBe(true)
    expect(parked.reason).toBe("taint_escalation")
    const approvalId = parked.approvalRequestId as string
    expect(approvalId).toBeString()
    // Parked: no card filed yet.
    const [{ before }] = await sql<{ before: number }[]>`
      SELECT count(*)::int AS before FROM kernel.secret_requests WHERE thread_id = ${DM_OUTSIDE}`
    expect(before).toBe(0)

    const [row] =
      await sql`SELECT tool_name, current_payload FROM kernel.approval_requests WHERE id = ${approvalId}`
    const decided = await decideApproval({
      orgId: ORG,
      requestId: approvalId,
      actor: owner,
      decision: "approve",
      payloadHash: approvalPayloadHash(row.tool_name as string, row.current_payload),
    })
    expect((decided as { status?: string }).status).toBe("approved")

    const [secret] = await sql<{ id: string; status: string }[]>`
      SELECT id, status FROM kernel.secret_requests WHERE thread_id = ${DM_OUTSIDE}`
    expect(secret?.status).toBe("pending")

    const notices = await sql<{ content: string; metadata: Record<string, unknown> }[]>`
      SELECT content, metadata FROM kernel.messages
       WHERE thread_id = ${DM_OUTSIDE} AND metadata->>'type' = 'approval-result'`
    expect(notices.length).toBe(1)
    const notice = notices[0]!
    // The web draws the card from this field (MessageRow, approvedSecretCardId).
    expect(notice.metadata.secretRequestId).toBe(secret!.id)
    expect(notice.metadata.secretCard).toBe("posted")
    // The agent reads, outside the fence, that nothing is connected yet.
    const line = systemEventLine(notice) ?? ""
    expect(line).toContain("<platform-step>")
    expect(line).toContain("Nothing is saved or connected until the person completes that card")
  })

  it("review: the row carries the filing turn's scopes, and a participant added later without them cannot read it", async () => {
    const BYOK_3 = { kind: "byok", target: { provider: "anthropic" } }
    const r = await requestSecret(DM, turnFrame([MAIL_READ]), BYOK_3)
    const id = r.requestId as string
    expect(id).toBeString()
    const [stamped] = await sql<{ required_scopes: string[] }[]>`
      SELECT required_scopes FROM kernel.secret_requests WHERE id = ${id}`
    expect(stamped?.required_scopes).toEqual([MAIL_READ])

    // A member who reads threads but not mail is seated in the conversation afterwards.
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${DM}, ${MEMBER}, ${ORG}) ON CONFLICT DO NOTHING`
    try {
      const asMember = (scopes: string[]) =>
        withRlsContext(
          { actorType: "user", userId: MEMBER, orgId: ORG, scopes, dimensionGrants: {} },
          (tx) => getSecretRequest(tx, id),
        )
      // The read GET /secret-requests/:id makes (routes.ts), under the member's RLS.
      expect(await asMember(["kernel:threads:read"])).toBeNull()
      // The same member holding mail reads it.
      expect((await asMember(["kernel:threads:read", MAIL_READ]))?.id).toBe(id)
      // The owner, who filed it, reads it.
      const own = await withRlsContext(owner, (tx) => getSecretRequest(tx, id))
      expect(own?.id).toBe(id)
    } finally {
      await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${DM} AND user_id = ${MEMBER}`
    }
  })

  it("review: allowed origins must be real origins, and identifiers are not free text", () => {
    const apiKey = (allowedOrigins: string[]) =>
      requestSecretParams.safeParse({ kind: "api_key", target: { label: "Site", allowedOrigins } })
        .success
    expect(apiKey(["https://shop.example.com", "http://localhost:5173"])).toBe(true)
    expect(apiKey(["https://shop.example.com/path"])).toBe(false)
    expect(apiKey(["Customer list: Jane Doe, jane@example.com"])).toBe(false)
    expect(apiKey(["javascript:alert(1)"])).toBe(false)
    expect(apiKey(["https://user:pw@shop.example.com"])).toBe(false)
    expect(apiKey(["HTTPS://Shop.Example.com"])).toBe(false)
    const ident = (identifier: string) =>
      requestSecretParams.safeParse({
        kind: "connection_credentials",
        target: { app: "mail", connection: "imap", identifier },
      }).success
    expect(ident("ops@example.com")).toBe(true)
    expect(ident("Q3<b>revenue</b>")).toBe(false)
  })

  it("review N41: a connected claim is judged only where a card is, and a waiting card makes it false", async () => {
    const verdict = (namedApps: string[], turnFiledCard = false) =>
      connectionClaimVerdict({
        orgId: ORG,
        threadId: DM_CLAIM,
        userId: OWNER,
        namedApps: new Set(namedApps),
        turnFiledCard,
      })
    // No card in this conversation, none filed this turn: not this guard's business.
    expect(await verdict(["mail"])).toBe("not_judged")
    // The organization holds an active account elsewhere (an established org)...
    await sql`INSERT INTO kernel.connected_accounts
      (org_id, app_name, connection_name, owner_type, provider_type, identifier, status, created_by)
      VALUES (${ORG}, 'shopify', 'shop', 'org', 'oauth2', ${`shop-${TAG}.myshopify.com`}, 'active', ${OWNER})`
    // ...and a Gmail Connect card waits in this conversation: the claim is still false.
    const [card] = await sql<{ id: string }[]>`
      INSERT INTO kernel.secret_requests (org_id, thread_id, requested_by, kind, target, target_key, status)
      VALUES (${ORG}, ${DM_CLAIM}, ${OWNER}, 'oauth_connect',
              '{"app":"mail","connection":"gmail","mode":"org"}'::jsonb, ${`claim-${TAG}`}, 'pending')
      RETURNING id`
    expect(await verdict(["mail", "google"])).toBe("false")
    expect(await verdict([])).toBe("false")
    // A claim about another app stands on the account the org holds.
    expect(await verdict(["shopify"])).toBe("backed")
    // Once the card is completed, the Gmail claim stands.
    await sql`UPDATE kernel.secret_requests SET status = 'saved', completed_at = now() WHERE id = ${card!.id}`
    expect(await verdict(["mail"])).toBe("backed")
  })
})
