// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { computeApprovalAttentionItems } from "~/modules/approvals/attention"
import { toolRegistry } from "~/modules/apps/app-registries"

const ORG = "00000000-0000-4000-8000-000000091001"
const USER_A = "00000000-0000-4000-8000-000000091002"
const USER_B = "00000000-0000-4000-8000-000000091003"
const THREAD = "00000000-0000-4000-8000-000000091004"
const APPROVAL_THREAD = "00000000-0000-4000-8000-000000091005"

const A1 = "00000000-0000-4000-8000-0000000910a1"
const A2 = "00000000-0000-4000-8000-0000000910a2"
const A3 = "00000000-0000-4000-8000-0000000910a3"
const A_SOON = "00000000-0000-4000-8000-0000000910a4"
const A_NOSUM = "00000000-0000-4000-8000-0000000910a5"
const A_RAWTITLE = "00000000-0000-4000-8000-0000000910a6"
const A_SUMIMPACT = "00000000-0000-4000-8000-0000000910a7"
// Wedged executions: approved, claim committed, handler never finished.
const A_WEDGED = "00000000-0000-4000-8000-0000000910a8"
const A_APPROVING_FRESH = "00000000-0000-4000-8000-0000000910a9"
// Failed seconds ago: known-dead, must NOT wait out the grace window.
const A_AMBIGUOUS_FRESH = "00000000-0000-4000-8000-0000000910aa"
// Approved, the handler failed with no effect, reverted to pending.
const A_FAILED_NO_EFFECT = "00000000-0000-4000-8000-0000000910ab"
// A summary that names its record: the Home row offers "Open".
const A_LINKED = "00000000-0000-4000-8000-0000000910ac"

async function insertApproval(opts: {
  id: string
  toolName: string
  notifyUserIds: string[]
  expiresAt: Date
  status?: string
  /** When set, stamps `approving_started_at` so a `status:'approving'` row can
   *  be aged past the wedge grace window. */
  approvingStartedAt?: Date
  /** Row metadata — `ambiguousAt` marks a handler that already came back dead. */
  metadata?: Record<string, unknown>
  /** Override the stored summary. `null` inserts a null summary (no title);
   *  a `{ title }` object stores that title verbatim. Defaults to a synthesised
   *  title so existing tests keep their behavior. */
  summaryOverride?: {
    title?: string
    subtitle?: string
    lines?: unknown[]
    impact?: "external" | "internal"
    ref?: string
    links?: unknown[]
  } | null
  /** The row's live payload, which is what names a row nobody summarized. */
  payload?: Record<string, unknown>
  /** Who raised it. Defaults to USER_A, as every pre-existing case assumes. */
  requestedBy?: string
}) {
  const handle = `app-${opts.id.slice(-4)}`
  const summary =
    opts.summaryOverride === undefined
      ? JSON.stringify({ title: `Title for ${opts.toolName}` })
      : opts.summaryOverride === null
        ? null
        : JSON.stringify(opts.summaryOverride)
  const expiresIso = opts.expiresAt.toISOString()
  await sql`
    INSERT INTO kernel.approval_requests (
      id, org_id, handle, status, tool_name, tool_params, summary, current_payload,
      thread_id, originating_thread_id, requested_by, notify_user_ids,
      expires_at, approving_started_at, metadata
    ) VALUES (
      ${opts.id}, ${ORG}, ${handle}, ${opts.status ?? "pending"},
      ${opts.toolName}, '{}'::jsonb, ${summary}::jsonb,
      ${JSON.stringify(opts.payload ?? {})}::jsonb,
      ${APPROVAL_THREAD}, ${THREAD}, ${opts.requestedBy ?? USER_A},
      ${sql.array(opts.notifyUserIds, 2950)}, ${expiresIso}::timestamptz,
      ${opts.approvingStartedAt ? opts.approvingStartedAt.toISOString() : null}::timestamptz,
      ${opts.metadata ? JSON.stringify(opts.metadata) : "{}"}::jsonb
    )
    ON CONFLICT (id) DO NOTHING
  `
}

