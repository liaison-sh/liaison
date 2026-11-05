// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  displayTicketHandle,
  parseTicketHandleNumber,
  readTicketIdSegment,
  ticketIdSegmentSchema,
  ticketsSettingsDefaults,
  ticketsSettingsSchema,
} from "./tickets-settings"

describe("ticketsSettingsSchema", () => {
  it("accepts labelled holidays", () => {
    const result = ticketsSettingsSchema.safeParse({
      ...ticketsSettingsDefaults,
      sla: {
        ...ticketsSettingsDefaults.sla,
        businessHours: {
          ...ticketsSettingsDefaults.sla.businessHours,
          holidays: [{ date: "2026-12-25", label: "Christmas" }],
        },
      },
    })
    expect(result.success).toBe(true)
  })

  it("rejects string holidays and unknown nested keys", () => {
    expect(
      ticketsSettingsSchema.safeParse({
        ...ticketsSettingsDefaults,
        sla: {
          ...ticketsSettingsDefaults.sla,
          businessHours: {
            ...ticketsSettingsDefaults.sla.businessHours,
            holidays: ["2026-12-25"],
          },
        },
      }).success,
    ).toBe(false)

    expect(
      ticketsSettingsSchema.safeParse({
        ...ticketsSettingsDefaults,
        emailTemplate: { ...ticketsSettingsDefaults.emailTemplate, surprise: true },
      }).success,
    ).toBe(false)
  })

  it("rejects obsolete mail transport secrets", () => {
    expect(
      ticketsSettingsSchema.safeParse({
        ...ticketsSettingsDefaults,
        resend: { apiKey: null, fromAddress: null, fromName: null },
      }).success,
    ).toBe(false)
    expect(
      ticketsSettingsSchema.safeParse({
        ...ticketsSettingsDefaults,
        gmailPushSecret: null,
      }).success,
    ).toBe(false)
  })
})

// Ticket display ids `ticket-<CODE>-<n>` (design item 5, S18-S20). The stored
// handle stays `ticket-<n>`; the display is computed from the ticket's CURRENT
// segment field, and every form parses back to the same number.
describe("ticket id segments", () => {
  it("idSegment is optional in the full schema, with no default applied", () => {
    const parsed = ticketsSettingsSchema.parse({ ...ticketsSettingsDefaults })
    expect("idSegment" in parsed).toBe(false)
    expect(
      ticketsSettingsSchema.safeParse({
        ...ticketsSettingsDefaults,
        idSegment: { by: "audience", codes: { b2b: "B2B", b2c: "B2C" } },
      }).success,
    ).toBe(true)
  })

  it("uppercases codes and refuses bad codes, duplicates and unknown fields", () => {
    const ok = ticketIdSegmentSchema.parse({ by: "audience", codes: { b2b: " b2b ", b2c: "c2" } })
    expect(ok.codes).toEqual({ b2b: "B2B", b2c: "C2" })
    expect(ticketIdSegmentSchema.safeParse({ by: "audience", codes: { b2b: "B-2" } }).success).toBe(
      false,
    )
    expect(
      ticketIdSegmentSchema.safeParse({ by: "audience", codes: { b2b: "TOOLONGCODE" } }).success,
    ).toBe(false)
    expect(ticketIdSegmentSchema.safeParse({ by: "audience", codes: { b2b: "" } }).success).toBe(
      false,
    )
    expect(
      ticketIdSegmentSchema.safeParse({ by: "team", codes: { Ops: "X", Sales: "x" } }).success,
    ).toBe(false)
    expect(ticketIdSegmentSchema.safeParse({ by: "priority", codes: {} }).success).toBe(false)
  })

  it("parses every handle form to the same number", () => {
    expect(parseTicketHandleNumber("ticket-12")).toBe("12")
    expect(parseTicketHandleNumber("TICKET-12")).toBe("12")
    expect(parseTicketHandleNumber("ticket-B2B-12")).toBe("12")
    expect(parseTicketHandleNumber("ticket-b2c-12")).toBe("12")
    expect(parseTicketHandleNumber(" ticket-B2B-0012 ")).toBe("12")
    expect(parseTicketHandleNumber("ticket-")).toBeNull()
    expect(parseTicketHandleNumber("ticket-B2B-")).toBeNull()
    expect(parseTicketHandleNumber("ticket-B-2-12")).toBeNull()
    expect(parseTicketHandleNumber("12")).toBeNull()
    expect(parseTicketHandleNumber("request-12")).toBeNull()
  })

  it("formats the display handle from the current field value", () => {
    const cfg = { by: "audience" as const, codes: { b2b: "B2B", b2c: "B2C" } }
    expect(displayTicketHandle("ticket-12", { audience: "b2b" }, cfg)).toBe("ticket-B2B-12")
    // reclassified: the segment follows, the number never changes
    expect(displayTicketHandle("ticket-12", { audience: "b2c" }, cfg)).toBe("ticket-B2C-12")
    // no value, or a value without a code: the plain form
    expect(displayTicketHandle("ticket-12", { audience: null }, cfg)).toBe("ticket-12")
    expect(displayTicketHandle("ticket-12", {}, { by: "audience", codes: {} })).toBe("ticket-12")
    // not segmenting
    expect(
      displayTicketHandle("ticket-12", { audience: "b2b" }, { by: "none", codes: cfg.codes }),
    ).toBe("ticket-12")
    // the other fields
    expect(
      displayTicketHandle("ticket-7", { team: "Ops" }, { by: "team", codes: { Ops: "OPS" } }),
    ).toBe("ticket-OPS-7")
    expect(
      displayTicketHandle(
        "ticket-7",
        { categoryId: "c1" },
        { by: "category", codes: { c1: "SHIP" } },
      ),
    ).toBe("ticket-SHIP-7")
    expect(
      displayTicketHandle(
        "ticket-7",
        { sourceInboxId: "i1" },
        { by: "inbox", codes: { i1: "FR" } },
      ),
    ).toBe("ticket-FR-7")
    // a stored handle that is not `ticket-<n>` is shown as stored
    expect(displayTicketHandle("ticket-17-3", { audience: "b2b" }, cfg)).toBe("ticket-17-3")
  })

  it("a malformed stored config reads as not segmenting", () => {
    expect(readTicketIdSegment(undefined)).toEqual({ by: "none", codes: {} })
    expect(readTicketIdSegment({ by: "bogus" })).toEqual({ by: "none", codes: {} })
    expect(readTicketIdSegment({ by: "audience", codes: { b2b: "B2B" } })).toEqual({
      by: "audience",
      codes: { b2b: "B2B" },
    })
  })
})
