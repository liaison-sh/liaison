// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  ADDRESSABLE_ENTITY_TYPES,
  matchesMentionType,
  mentionTypeClause,
  NON_REFERENCE_ENTITY_TYPES,
  orderRegistrationsForMentionType,
} from "~/modules/search/mention-types"

describe("mention trigger narrowing", () => {
  it("the @ trigger completes members and nothing else the server holds", () => {
    expect(matchesMentionType("addressable", "user")).toBe(true)
    // A contact is a customer or an outside person: tagging one notifies
    // nobody, and on a bare @ the contacts came back ahead of the colleagues
    // the writer was reaching for. It is an entity, referenced under #.
    expect(matchesMentionType("addressable", "contact")).toBe(false)
    // Channels and approval handles are things, not people: # completes them.
    expect(matchesMentionType("addressable", "thread")).toBe(false)
    expect(matchesMentionType("addressable", "approval_request")).toBe(false)
    // The four "Email-bounce dashboard for support" rows that crowded out the
    // agent a writer was reaching for. A RECORD is what @ must not complete.
    expect(matchesMentionType("addressable", "task")).toBe(false)
    expect(matchesMentionType("addressable", "knowledge_item")).toBe(false)
    expect([...ADDRESSABLE_ENTITY_TYPES]).toEqual(["user"])
  })

  it("the # trigger completes contacts, channels and approval requests", () => {
    expect(matchesMentionType("reference", "contact")).toBe(true)
    expect(matchesMentionType("reference", "thread")).toBe(true)
    expect(matchesMentionType("reference", "approval_request")).toBe(true)
    expect(mentionTypeClause("reference")).not.toContain(`entity_type != "contact"`)
    expect(mentionTypeClause("reference")).not.toContain(`entity_type != "thread"`)
    expect(mentionTypeClause("reference")).not.toContain(`entity_type != "approval_request"`)
  })

  it("narrows the indexed query the same way it narrows the direct-DB top-up", () => {
    const clause = mentionTypeClause("addressable")
    expect(clause).toBeDefined()
    for (const t of ADDRESSABLE_ENTITY_TYPES) {
      expect(clause).toContain(`entity_type = "${t}"`)
    }
    expect(clause).not.toContain(`"task"`)
    // A top-up that re-admits what the index just excluded is the bug the two
    // halves have to agree to prevent.
    expect(matchesMentionType("addressable", "task")).toBe(false)
  })

  it("leaves the other narrowings exactly as they were", () => {
    expect(mentionTypeClause(undefined)).toBeUndefined()
    expect(mentionTypeClause("user")).toBe(`entity_type = "user"`)
    expect(mentionTypeClause("thread")).toBe(`entity_type = "thread"`)
    expect(mentionTypeClause("entity")).toBe(`entity_type != "user" AND entity_type != "thread"`)
    expect(matchesMentionType(undefined, "task")).toBe(true)
    expect(matchesMentionType("entity", "task")).toBe(true)
    expect(matchesMentionType("user", "task")).toBe(false)
  })
})

describe("the # trigger references records, and does not list people", () => {
  it("excludes the members @ addresses", () => {
    for (const t of NON_REFERENCE_ENTITY_TYPES) {
      expect(matchesMentionType("reference", t)).toBe(false)
    }
    expect(matchesMentionType("reference", "user")).toBe(false)
    expect(matchesMentionType("reference", "thread")).toBe(true)
    expect(matchesMentionType("reference", "task")).toBe(true)
    expect(matchesMentionType("reference", "ticket")).toBe(true)
  })

  it("narrows the indexed query the same way", () => {
    const clause = mentionTypeClause("reference")
    expect(clause).toBeDefined()
    for (const t of NON_REFERENCE_ENTITY_TYPES) {
      expect(clause).toContain(`entity_type != "${t}"`)
    }
    expect(clause).toContain(`entity_type != "user"`)
  })

  it("visits the channel registration first and contacts last", () => {
    // `#` used to ask for everything, and the direct-DB top-up filled its
    // whole quota from the first matching registration: contacts, which the
    // kernel registers right after the channel. A bare # was a page of
    // contacts. Contacts are on # now, so they wait until the records are in.
    const regs = [
      { entityType: "thread" },
      { entityType: "contact" },
      { entityType: "task" },
      { entityType: "ticket" },
    ]
    expect(orderRegistrationsForMentionType("reference", regs).map((r) => r.entityType)).toEqual([
      "thread",
      "task",
      "ticket",
      "contact",
    ])
    // Every other narrowing keeps registry order, and nothing is ever dropped.
    expect(orderRegistrationsForMentionType("addressable", regs)).toEqual(regs)
    expect(orderRegistrationsForMentionType(undefined, regs)).toEqual(regs)
  })
})
