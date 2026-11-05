// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression cover for the wrong-author bug on gated ticket replies.
//
// In production, three replies were REQUESTED by one user
// and DECIDED by a colleague, and every one rendered as written by the requester. An
// approved handler executes as the REQUESTER on purpose (RLS/scope reasons,
// run-approved-handler.ts), and `insertOutboundMessage` stamped `created_by`
// from that execution actor — so the decider's identity, which the kernel
// already has, never reached the message row.
//
// The fix persists the approver alongside the author rather than replacing it:
// a gated reply genuinely has two people behind it and the conversation shows
// both. These tests pin the PROJECTION contract the UI reads.

import { describe, expect, it } from "bun:test"
import { toCamelMessage } from "~/apps/tickets/projection"

describe("outbound message attribution", () => {
  it("carries BOTH the drafter and the approver for a gated reply", () => {
    const m = toCamelMessage({
      id: "m1",
      ticket_id: "t1",
      kind: "outbound",
      sent_at: "2026-08-05T10:19:22.652Z",
      created_by: "fc420f33-800d-49f2-93f9-bd68ef99eb8a",
      author_name: "Pat Rivera",
      approved_by: "9ab229d3-56e7-4dba-ac76-46cd18bd5ab4",
      approver_name: "Morgan Lee",
    })
    expect(m.authorName).toBe("Pat Rivera")
    expect(m.approverName).toBe("Morgan Lee")
    expect(m.approvedBy).toBe("9ab229d3-56e7-4dba-ac76-46cd18bd5ab4")
    // The drafter must NOT be overwritten by the approver: both are real facts.
    expect(m.createdBy).toBe("fc420f33-800d-49f2-93f9-bd68ef99eb8a")
  })

  // A message sent directly (no approval) has one author and must not sprout a
  // phantom approver — that is what the UI's "approved by" chip keys off.
  it("leaves the approver null on a direct send", () => {
    const m = toCamelMessage({
      id: "m2",
      ticket_id: "t1",
      kind: "outbound",
      sent_at: "2026-07-30T14:58:00Z",
      created_by: "9ab229d3-56e7-4dba-ac76-46cd18bd5ab4",
      author_name: "Morgan Lee",
      approved_by: null,
      approver_name: null,
    })
    expect(m.authorName).toBe("Morgan Lee")
    expect(m.approvedBy).toBeNull()
    expect(m.approverName).toBeNull()
  })

  // Self-approved: requester and decider are the same person. Showing
  // "approved by X" next to "X" would be noise, so the UI compares the two;
  // the projection still reports both truthfully.
  it("reports both even when the requester approved their own request", () => {
    const m = toCamelMessage({
      id: "m3",
      ticket_id: "t1",
      kind: "outbound",
      sent_at: "2026-08-05T10:00:00Z",
      created_by: "98981348-d514-4381-827a-11fd0685c650",
      author_name: "Quinn",
      approved_by: "98981348-d514-4381-827a-11fd0685c650",
      approver_name: "Quinn",
    })
    expect(m.authorName).toBe(m.approverName)
  })
})

// Routine attribution (reported 2026-08-05: "tous mes messages partent avec ton
// nom attribué"). A routine executes as its OWNER, so `created_by` on a
// routine-drafted reply is whoever created the routine, not an actor who chose
// to send. The label overrides the display without rewriting the audit trail.
describe("routine-originated attribution", () => {
  it("prefers the routine label over the owner's name", () => {
    const m = toCamelMessage({
      id: "m4",
      ticket_id: "t1",
      kind: "outbound",
      sent_at: "2026-08-05T12:00:00Z",
      created_by: "fc420f33-800d-49f2-93f9-bd68ef99eb8a",
      author_name: "Pat Rivera",
      author_label: "Routine: Support triage",
    })
    expect(m.authorLabel).toBe("Routine: Support triage")
    // The audit trail is untouched: created_by still records the execution
    // identity, which is what permissions were resolved against.
    expect(m.createdBy).toBe("fc420f33-800d-49f2-93f9-bd68ef99eb8a")
    expect(m.authorName).toBe("Pat Rivera")
  })

  it("leaves the label null for an ordinary human send", () => {
    const m = toCamelMessage({
      id: "m5",
      ticket_id: "t1",
      kind: "outbound",
      sent_at: "2026-08-05T12:00:00Z",
      created_by: "9ab229d3-56e7-4dba-ac76-46cd18bd5ab4",
      author_name: "Morgan Lee",
      author_label: null,
    })
    expect(m.authorLabel).toBeNull()
    expect(m.authorName).toBe("Morgan Lee")
  })
})
