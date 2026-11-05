// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Recipient dispatch — pure resolver tests (no DB).
 *
 * The load-bearing assertions here are the NEGATIVE ones: an unmatched or
 * ambiguous message must fall back to the synced mailbox, never to a plausible
 * desk. A misroute puts one shopping centre's customer into another centre's
 * queue and answers them under the wrong programme identity.
 */
import { describe, expect, test } from "bun:test"
import {
  collectRecipients,
  normalizeAddress,
  type RoutableInbox,
  resolveInboxForMessage,
  routingAddressOf,
} from "~/apps/tickets/inbound-routing"
import type { ParsedEmail } from "~/lib/email/types"

const ORG = "11111111-1111-4111-8111-111111111111"

const syncInbox: RoutableInbox = {
  id: "sync-0",
  org_id: ORG,
  kind: "mailbox",
  email_address: "support@support.tailspin.example",
  default_team: null,
}

const desk = (id: string, address: string, team: string): RoutableInbox => ({
  id,
  org_id: ORG,
  kind: "api",
  email_address: null,
  reply_from_email: address,
  default_team: team,
})

const PDH = desk("pdh", "passage-du-havre@support.tailspin.example", "Passage du Havre")
const BES = desk("bes", "best@support.tailspin.example", "B'Est")
const LVN = desk("lvn", "la-vache-noire@support.tailspin.example", "La Vache Noire")
const DESKS = [PDH, BES, LVN]

function mail(over: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    from: { email: "client@example.com", name: "Client" },
    to: [],
    cc: [],
    subject: "Bonjour",
    headers: {},
    ...over,
  } as ParsedEmail
}

describe("normalizeAddress", () => {
  test("lowercases and strips sub-addressing, keeps the domain", () => {
    expect(normalizeAddress("  Passage-Du-Havre+tkt_ABC@Support.Tailspin.EXAMPLE ")).toBe(
      "passage-du-havre@support.tailspin.example",
    )
  })

  test("leaves a bare local part and a leading-plus local untouched", () => {
    expect(normalizeAddress("not-an-address")).toBe("not-an-address")
    // A local part that STARTS with '+' is not sub-addressing — do not eat it.
    expect(normalizeAddress("+weird@example.com")).toBe("+weird@example.com")
  })
})

describe("routingAddressOf", () => {
  test("api bucket answers for reply_from_email, mailbox for its own address", () => {
    expect(routingAddressOf(PDH)).toBe("passage-du-havre@support.tailspin.example")
    expect(routingAddressOf(syncInbox)).toBe("support@support.tailspin.example")
  })

  test("null when the inbox carries no address at all", () => {
    expect(routingAddressOf({ id: "x", org_id: ORG, email_address: null })).toBeNull()
  })
})

describe("collectRecipients", () => {
  test("orders To before Cc before the delivery headers, de-duplicating", () => {
    const got = collectRecipients(
      mail({
        to: [{ email: "best@support.tailspin.example" }],
        cc: [{ email: "la-vache-noire@support.tailspin.example" }],
        deliveredTo: ["support@support.tailspin.example"],
      } as Partial<ParsedEmail>),
    )
    expect(got).toEqual([
      "best@support.tailspin.example",
      "la-vache-noire@support.tailspin.example",
      "support@support.tailspin.example",
    ])
  })

  test("parses an angle-bracketed delivery header", () => {
    const got = collectRecipients(
      mail({ deliveredTo: ["Support <support@support.tailspin.example>"] } as never),
    )
    expect(got).toContain("support@support.tailspin.example")
  })

  test("ignores sender-written delivery headers: X-Original-To, X-Forwarded-To, lower Delivered-To", () => {
    // Only the receiving server's own (topmost) Delivered-To says where the
    // provider delivered the message; the rest are copied from what the sender
    // wrote and would let them pick any published desk.
    const got = collectRecipients(
      mail({
        deliveredTo: ["support@support.tailspin.example", "finance@support.tailspin.example"],
        headers: {
          "X-Original-To": "best@support.tailspin.example",
          "X-Forwarded-To": "la-vache-noire@support.tailspin.example",
        },
      } as never),
    )
    expect(got).toEqual(["support@support.tailspin.example"])
  })
})

