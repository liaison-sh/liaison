// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import type { PrivilegedDb } from "~/db"
import {
  loadEffectiveSignature,
  outboundLoopSuppressionHeaders,
  ticketsClose,
  ticketsClosePreflight,
  ticketsNudge,
  ticketsNudgePreflight,
  ticketsReply,
  ticketsReplyPreflight,
} from "./tools"

describe("outboundLoopSuppressionHeaders", () => {
  it("stamps ONLY the acknowledgement — it is the only genuinely automatic send", () => {
    // RFC 3834 §5: `auto-replied` means generated automatically in response to
    // another message. That is the ack, and nothing else we send.
    expect(outboundLoopSuppressionHeaders("acknowledgement")).toEqual({
      "Auto-Submitted": "auto-replied",
      Precedence: "bulk",
    })
  })

  it("leaves human-authored sends unmarked (reply / nudge / close)", () => {
    // Regression, observed live 2026-07-28: a desk reply carried
    // `Auto-Submitted: auto-replied`, and the receiving side — Liaison's own
    // `detectAutoResponder` — refused it. Any customer running a helpdesk
    // would silently never see our answer on their ticket. `Precedence: bulk`
    // additionally invites spam filing on a personal support reply.
    for (const kind of ["reply", "nudge", "close"] as const) {
      expect(
        outboundLoopSuppressionHeaders(kind),
        `${kind} must not claim to be automatic`,
      ).toEqual({})
    }
  })

  it("what it emits is exactly what our own inbound guard drops", async () => {
    // The two halves must agree: the ack we stamp is the ack we would refuse
    // on the way back in. If this ever diverges, either acks loop or human
    // replies get eaten.
    const { detectAutoResponder } = await import("./inbound-auto-responder")
    const ack = outboundLoopSuppressionHeaders("acknowledgement")
    expect(detectAutoResponder({ "Auto-Submitted": [ack["Auto-Submitted"]!] })).not.toBeNull()
    const reply = outboundLoopSuppressionHeaders("reply")
    const asHeaders = Object.fromEntries(Object.entries(reply).map(([k, v]) => [k, [v]]))
    expect(detectAutoResponder(asHeaders)).toBeNull()
  })
})

// Ticket ids are uuids on the wire (the tools resolve a `ticket-<n>` handle to
// one before any query), so these fakes use real uuids rather than "t1".
const T1 = "11111111-1111-4111-8111-111111111111"
const MISSING_TICKET = "22222222-2222-4222-8222-222222222222"

type FakeQueryRow = Record<string, unknown>

function fakeTx(scenarios: FakeQueryRow[][] = [[]]) {
  let i = 0
  const inserts: { sql: string; params: unknown[] }[] = []
  return {
    tx: {
      execute: async (raw: { sql?: string; queryChunks?: unknown[]; values?: unknown[] }) => {
        // Drizzle SQL fragment objects are opaque here; we just rotate scripted rows.
        const rows = scenarios[i] ?? []
        i = Math.min(i + 1, scenarios.length - 1)
        // Capture insert intent for assertions
        const text = raw?.sql ?? JSON.stringify(raw?.queryChunks ?? "")
        inserts.push({ sql: String(text), params: raw?.values ?? [] })
        return { rows } as never
      },
    } as never,
    orgId: "00000000-0000-0000-0000-000000000001",
    actor: { actorType: "user" as const, userId: "u-1" },
    inserts,
  }
}