describe("approvals.attention", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Approval Attn Org', 'approval-attn-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER_A}, ${ORG}, 'a@attn.test', 'A', 'active', 'hash') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER_B}, ${ORG}, 'b@attn.test', 'B', 'active', 'hash') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'attn-thread', 'agent_chat', ${USER_A}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${APPROVAL_THREAD}, ${ORG}, 'attn-approval', 'approval', ${USER_A}) ON CONFLICT DO NOTHING`

    const tPlus2h = new Date(Date.now() + 2 * 60 * 60 * 1000)
    const tPlus30m = new Date(Date.now() + 30 * 60 * 1000)
    await insertApproval({
      id: A1,
      toolName: "tickets:reply",
      notifyUserIds: [USER_A],
      expiresAt: tPlus2h,
    })
    await insertApproval({
      id: A2,
      toolName: "tickets:reply",
      notifyUserIds: [USER_B], // not me
      expiresAt: tPlus2h,
    })
    await insertApproval({
      id: A3,
      toolName: "mail:send",
      notifyUserIds: [USER_A], // me, but no scope for mail:approve
      expiresAt: tPlus2h,
    })
    await insertApproval({
      id: A_SOON,
      toolName: "tickets:reply",
      notifyUserIds: [USER_A],
      expiresAt: tPlus30m,
    })
    // B3 regression: an approval with no author summary must NOT title itself
    // with the raw tool id — it falls back to the humanized action label.
    await insertApproval({
      id: A_NOSUM,
      toolName: "tickets:close",
      notifyUserIds: [USER_A],
      expiresAt: tPlus2h,
      summaryOverride: null,
    })
    // B3 regression: some gated tools store the raw tool id AS the title; that
    // verbatim id must still be humanized rather than surfaced as-is.
    await insertApproval({
      id: A_RAWTITLE,
      toolName: "tickets:nudge",
      notifyUserIds: [USER_A],
      expiresAt: tPlus2h,
      summaryOverride: { title: "tickets:nudge" },
    })
    // Per-call impact override frozen on the row by the summarizer at gate
    // time (e.g. a tickets close WITH a body emails the customer): it must
    // beat the manifest's static classification.
    await insertApproval({
      id: A_SUMIMPACT,
      toolName: "tickets:close",
      notifyUserIds: [USER_A],
      expiresAt: tPlus2h,
      summaryOverride: { title: "Close with goodbye email", impact: "external" },
    })
    // FIELD REGRESSION (prod, found 2026-08-04). A row stuck in `approving`
    // past the grace window is a DEAD execution: the human approved it, the
    // claim committed, then a container recreate mid-deploy killed the handler.
    // Eight of these sat on prod for 12-19 days -- a role grant that never
    // applied, a shipping label never bought, five HS codes never written --
    // because this feed queried `status = 'pending'` only and never showed them.
    await insertApproval({
      id: A_WEDGED,
      toolName: "tickets:reply",
      notifyUserIds: [USER_A],
      expiresAt: tPlus2h,
      status: "approving",
      approvingStartedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      summaryOverride: { title: "Reply that never sent" },
    })
    // ...but an execution still INSIDE the grace window is genuinely in flight
    // and must NOT be surfaced as needing attention.
    await insertApproval({
      id: A_APPROVING_FRESH,
      toolName: "tickets:reply",
      notifyUserIds: [USER_A],
      expiresAt: tPlus2h,
      status: "approving",
      approvingStartedAt: new Date(Date.now() - 60 * 1000),
      summaryOverride: { title: "Reply executing right now" },
    })
    // ...and one that ALREADY FAILED seconds ago. Before the ambiguousAt stamp
    // this was indistinguishable from the in-flight row above, so the feed had
    // to wait out the full 10-minute grace -- a window in which a FAILED
    // approval looks exactly like a successful one to the operator who just
    // clicked Approve (they watch the card vanish and assume it worked).
    await insertApproval({
      id: A_AMBIGUOUS_FRESH,
      toolName: "tickets:reply",
      notifyUserIds: [USER_A],
      expiresAt: tPlus2h,
      status: "approving",
      approvingStartedAt: new Date(Date.now() - 30 * 1000),
      metadata: {
        ambiguousAt: new Date().toISOString(),
        ambiguousError: "Shopify GraphQL: Field is not defined on ProductVariantsBulkInput",
      },
      summaryOverride: { title: "Reply whose handler already failed" },
    })
    await insertApproval({
      id: A_LINKED,
      toolName: "invoicing:invoice_issue",
      notifyUserIds: [USER_A],
      expiresAt: tPlus2h,
      summaryOverride: {
        title: "Issue invoice",
        links: [
          { label: "In the shop admin", url: "https://shop.example/admin/orders/1" },
          {
            label: "Open the draft invoice",
            app: "invoicing",
            entityType: "detail",
            entityId: "doc-1",
          },
        ],
      },
    })
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id IN (${THREAD}, ${APPROVAL_THREAD})`
    await sql`DELETE FROM kernel.threads WHERE id IN (${THREAD}, ${APPROVAL_THREAD})`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("carries the summary's first in-app link as the row's open link", async () => {
    const items = await withRlsContext(
      {
        actorType: "user",
        userId: USER_A,
        orgId: ORG,
        scopes: ["invoicing:approve", "tickets:approve"],
        dimensionGrants: {},
      },
      (tx) => computeApprovalAttentionItems(tx, ORG, USER_A),
    )
    const row = items.find((i) => i.entityId === A_LINKED)
    expect(row?.metadata?.openLink).toEqual({
      label: "Open the draft invoice",
      app: "invoicing",
      entity: "detail",
      entityId: "doc-1",
    })
    const plain = items.find((i) => i.entityId === A_SOON)
    expect(plain).toBeDefined()
    expect(plain?.metadata?.openLink).toBeUndefined()
  })

  it("approvals.attention.decidable-by-me", async () => {
    const items = await withRlsContext(
      {
        actorType: "user",
        userId: USER_A,
        orgId: ORG,
        scopes: ["tickets:approve"],
        dimensionGrants: {},
      },
      (tx) => computeApprovalAttentionItems(tx, ORG, USER_A),
    )
    const ids = items.map((i) => i.entityId).sort()
    expect(ids).toContain(A1)
    expect(ids).toContain(A_SOON)
    expect(ids).not.toContain(A2)
    expect(ids).not.toContain(A3)
    const a1 = items.find((i) => i.entityId === A1)!
    expect(a1.kind).toBe("approval_pending")
    // The action carries the fingerprint of the payload the row described: the approve is bound to it.
    expect(a1.action).toEqual({
      type: "decide_approval",
      approvalId: A1,
      payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(a1.urgency).toBe(60)
  })

  it("approvals.attention.humanizes-missing-or-raw-title", async () => {
    const items = await withRlsContext(
      {
        actorType: "user",
        userId: USER_A,
        orgId: ORG,
        scopes: ["tickets:approve"],
        dimensionGrants: {},
      },
      (tx) => computeApprovalAttentionItems(tx, ORG, USER_A),
    )
    const noSum = items.find((i) => i.entityId === A_NOSUM)!
    expect(noSum.summary).toBe("Tickets: close")
    expect(noSum.summary).not.toContain(":close")
    const rawTitle = items.find((i) => i.entityId === A_RAWTITLE)!
    expect(rawTitle.summary).toBe("Tickets: nudge")
    expect(rawTitle.summary).not.toBe("tickets:nudge")
  })

  // On the demo box these four rows carried a badge, a handle and NO TITLE at
  // all: no author summary, so the feed fell back to the humanized tool name,
  // which is byte-identical to the action badge beside it, so the row folded
  // the duplicate away and rendered nothing. The payload names the thing.
  it("approvals.attention.titles-an-unsummarized-row-from-its-payload", async () => {
    const SKILL_ID = "00000000-0000-4000-8000-0000000915c1"
    const A_SKILL = "00000000-0000-4000-8000-0000000915a1"
    const A_MERGE = "00000000-0000-4000-8000-0000000915a2"
    const A_REFUND = "00000000-0000-4000-8000-0000000915a3"
    const A_DISCOUNT = "00000000-0000-4000-8000-0000000915a4"
    const A_BARE = "00000000-0000-4000-8000-0000000915a5"
    const later = new Date(Date.now() + 24 * 3600 * 1000)
    // kernel.skills RLS requires the skill to hang off a visible agent, so the
    // row needs a role agent to own it.
    const AGENT = "00000000-0000-4000-8000-0000000915c0"
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
      VALUES (${AGENT}, ${ORG}, 'role', 'attn-role', 'Attn Role') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.skills
        (id, org_id, name, description, body, owner_agent_id,
         created_by_user_id, created_by_actor_type)
      VALUES (${SKILL_ID}, ${ORG}, 'shipment-exception', 'd', 'b', ${AGENT}, ${USER_A}, 'user')
      ON CONFLICT DO NOTHING`
    await insertApproval({
      id: A_SKILL,
      toolName: "kernel:update_skill",
      notifyUserIds: [USER_A],
      expiresAt: later,
      summaryOverride: null,
      payload: { id: SKILL_ID, body: "# A shipment that is not moving" },
    })
    await insertApproval({
      id: A_MERGE,
      toolName: "kernel:contacts_merge",
      notifyUserIds: [USER_A],
      expiresAt: later,
      summaryOverride: null,
      payload: { primaryContact: "Lena Vos", duplicateContact: "L. Vos" },
    })
    await insertApproval({
      id: A_REFUND,
      toolName: "invoicing:documents_record_refund",
      notifyUserIds: [USER_A],
      expiresAt: later,
      summaryOverride: null,
      payload: { documentNumber: "INV-2026-0418", amountMinor: 134900 },
    })
    await insertApproval({
      id: A_DISCOUNT,
      toolName: "shopify:discounts_create",
      notifyUserIds: [USER_A],
      expiresAt: later,
      summaryOverride: null,
      payload: { title: "Autumn teaching rooms", code: "TEACHING26" },
    })
    // Nothing nameable: the humanized action label is still the answer, and it
    // is still not blank.
    await insertApproval({
      id: A_BARE,
      toolName: "kernel:contacts_merge",
      notifyUserIds: [USER_A],
      expiresAt: later,
      summaryOverride: null,
      payload: { mergedFields: ["orders"] },
    })

    // `actorType: "user"` is load bearing: without it `resolveUserId` answers
    // null, RLS runs as the nil uuid and only the tickets:/mail: widening
    // clauses let a row through -- which is why every other case in this file
    // happens to use a tickets or mail tool.
    const items = await withRlsContext(
      { actorType: "user", userId: USER_A, orgId: ORG, scopes: ["*"], dimensionGrants: {} },
      (tx) => computeApprovalAttentionItems(tx, ORG, USER_A),
    )
    const titleOf = (id: string) => items.find((i) => i.entityId === id)?.summary
    expect(titleOf(A_SKILL)).toBe("Update skill: shipment-exception")
    expect(titleOf(A_MERGE)).toBe("Contacts merge: Lena Vos and L. Vos")
    expect(titleOf(A_REFUND)).toBe("Record document refund: INV-2026-0418")
    expect(titleOf(A_DISCOUNT)).toBe("Create discount: TEACHING26")
    expect(titleOf(A_BARE)).toBe("Workspace: contacts merge")
    // HOW each title was made rides along, so a French client can put its own
    // words for the action in front of the payload detail (second French walk,
    // 2026-09-23: "Kpi: kpi propose edit" and "Stalled: ..." read in English).
    const meta = (id: string) => items.find((i) => i.entityId === id)?.metadata
    expect(meta(A_REFUND)?.titleKind).toBe("derived")
    expect(meta(A_REFUND)?.titleDetail).toBe("INV-2026-0418")
    expect(meta(A_REFUND)?.baseTitle).toBe("Record document refund: INV-2026-0418")
    expect(meta(A_BARE)?.titleKind).toBe("action")
    expect(meta(A_BARE)?.titleDetail).toBeUndefined()
    // No row may title itself with the action badge's own words, which is what
    // made the title line render empty.
    for (const id of [A_SKILL, A_MERGE, A_REFUND, A_DISCOUNT]) {
      const item = items.find((i) => i.entityId === id)!
      expect(item.summary).not.toBe(item.metadata?.actionLabel)
      expect((item.summary ?? "").length).toBeGreaterThan(0)
    }
  })

  it("approvals.attention.carries-what-changes-and-who-asked", async () => {
    // The feed row showed "Update status column: backlog" and the project
    // name; the summarizer's "Label -> Idea" line and the requester never
    // reached it, so every row had to be expanded to be judged.
    const A_LINES = "00000000-0000-4000-8000-00000000a11e"
    await insertApproval({
      id: A_LINES,
      toolName: "projects:status_update",
      notifyUserIds: [USER_A],
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      summaryOverride: {
        title: "Update status column: backlog",
        subtitle: "In Roadmap Produit 2026",
        lines: ["Label -> Idea", 42, "", "Color -> #fff"],
      },
    })
    const items = await withRlsContext(
      {
        actorType: "user",
        userId: USER_A,
        orgId: ORG,
        scopes: ["projects:approve", "tickets:approve"],
        dimensionGrants: {},
      },
      (tx) => computeApprovalAttentionItems(tx, ORG, USER_A),
    )
    const row = items.find((i) => i.entityId === A_LINES)!
    expect(row.metadata?.summaryLines).toEqual(["Label -> Idea", "Color -> #fff"])
    expect(row.metadata?.requesterName).toBe("A")
    expect(row.metadata?.actionLabel).toBe("Projects: update status")
    const plain = items.find((i) => i.entityId === A1)!
    expect(plain.metadata?.summaryLines).toBeUndefined()
  })

  it("approvals.attention.carries-the-record-ref", async () => {
    // S23/A10: a ticket card leads with its id (`ticket-B2B-123`); the Home
    // row must carry it too, or the reviewer expands every row to learn it.
    const A_REF = "00000000-0000-4000-8000-00000000a12f"
    await insertApproval({
      id: A_REF,
      toolName: "tickets:reply",
      notifyUserIds: [USER_A],
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      summaryOverride: {
        title: "Where is my order",
        subtitle: "Reply to Jean Dupont",
        ref: "ticket-B2B-123",
        lines: [],
      },
    })
    const items = await withRlsContext(
      {
        actorType: "user",
        userId: USER_A,
        orgId: ORG,
        scopes: ["projects:approve", "tickets:approve"],
        dimensionGrants: {},
      },
      (tx) => computeApprovalAttentionItems(tx, ORG, USER_A),
    )
    const row = items.find((i) => i.entityId === A_REF)!
    expect(row.metadata?.ref).toBe("ticket-B2B-123")
    expect(items.find((i) => i.entityId === A1)!.metadata?.ref).toBeUndefined()
  })

  it("approvals.attention.action-label-and-impact", async () => {
    // `tickets:close` is registered with approvalImpact "internal"; the other
    // pending tools are NOT registered for this org, so they must fall back to
    // "external" (fail-safe default for an unresolvable or undeclared tool).
    toolRegistry.set([ORG, "tickets", "close"], {
      appName: "tickets",
      name: "close",
      description: "Close a ticket",
      requiredScopes: ["tickets:tickets:write"],
      handler: async () => ({}),
      gated: true,
      approvalImpact: "internal",
    })
    try {
      const items = await withRlsContext(
        {
          actorType: "user",
          userId: USER_A,
          orgId: ORG,
          scopes: ["tickets:approve"],
          dimensionGrants: {},
        },
        (tx) => computeApprovalAttentionItems(tx, ORG, USER_A),
      )
      const reply = items.find((i) => i.entityId === A1)!
      expect(reply.metadata?.actionLabel).toBe("Tickets: reply")
      expect(reply.metadata?.approvalImpact).toBe("external")
      const close = items.find((i) => i.entityId === A_NOSUM)!
      expect(close.metadata?.actionLabel).toBe("Tickets: close")
      expect(close.metadata?.approvalImpact).toBe("internal")
      // Precedence: the row's frozen summary.impact ("external", body close)
      // beats the registered manifest classification ("internal").
      const bodyClose = items.find((i) => i.entityId === A_SUMIMPACT)!
      expect(bodyClose.metadata?.approvalImpact).toBe("external")
    } finally {
      toolRegistry.delete([ORG, "tickets", "close"])
    }
  })

  // settings.tickets.approveRepliesFromHome (default off): off, a ticket reply
  // (decideInContext) only opens the ticket from Home; on, the row is
  // decidable like any other approval (no decideInContext, no openTarget).
  it("approvals.attention.decide-in-context-follows-approve-from-home-setting", async () => {
    await sql`UPDATE kernel.approval_requests
      SET current_payload = '{"ticketId":"00000000-0000-4000-8000-0000000910f1"}'::jsonb
      WHERE id = ${A1}`
    toolRegistry.set([ORG, "tickets", "reply"], {
      appName: "tickets",
      name: "reply",
      description: "Reply to a customer",
      requiredScopes: ["tickets:tickets:reply"],
      handler: async () => ({}),
      gated: true,
      decideInContext: true,
    })
    const feed = () =>
      withRlsContext(
        {
          actorType: "user",
          userId: USER_A,
          orgId: ORG,
          scopes: ["tickets:approve"],
          dimensionGrants: {},
        },
        (tx) => computeApprovalAttentionItems(tx, ORG, USER_A),
      )
    const setFlag = (value: boolean | null) =>
      value === null
        ? sql`UPDATE kernel.organizations SET settings = settings #- '{tickets,approveRepliesFromHome}' WHERE id = ${ORG}`
        : sql`UPDATE kernel.organizations
            SET settings = jsonb_set(settings, '{tickets}',
              COALESCE(settings->'tickets', '{}'::jsonb) || jsonb_build_object('approveRepliesFromHome', ${value}::boolean))
            WHERE id = ${ORG}`
    try {
      // Unset: today's default.
      await setFlag(null)
      let reply = (await feed()).find((i) => i.entityId === A1)!
      expect(reply.metadata?.decideInContext).toBe(true)
      expect(reply.metadata?.openTarget).toEqual({
        app: "tickets",
        entity: "ticket",
        entityId: "00000000-0000-4000-8000-0000000910f1",
      })
      // Explicitly off: unchanged.
      await setFlag(false)
      reply = (await feed()).find((i) => i.entityId === A1)!
      expect(reply.metadata?.decideInContext).toBe(true)
      // On: decidable from Home.
      await setFlag(true)
      reply = (await feed()).find((i) => i.entityId === A1)!
      expect(reply.metadata?.decideInContext).toBeUndefined()
      expect(reply.metadata?.openTarget).toBeUndefined()
      expect(reply.action?.type).toBe("decide_approval")
    } finally {
      toolRegistry.delete([ORG, "tickets", "reply"])
      await setFlag(null)
      await sql`UPDATE kernel.approval_requests SET current_payload = '{}'::jsonb WHERE id = ${A1}`
    }
  })

  it("approvals.attention.urgency-boost-near-expiry", async () => {
    const items = await withRlsContext(
      {
        actorType: "user",
        userId: USER_A,
        orgId: ORG,
        scopes: ["tickets:approve"],
        dimensionGrants: {},
      },
      (tx) => computeApprovalAttentionItems(tx, ORG, USER_A),
    )
    const soon = items.find((i) => i.entityId === A_SOON)!
    expect(soon.urgency).toBe(80)
  })

  describe("peer-noise classification (two approvers burying each other)", () => {
    // Distinct id block: the 0910aN range is already taken by the cases above,
    // and ON CONFLICT DO NOTHING turns a clash into a silently missing row.
    const USER_C = "00000000-0000-4000-8000-0000000917c0"
    const P_PEER = "00000000-0000-4000-8000-0000000917b1"
    const P_MINE = "00000000-0000-4000-8000-0000000917b2"
    const P_CANT = "00000000-0000-4000-8000-0000000917b3"
    const P_ROUTINE = "00000000-0000-4000-8000-0000000917b4"

    beforeAll(async () => {
      // USER_C exists but holds NO approve scope: their requests genuinely wait
      // on someone else and must never be folded away.
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
        VALUES (${USER_C}, ${ORG}, 'c@attn.test', 'C', 'active', 'hash') ON CONFLICT DO NOTHING`
      // Both A and B can decide a tickets reply — that symmetry is the whole
      // problem being fixed. The grants must be PERSISTED, not just handed to
      // withRlsContext: the approval_requests RLS policy reads the grant tables,
      // so without them a viewer sees only rows they requested themselves.
      for (const u of [USER_A, USER_B]) {
        await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
          VALUES (${u}, ${ORG}, 'tickets:approve') ON CONFLICT DO NOTHING`
      }

      const tPlus2h = new Date(Date.now() + 2 * 60 * 60 * 1000)
      await insertApproval({
        id: P_PEER,
        toolName: "tickets:reply",
        notifyUserIds: [USER_A, USER_B],
        expiresAt: tPlus2h,
        requestedBy: USER_B,
      })
      await insertApproval({
        id: P_MINE,
        toolName: "tickets:reply",
        notifyUserIds: [USER_A],
        expiresAt: tPlus2h,
        requestedBy: USER_A,
      })
      await insertApproval({
        id: P_CANT,
        toolName: "tickets:reply",
        notifyUserIds: [USER_A],
        expiresAt: tPlus2h,
        requestedBy: USER_C,
      })
      await insertApproval({
        id: P_ROUTINE,
        toolName: "tickets:reply",
        notifyUserIds: [USER_A],
        expiresAt: tPlus2h,
        requestedBy: USER_B,
        metadata: { originRoutineId: "routine-1" },
      })
    })

    async function feedFor(userId: string): Promise<Map<string, unknown>> {
      const items = await withRlsContext(
        {
          actorType: "user",
          userId,
          orgId: ORG,
          scopes: ["tickets:approve"],
          dimensionGrants: {},
        },
        (tx) => computeApprovalAttentionItems(tx, ORG, userId),
      )
      return new Map(items.map((i) => [i.entityId, i.metadata?.peerSelfApprovable]))
    }

    it("marks a peer's request as foldable when that peer can approve their own", async () => {
      expect((await feedFor(USER_A)).get(P_PEER)).toBe(true)
    })

    it("never marks the viewer's OWN request, even though they can self-approve", async () => {
      expect((await feedFor(USER_A)).get(P_MINE)).toBe(false)
    })

    it("never marks a request from someone who CANNOT approve their own", async () => {
      // This is the real queue: fold it and the work silently stops.
      expect((await feedFor(USER_A)).get(P_CANT)).toBe(false)
    })

    it("never marks a routine-raised request", async () => {
      // No human is behind it, so nobody else will pick it up.
      expect((await feedFor(USER_A)).get(P_ROUTINE)).toBe(false)
    })

    it("is computed per VIEWER: B's own request is noise to A but not to B", async () => {
      expect((await feedFor(USER_A)).get(P_PEER)).toBe(true)
      expect((await feedFor(USER_B)).get(P_PEER)).toBe(false)
    })
  })

  describe("wedged executions (prod field regression, 2026-08-04)", () => {
    const asUserA = () =>
      withRlsContext(
        {
          actorType: "user",
          userId: USER_A,
          orgId: ORG,
          scopes: ["tickets:approve"],
          dimensionGrants: {},
        },
        (tx) => computeApprovalAttentionItems(tx, ORG, USER_A),
      )

    it("surfaces an execution wedged past the grace window", async () => {
      // THE BUG: eight of these were invisible on prod for 12-19 days. The
      // approving reaper flags them and list.ts surfaces them, but the feed a
      // human actually looks at queried only `status = 'pending'`.
      const items = await asUserA()
      expect(items.map((i) => i.entityId)).toContain(A_WEDGED)
    })

    it("does NOT surface an execution still inside the grace window", async () => {
      // A handler running right now is not stalled; showing it would ask the
      // human to re-decide something mid-flight.
      const items = await asUserA()
      expect(items.map((i) => i.entityId)).not.toContain(A_APPROVING_FRESH)
    })

    it("ranks a wedged execution above every pending decision", async () => {
      const items = await asUserA()
      const wedged = items.find((i) => i.entityId === A_WEDGED)!
      const nearExpiry = items.find((i) => i.entityId === A_SOON)!
      expect(wedged.urgency).toBe(95)
      expect(wedged.urgency).toBeGreaterThan(nearExpiry.urgency)
    })

    it("labels it as stalled so it does not read as a fresh decision", async () => {
      const items = await asUserA()
      const wedged = items.find((i) => i.entityId === A_WEDGED)!
      expect(wedged.summary).toContain("Stalled")
      expect(wedged.metadata?.wedged).toBe(true)
      // The prefix is English words; the base title the client localizes has none.
      expect(String(wedged.metadata?.baseTitle)).not.toContain("Stalled")
      expect(wedged.summary).toBe(`Stalled: ${wedged.metadata?.baseTitle}`)
    })

    it("leaves pending rows unmarked", async () => {
      const items = await asUserA()
      const pending = items.find((i) => i.entityId === A1)!
      expect(pending.metadata?.wedged).toBeUndefined()
      expect(pending.summary).not.toContain("Stalled")
    })

    it("surfaces a KNOWN-FAILED execution immediately, without waiting out the grace window", async () => {
      // THE SILENT WINDOW. The row is 30s old -- far inside the grace -- but its
      // handler already came back ambiguous, so it is dead, not running.
      const items = await asUserA()
      expect(items.map((i) => i.entityId)).toContain(A_AMBIGUOUS_FRESH)
    })

    it("carries the handler's failure reason so the card can explain why", async () => {
      const items = await asUserA()
      const failed = items.find((i) => i.entityId === A_AMBIGUOUS_FRESH)!
      expect(failed.metadata?.failureReason).toContain("ProductVariantsBulkInput")
      expect(failed.summary).toContain("Stalled")
    })

    it("still hides a fresh execution that has NOT reported a failure", async () => {
      // The two 30s/60s-old rows differ ONLY by the ambiguousAt stamp; without
      // it the grace window must still hide the genuinely in-flight one.
      const items = await asUserA()
      expect(items.map((i) => i.entityId)).not.toContain(A_APPROVING_FRESH)
    })

    it("still applies the notify-set and scope filters to wedged rows", async () => {
      // A wedged row must not become a backdoor around the visibility rules:
      // USER_B is not in A_WEDGED's notify set.
      const items = await withRlsContext(
        {
          actorType: "user",
          userId: USER_B,
          orgId: ORG,
          scopes: ["tickets:approve"],
          dimensionGrants: {},
        },
        (tx) => computeApprovalAttentionItems(tx, ORG, USER_B),
      )
      expect(items.map((i) => i.entityId)).not.toContain(A_WEDGED)
    })
  })

  describe("a failed execution back at pending carries its cause on the row", () => {
    beforeAll(async () => {
      await insertApproval({
        id: A_FAILED_NO_EFFECT,
        toolName: "tickets:reply",
        notifyUserIds: [USER_A],
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })
      await sql`
        INSERT INTO kernel.approved_handler_executions
          (org_id, approval_request_id, tool_name, status, actor_id, attempts, last_attempt_at, finished_at, error)
        VALUES (${ORG}, ${A_FAILED_NO_EFFECT}, 'tickets:reply', 'failed_no_effect', ${USER_A}, 1, now(), now(),
                ${JSON.stringify({ code: "DEMO_RESTRICTED", message: "This is a demo: nothing was sent." })}::jsonb)
        ON CONFLICT (approval_request_id, tool_name) DO NOTHING
      `
    })
    afterAll(async () => {
      await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
    })

    const asUserA = () =>
      withRlsContext(
        {
          actorType: "user",
          userId: USER_A,
          orgId: ORG,
          scopes: ["tickets:approve"],
          dimensionGrants: {},
        },
        (tx) => computeApprovalAttentionItems(tx, ORG, USER_A),
      )

    it("puts the recorded failure on the feed item, whatever app ran it", async () => {
      // A row approved from the feed had only the toast: once it faded the row
      // read as a fresh request. The card reads this same record (list.ts).
      const failed = (await asUserA()).find((i) => i.entityId === A_FAILED_NO_EFFECT)!
      expect(failed.metadata?.lastFailure).toMatchObject({
        code: "DEMO_RESTRICTED",
        message: "This is a demo: nothing was sent.",
      })
      expect(failed.metadata?.wedged).toBeUndefined()
    })

    it("leaves a request that never failed without one", async () => {
      const pending = (await asUserA()).find((i) => i.entityId === A1)!
      expect(pending.metadata?.lastFailure).toBeUndefined()
    })
  })
})