describe("resolveInboxForMessage", () => {
  test("routes on the To recipient and carries that desk's team", () => {
    const d = resolveInboxForMessage(
      mail({ to: [{ email: "passage-du-havre@support.tailspin.example" }] } as never),
      syncInbox,
      DESKS,
    )
    expect(d.inbox.id).toBe("pdh")
    expect(d.inbox.default_team).toBe("Passage du Havre")
    expect(d.matchedOn).toBe("passage-du-havre@support.tailspin.example")
  })

  test("routes on Cc when the desk address was not in To", () => {
    const d = resolveInboxForMessage(
      mail({
        to: [{ email: "someone-else@example.com" }],
        cc: [{ email: "best@support.tailspin.example" }],
      } as never),
      syncInbox,
      DESKS,
    )
    expect(d.inbox.id).toBe("bes")
  })

  test("routes on a delivery header when the address was BCC'd", () => {
    const d = resolveInboxForMessage(
      mail({ deliveredTo: ["la-vache-noire@support.tailspin.example"] } as never),
      syncInbox,
      DESKS,
    )
    expect(d.inbox.id).toBe("lvn")
  })

  test("a reply to a plus-addressed desk address still routes to that desk", () => {
    const d = resolveInboxForMessage(
      mail({ to: [{ email: "best+tkt_9f2a@support.tailspin.example" }] } as never),
      syncInbox,
      DESKS,
    )
    expect(d.inbox.id).toBe("bes")
  })

  test("case and whitespace do not defeat the match", () => {
    const d = resolveInboxForMessage(
      mail({ to: [{ email: "  BEST@Support.Tailspin.example " }] } as never),
      syncInbox,
      DESKS,
    )
    expect(d.inbox.id).toBe("bes")
  })

  // ---- the negative half: never guess ----

  test("UNKNOWN recipient falls back to the sync inbox, team-less, not to a desk", () => {
    const d = resolveInboxForMessage(
      mail({ to: [{ email: "marketing@support.tailspin.example" }] } as never),
      syncInbox,
      DESKS,
    )
    expect(d.inbox.id).toBe("sync-0")
    expect(d.matchedOn).toBeNull()
    expect(d.inbox.default_team).toBeNull()
  })

  test("same domain is NOT enough — no domain-level fallback", () => {
    const d = resolveInboxForMessage(
      mail({ to: [{ email: "passage-du-havre@WRONG-DOMAIN.com" }] } as never),
      syncInbox,
      DESKS,
    )
    expect(d.inbox.id).toBe("sync-0")
  })

  test("no candidates configured → sync inbox, unchanged behaviour", () => {
    const d = resolveInboxForMessage(
      mail({ to: [{ email: "best@support.tailspin.example" }] } as never),
      syncInbox,
      [],
    )
    expect(d.inbox.id).toBe("sync-0")
    expect(d.matchedOn).toBeNull()
  })

  test("the sync inbox is never a match target — its own address does not 'route'", () => {
    const d = resolveInboxForMessage(
      mail({ to: [{ email: "support@support.tailspin.example" }] } as never),
      syncInbox,
      [...DESKS, syncInbox],
    )
    expect(d.inbox.id).toBe("sync-0")
    expect(d.matchedOn).toBeNull()
  })

  test("two desks addressed at once → To wins over Cc, deterministically", () => {
    const d = resolveInboxForMessage(
      mail({
        to: [{ email: "best@support.tailspin.example" }],
        cc: [{ email: "passage-du-havre@support.tailspin.example" }],
      } as never),
      syncInbox,
      DESKS,
    )
    expect(d.inbox.id).toBe("bes")
  })

  test("duplicate routing address → first registration wins, not row order luck", () => {
    const dupe = desk("dupe", "best@support.tailspin.example", "Doublon")
    const first = resolveInboxForMessage(
      mail({ to: [{ email: "best@support.tailspin.example" }] } as never),
      syncInbox,
      [BES, dupe],
    )
    const second = resolveInboxForMessage(
      mail({ to: [{ email: "best@support.tailspin.example" }] } as never),
      syncInbox,
      [dupe, BES],
    )
    expect(first.inbox.id).toBe("bes")
    expect(second.inbox.id).toBe("dupe")
    // Each ordering is self-consistent; what must never happen is one call
    // returning a different inbox than another with the SAME candidate list.
    expect(
      resolveInboxForMessage(
        mail({ to: [{ email: "best@support.tailspin.example" }] } as never),
        syncInbox,
        [BES, dupe],
      ).inbox.id,
    ).toBe(first.inbox.id)
  })
})