describe("ticketsReply", () => {
  it("rejects missing ticketId", async () => {
    const ctx = fakeTx([[]])
    const r = await ticketsReply({ ticketId: "" }, ctx)
    expect("error" in r && r.error.code).toBe("invalid_params")
  })

  it("rejects merged ticket via preflight", async () => {
    const ctx = fakeTx([
      [
        {
          id: T1,
          status: "open",
          reply_token: "tok",
          source_inbox_id: "i1",
          last_outbound_at: null,
          nudge_sent_at: null,
          closed_reason: null,
          merged_into_ticket_id: "t-leaf",
          converted_to_mail_conversation_id: null,
        },
      ],
    ])
    const r = await ticketsReply({ ticketId: T1, textBody: "hi" }, ctx)
    expect("error" in r && r.error.code).toBe("merged_ticket")
  })

  it("rejects converted ticket via preflight", async () => {
    const ctx = fakeTx([
      [
        {
          id: T1,
          status: "open",
          reply_token: "tok",
          source_inbox_id: "i1",
          last_outbound_at: null,
          nudge_sent_at: null,
          closed_reason: null,
          merged_into_ticket_id: null,
          converted_to_mail_conversation_id: "conv-1",
        },
      ],
    ])
    const r = await ticketsReply({ ticketId: T1, textBody: "hi" }, ctx)
    expect("error" in r && r.error.code).toBe("converted_ticket")
  })

  it("rejects ticket without source inbox", async () => {
    const ctx = fakeTx([
      [
        {
          id: T1,
          status: "open",
          reply_token: "tok",
          source_inbox_id: null,
          last_outbound_at: null,
          nudge_sent_at: null,
          closed_reason: null,
          merged_into_ticket_id: null,
          converted_to_mail_conversation_id: null,
        },
      ],
    ])
    const r = await ticketsReply({ ticketId: T1, textBody: "hi" }, ctx)
    expect("error" in r && r.error.code).toBe("no_inbox")
  })

  it("rejects when ticket missing", async () => {
    const ctx = fakeTx([[]])
    const r = await ticketsReply({ ticketId: MISSING_TICKET }, ctx)
    expect("error" in r && r.error.code).toBe("not_found")
  })

  const openTicket = {
    id: T1,
    status: "open",
    reply_token: "tok",
    source_inbox_id: "i1",
    last_outbound_at: null,
    nudge_sent_at: null,
    closed_reason: null,
    merged_into_ticket_id: null,
    converted_to_mail_conversation_id: null,
  }

  // A single inbound customer message — satisfies the no_recipient preflight (a prior message
  // with a from_email) so the downstream attachment/recipient logic is reached.
  const customerRecipientRow = [
    { requester_email: "customer@example.com", participant_emails: [], first_sender: null },
  ]

  it("rejects ticket with no inbound customer recipient via preflight", async () => {
    // A ticket that has a source inbox but NO inbound customer message (e.g. one CREATED inside
    // Liaison, or holding only internal notes) cannot resolve a `To:` and would only fail at the
    // gated decide/execute (`send_preflight_failed`, a post-approval non-2xx). The early preflight
    // must reject it AT CALL TIME with a distinct `no_recipient` code so the agent never queues an
    // un-executable gated reply. Fails-without (the late-failure regression), passes-with.
    const ctx = fakeTx([
      [openTicket],
      [], // recipient lookup → no inbound customer message
    ])
    const r = await ticketsReply({ ticketId: T1, textBody: "hi" }, ctx)
    expect("error" in r && r.error.code).toBe("no_recipient")
  })

  it("rejects an attachment the agent cannot see", async () => {
    // ticketsReply runs the shared preflight (loadTicket + recipient), then loads the ticket again
    // before resolving attachments — so the scripted rows carry the ticket twice.
    const ctx = fakeTx([
      [openTicket], // preflight loadTicket
      customerRecipientRow, // preflight recipient → passes (no attachmentSessionId to check)
      [openTicket], // ticketsReply loadTicket (post-preflight)
      [], // attachment file lookup → not visible
    ])
    const r = await ticketsReply(
      { ticketId: T1, textBody: "hi", attachments: ["44444444-4444-4444-8444-444444444444"] },
      ctx,
    )
    expect("error" in r && r.error.code).toBe("parent_not_found")
  })

  it("rejects an executable attachment via the denylist", async () => {
    const ctx = fakeTx([
      [openTicket], // preflight loadTicket
      customerRecipientRow, // preflight recipient → passes
      [openTicket], // ticketsReply loadTicket (post-preflight)
      [{ filename: "payload.exe", mime_type: "application/x-msdownload", storage_key: "k" }],
    ])
    const r = await ticketsReply(
      { ticketId: T1, textBody: "hi", attachments: ["22222222-2222-4222-8222-222222222222"] },
      ctx,
    )
    expect("error" in r && r.error.code).toBe("unsafe_file_type")
  })

  it("folds an imported kernel fileId passed in attachmentSessionId into the attachments path", async () => {
    // Ergonomics: a weak model often puts an imported file id in `attachmentSessionId`
    // instead of `attachments`. The shared preflight must recognise a real kernel.files id there
    // and route it through the validated attachments path. We prove the fold by making
    // the resolved file an executable → the denylist (which only runs on the attachments
    // path) must reject it. Without the fold, attachments stays empty and this never trips.
    const ctx = fakeTx([
      [openTicket], // preflight loadTicket
      customerRecipientRow, // preflight recipient → passes
      [{ id: "33333333-3333-4333-8333-333333333333" }], // preflight fold: attachmentSessionId IS a kernel.files id
      [openTicket], // ticketsReply loadTicket (post-preflight)
      [{ filename: "payload.exe", mime_type: "application/x-msdownload", storage_key: "k" }],
    ])
    const r = await ticketsReply(
      { ticketId: T1, textBody: "hi", attachmentSessionId: "33333333-3333-4333-8333-333333333333" },
      ctx,
    )
    expect("error" in r && r.error.code).toBe("unsafe_file_type")
  })

  it("rejects an attachmentSessionId that resolves to no staged upload AT CALL TIME", async () => {
    // RMA-bundle late-failure regression: a weak model setting up an RMA commonly stuffs the PRIOR
    // gated call's APPROVAL-REQUEST id (e.g. the return-label create_shipment approval id) into
    // `attachmentSessionId`, conflating "the label I just staged" with "a file to attach". That id is
    // neither a kernel.files id NOR a staged upload session, so before this preflight it passed
    // propose-time and only failed at decide/execute inside reparentSessionAttachments with a non-2xx
    // `not_found` — a post-approval failure the chaos runner VERDICT-OVERRIDEs to fail. The shared
    // preflight must reject it AT CALL TIME with a distinct `invalid_attachment_session` code so the
    // agent drops the bad id instead of queuing an un-executable gated reply. Fails-without (the late
    // failure), passes-with. ticketsReply returns inside the preflight, so no second loadTicket runs.
    const ctx = fakeTx([
      [openTicket], // preflight loadTicket
      customerRecipientRow, // preflight recipient → passes
      [], // preflight fold lookup → NOT a file id (an approval-request id)
      [], // preflight staged upload session lookup → no session with files
    ])
    const r = await ticketsReply(
      { ticketId: T1, textBody: "hi", attachmentSessionId: "appr-req-bb3f7960" },
      ctx,
    )
    expect("error" in r && r.error.code).toBe("invalid_attachment_session")
  })

  it("ticketsReplyPreflight returns the same invalid_attachment_session error at PROPOSE time", async () => {
    // The manifest `preflight` slot runs THIS at propose (before the approval is queued), so the agent
    // sees the error in-loop. Same scripted query order as the shared preflight: loadTicket, recipient,
    // fold lookup (not a file), session lookup (no session).
    const ctx = fakeTx([[openTicket], customerRecipientRow, [], []])
    const r = await ticketsReplyPreflight(
      { ticketId: T1, textBody: "hi", attachmentSessionId: "appr-req-bb3f7960" },
      ctx,
    )
    expect("error" in r && r.error.code).toBe("invalid_attachment_session")
  })

  it("ticketsReplyPreflight passes (ok) a plain reply with no attachment", async () => {
    const ctx = fakeTx([
      [openTicket], // preflight loadTicket
      customerRecipientRow, // recipient → passes
    ])
    const r = await ticketsReplyPreflight({ ticketId: T1, textBody: "hi" }, ctx)
    expect("error" in r).toBe(false)
  })
})

