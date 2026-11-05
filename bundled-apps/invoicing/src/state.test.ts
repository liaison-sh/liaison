// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { transition } from "./state"

describe("transition — invoice", () => {
  test.each<[string, string, string]>([
    ["draft", "issue", "issued"],
    ["draft", "submit_for_approval", "pending_approval"],
    ["pending_approval", "approve_issue", "issued"],
    ["pending_approval", "reject", "draft"],
    ["issued", "mark_paid", "paid"],
    ["issued", "mark_refunded", "refunded"],
    ["paid", "mark_refunded", "refunded"],
  ])("invoice %s + %s → %s", (current, event, next) => {
    const r = transition({ type: "invoice", status: current }, event)
    expect(r).toEqual({ status: "ok", next })
  })

  test.each<[string, string]>([
    ["paid", "issue"],
    ["paid", "submit_for_approval"],
    ["issued", "issue"],
    ["draft", "mark_paid"],
    ["draft", "approve_issue"],
    ["refunded", "mark_paid"],
  ])("invoice invalid transition %s + %s", (current, event) => {
    const r = transition({ type: "invoice", status: current }, event)
    expect(r).toEqual({ status: "invalid_transition" })
  })

  test("idempotent self-transition paid → paid is invalid (must use mark_refunded etc)", () => {
    const r = transition({ type: "invoice", status: "paid" }, "mark_paid")
    expect(r).toEqual({ status: "invalid_transition" })
  })
})

describe("transition — quote", () => {
  test.each<[string, string, string]>([
    ["draft", "send", "sent"],
    ["sent", "accept", "accepted"],
    ["accepted", "convert_to_invoice", "invoiced"],
    ["sent", "reject", "rejected"],
    ["sent", "expire", "expired"],
  ])("quote %s + %s → %s", (current, event, next) => {
    const r = transition({ type: "quote", status: current }, event)
    expect(r).toEqual({ status: "ok", next })
  })

  test("quote rejects mark_paid (type-mismatched event)", () => {
    const r = transition({ type: "quote", status: "accepted" }, "mark_paid")
    expect(r).toEqual({ status: "invalid_transition" })
  })
})

describe("transition — proforma", () => {
  test.each<[string, string, string]>([
    ["draft", "send", "sent"],
    ["sent", "convert_to_invoice", "invoiced"],
    ["sent", "close", "closed"],
  ])("proforma %s + %s → %s", (current, event, next) => {
    const r = transition({ type: "proforma", status: current }, event)
    expect(r).toEqual({ status: "ok", next })
  })

  test("proforma cannot transition from closed (terminal state)", () => {
    const r = transition({ type: "proforma", status: "closed" }, "convert_to_invoice")
    expect(r).toEqual({ status: "invalid_transition" })
  })
})

describe("transition — purchase_order", () => {
  test.each<[string, string, string]>([
    ["draft", "send", "sent"],
    ["sent", "mark_received", "received"],
    ["sent", "cancel", "cancelled"],
    ["draft", "cancel", "cancelled"],
  ])("po %s + %s → %s", (current, event, next) => {
    const r = transition({ type: "purchase_order", status: current }, event)
    expect(r).toEqual({ status: "ok", next })
  })

  test("po cannot transition from received (terminal state)", () => {
    const r = transition({ type: "purchase_order", status: "received" }, "cancel")
    expect(r).toEqual({ status: "invalid_transition" })
  })
})

describe("transition — credit_note", () => {
  test("credit_note draft + issue → issued", () => {
    const r = transition({ type: "credit_note", status: "draft" }, "issue")
    expect(r).toEqual({ status: "ok", next: "issued" })
  })

  test("credit_note is NOT payable — mark_paid is invalid from issued", () => {
    const r = transition({ type: "credit_note", status: "issued" }, "mark_paid")
    expect(r).toEqual({ status: "invalid_transition" })
  })

  test("credit_note is NOT refundable — mark_refunded is invalid from issued", () => {
    const r = transition({ type: "credit_note", status: "issued" }, "mark_refunded")
    expect(r).toEqual({ status: "invalid_transition" })
  })
})

describe("transition — unknown event / type", () => {
  test("unknown event returns invalid_transition", () => {
    const r = transition({ type: "invoice", status: "draft" }, "not_a_real_event")
    expect(r).toEqual({ status: "invalid_transition" })
  })
})