// Visible signature text, ticket 10309 (Morgan: "tous mes tickets sont signes
// Pat Rivera"). Unit-level coverage of loadEffectiveSignature's own
// precedence logic ONLY (fake db, hand-passed override) -- it does NOT prove
// the override actually reaches this function on the live reply-drafting
// path. That seam (ticketsDraftSignature resolving the routine ambiently via
// currentRunContext(), through the real runAdminOp("tools.draftSignature")
// call) is covered end to end in routine-draft-signature.test.ts.
describe("loadEffectiveSignature — routine-drafted replies do not sign as the owner", () => {
  function fakePrivilegedDb(scenarios: Record<string, unknown>[][]): PrivilegedDb {
    let i = 0
    return {
      execute: async () => {
        const rows = scenarios[i] ?? []
        i = Math.min(i + 1, scenarios.length - 1)
        return { rows } as never
      },
    } as unknown as PrivilegedDb
  }

  it("signs with the routine's name, not the owner's personal signature", async () => {
    // No inbox signature configured; a routine name IS resolvable. The personal
    // fallback query must never even run — if it did with this fake db it would
    // return no scripted rows and this assertion would still fail loudly.
    const db = fakePrivilegedDb([[{ signature_text: null }]])
    const sig = await loadEffectiveSignature(
      db,
      "org-1",
      "inbox-1",
      "owner-user-1",
      "Support triage",
    )
    expect(sig?.text).toBe("Support triage")
  })

  it("does NOT fall back to the owner's personal signature when the routine name cannot be resolved", async () => {
    // This is the exact failure mode reported: routineNameOverride is `null`
    // (routine present but its name failed to resolve), and WITHOUT the fix the
    // old code ignored the override entirely and fell through to the owner's
    // personal signature_text row below — scripted here as "Pat Rivera" to
    // prove it is never read.
    const db = fakePrivilegedDb([
      [{ signature_text: null }], // inbox lookup: no inbox signature configured
      [{ signature_text: "Pat Rivera" }], // owner's personal signature (must NOT be used)
    ])
    const sig = await loadEffectiveSignature(db, "org-1", "inbox-1", "owner-user-1", null)
    expect(sig).toBeNull()
  })

  it("still signs with the acting user's personal signature for an ordinary human/system send", async () => {
    // routineNameOverride === undefined (the default, no third arg) is the
    // ordinary non-routine path and must keep working exactly as before.
    const db = fakePrivilegedDb([
      [{ signature_text: null }], // inbox lookup: no inbox signature configured
      [{ signature_text: "Morgan Lee" }], // acting user's own personal signature
    ])
    const sig = await loadEffectiveSignature(db, "org-1", "inbox-1", "acting-user-1")
    expect(sig?.text).toBe("Morgan Lee")
  })
})

describe("ticketsNudge", () => {
  it("rejects when status is not awaiting_customer", async () => {
    const ctx = fakeTx([
      [
        {
          id: T1,
          status: "open",
          reply_token: "tok",
          source_inbox_id: "i1",
          last_outbound_at: null,
          nudge_sent_at: null,
          closed_reason: null,
          merged_into_ticket_id: null,
          converted_to_mail_conversation_id: null,
        },
      ],
    ])
    const r = await ticketsNudge({ ticketId: T1, textBody: "?" }, ctx)
    expect("error" in r && r.error.code).toBe("wrong_status")
  })

  it("rejects when nudge already sent", async () => {
    const ctx = fakeTx([
      [
        {
          id: T1,
          status: "awaiting_customer",
          reply_token: "tok",
          source_inbox_id: "i1",
          last_outbound_at: new Date(),
          nudge_sent_at: new Date(),
          closed_reason: null,
          merged_into_ticket_id: null,
          converted_to_mail_conversation_id: null,
        },
      ],
    ])
    const r = await ticketsNudge({ ticketId: T1, textBody: "?" }, ctx)
    expect("error" in r && r.error.code).toBe("nudge_already_sent")
  })

  it("rejects merged ticket", async () => {
    const ctx = fakeTx([
      [
        {
          id: T1,
          status: "awaiting_customer",
          reply_token: "tok",
          source_inbox_id: "i1",
          last_outbound_at: new Date(),
          nudge_sent_at: null,
          closed_reason: null,
          merged_into_ticket_id: "leaf",
          converted_to_mail_conversation_id: null,
        },
      ],
    ])
    const r = await ticketsNudge({ ticketId: T1, textBody: "?" }, ctx)
    expect("error" in r && r.error.code).toBe("merged_ticket")
  })

  it("rejects when ticket missing", async () => {
    const ctx = fakeTx([[]])
    const r = await ticketsNudge({ ticketId: MISSING_TICKET, textBody: "?" }, ctx)
    expect("error" in r && r.error.code).toBe("not_found")
  })

  it("BL-89: accepts awaiting_followup (passes the status gate, not wrong_status)", async () => {
    // setFollowup-then-nudge order moves the ticket to awaiting_followup before the gated nudge
    // executes; nudge must still be valid there. Use an already-nudged ticket so we assert it
    // reached the nudge_already_sent check (i.e. cleared the status gate) without the send path.
    const ctx = fakeTx([
      [
        {
          id: T1,
          status: "awaiting_followup",
          reply_token: "tok",
          source_inbox_id: "i1",
          last_outbound_at: new Date(),
          nudge_sent_at: new Date(),
          closed_reason: null,
          merged_into_ticket_id: null,
          converted_to_mail_conversation_id: null,
        },
      ],
    ])
    const r = await ticketsNudge({ ticketId: T1, textBody: "?" }, ctx)
    expect("error" in r && r.error.code).toBe("nudge_already_sent")
  })
})

describe("ticketsClose", () => {
  it("rejects merged ticket", async () => {
    const ctx = fakeTx([
      [
        {
          id: T1,
          status: "open",
          reply_token: "tok",
          source_inbox_id: "i1",
          last_outbound_at: null,
          nudge_sent_at: null,
          closed_reason: null,
          merged_into_ticket_id: "leaf",
          converted_to_mail_conversation_id: null,
        },
      ],
    ])
    const r = await ticketsClose({ ticketId: T1, closedReason: "resolved" }, ctx)
    expect("error" in r && r.error.code).toBe("merged_ticket")
  })

  it("rejects converted ticket", async () => {
    const ctx = fakeTx([
      [
        {
          id: T1,
          status: "open",
          reply_token: "tok",
          source_inbox_id: "i1",
          last_outbound_at: null,
          nudge_sent_at: null,
          closed_reason: null,
          merged_into_ticket_id: null,
          converted_to_mail_conversation_id: "conv",
        },
      ],
    ])
    const r = await ticketsClose({ ticketId: T1, closedReason: "resolved" }, ctx)
    expect("error" in r && r.error.code).toBe("converted_ticket")
  })

  it("rejects missing ticketId", async () => {
    const ctx = fakeTx([[]])
    const r = await ticketsClose({ ticketId: "", closedReason: "resolved" }, ctx)
    expect("error" in r && r.error.code).toBe("invalid_params")
  })

  it("rejects when ticket missing", async () => {
    const ctx = fakeTx([[]])
    const r = await ticketsClose({ ticketId: MISSING_TICKET, closedReason: "resolved" }, ctx)
    expect("error" in r && r.error.code).toBe("not_found")
  })
})

// Stage-time preflights for the GATED tickets:nudge / tickets:close (manifest `preflight`). Both tools
// are gated, so before these existed every call parked a pending approval and the validation below only
// ran once a human clicked approve: the approver got an error only the agent could have fixed. These
// pin that the refusal happens at the CALL SITE and that the preflight is read-only (it issues the
// single ticket SELECT and nothing else, so no approval is parked and the send path is never reached).
const AWAITING_NUDGED = {
  id: T1,
  status: "awaiting_customer",
  reply_token: "tok",
  source_inbox_id: "i1",
  last_outbound_at: new Date(),
  nudge_sent_at: new Date(),
  closed_reason: null,
  merged_into_ticket_id: null,
  converted_to_mail_conversation_id: null,
}

describe("ticketsNudgePreflight (stage-time refusal)", () => {
  it("refuses a nudge on a ticket that is not awaiting the customer, before any approval is parked", async () => {
    const ctx = fakeTx([[{ ...AWAITING_NUDGED, status: "open", nudge_sent_at: null }]])
    const r = await ticketsNudgePreflight({ ticketId: T1, textBody: "?" }, ctx)
    expect("error" in r && r.error.code).toBe("wrong_status")
    expect(ctx.inserts).toHaveLength(1)
  })

  it("refuses a second nudge on an already-nudged ticket", async () => {
    const ctx = fakeTx([[AWAITING_NUDGED]])
    const r = await ticketsNudgePreflight({ ticketId: T1, textBody: "?" }, ctx)
    expect("error" in r && r.error.code).toBe("nudge_already_sent")
    expect(ctx.inserts).toHaveLength(1)
  })

  it("refuses an unknown ticket and an empty body", async () => {
    const missing = fakeTx([[]])
    expect(
      "error" in
        (await ticketsNudgePreflight({ ticketId: MISSING_TICKET, textBody: "?" }, missing)),
    ).toBe(true)
    const noBody = fakeTx([[{ ...AWAITING_NUDGED, nudge_sent_at: null }]])
    const r = await ticketsNudgePreflight({ ticketId: T1, textBody: "   " }, noBody)
    expect("error" in r && r.error.code).toBe("invalid_params")
    expect(noBody.inserts).toHaveLength(1)
  })

  it("passes a genuinely nudgeable ticket through to the gate", async () => {
    const ctx = fakeTx([[{ ...AWAITING_NUDGED, nudge_sent_at: null }]])
    const r = await ticketsNudgePreflight({ ticketId: T1, textBody: "still waiting?" }, ctx)
    expect("error" in r).toBe(false)
    expect(ctx.inserts).toHaveLength(1)
  })
})

describe("ticketsClosePreflight (stage-time refusal)", () => {
  it("refuses a close aimed at a ticket that does not exist, before any approval is parked", async () => {
    const ctx = fakeTx([[]])
    const r = await ticketsClosePreflight({ ticketId: MISSING_TICKET }, ctx)
    expect("error" in r && r.error.code).toBe("not_found")
    expect(ctx.inserts).toHaveLength(1)
  })

  it("refuses a close on a merged ticket", async () => {
    const ctx = fakeTx([[{ ...AWAITING_NUDGED, status: "open", merged_into_ticket_id: "leaf" }]])
    const r = await ticketsClosePreflight({ ticketId: T1 }, ctx)
    expect("error" in r && r.error.code).toBe("merged_ticket")
    expect(ctx.inserts).toHaveLength(1)
  })

  it("passes a live ticket through to the gate", async () => {
    const ctx = fakeTx([[{ ...AWAITING_NUDGED, status: "open" }]])
    const r = await ticketsClosePreflight({ ticketId: T1 }, ctx)
    expect("error" in r).toBe(false)
    expect(ctx.inserts).toHaveLength(1)
  })
})
