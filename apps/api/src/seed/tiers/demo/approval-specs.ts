// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * WHAT: The demo seed's approval requests: who asked, who decides, and the
 * payload each one carries. Pure data plus a resolver interface, so the seed
 * (`seed-support.ts`) writes them and a test validates every payload against
 * the REAL parameter schema of the tool it targets
 * (`apps/api/src/modules/demo/demo-approval-payloads.test.ts`) without a
 * database.
 *
 * WHY THE PAYLOAD IS A FUNCTION. An approval's payload is the tool call the
 * approver runs when they press Approve, so it must be exactly that tool's
 * parameters, with real row ids where the tool takes ids (the ticket replied
 * to, the mailbox sent from, the contacts merged, the invoice refunded). The
 * seed used to write descriptive look-alikes (`body`, `to` as a string,
 * `ticketSubject`, a discount's `percentage`), which the tool refused as
 * unrecognised parameters: Approve failed with `handler_ambiguous` and the edit
 * form opened empty. Each payload is built here from a resolver the seed backs
 * with the ids it actually wrote.
 */
import { DEMO_QUOTE_DEALER } from "~/seed/world/fiction"
import type { ResolvableApproval } from "./approval-payload"

/** The row ids and times a payload may name, resolved by the seed at write time. */
export interface ApprovalRefs {
  /** A seeded ticket's id, by ticket spec key. */
  ticket(key: string): string
  /** A skill's id, by name (the skills layer may run later; the seed falls back to a stable id). */
  skill(name: string): string
  /** A seeded mailbox's id: "org" for the shared one, else the person key. */
  mailAccount(box: string): string
  /** A seeded mail conversation's id, by conversation spec key. */
  mailConversation(key: string): string
  /** A seeded contact's id, by email. */
  contact(email: string): string
  /** A row the commerce layer writes, by its kind and key (stable ids). */
  commerce(kind: string, key: string): string
  /** A stable id for a row the seed never writes: a request that was denied and never ran. */
  placeholder(kind: string, key: string): string
  /** ISO 8601 time `hours` after the seed's clock (negative is the past). */
  at(hours: number): string
}

export interface ApprovalSpec extends Omit<ResolvableApproval, "payload"> {
  /** Thread key the request hangs off. */
  thread: string
  requestedBy: string
  notify: string[]
  status: "pending" | "approved" | "denied"
  decidedBy?: string
  hoursAgo: number
  reason?: string
  /** The tool's parameters, exactly as its schema declares them. */
  payload: (ref: ApprovalRefs) => Record<string, unknown>
}

export const APPROVAL_SPECS: ApprovalSpec[] = [
  {
    key: "reply-kestrel-10-replacement",
    toolName: "tickets:reply",
    thread: "support-agent-triage",
    ticketKey: "kestrel-10-wont-power",
    requestedBy: "amina",
    // The support queue's ticket: finance and fulfillment cannot open it.
    notify: ["amina"],
    status: "pending",
    hoursAgo: 2,
    // No sign-off: the team's reply signature is appended to the draft.
    payload: (ref) => ({
      ticketId: ref.ticket("kestrel-10-wont-power"),
      textBody:
        "Hello Tomoko,\n\nThank you for the detail, and sorry for the poor first impression. You have " +
        "already ruled out both cables and the power supply, which is everything I would have asked you " +
        "to try, so I am treating this as a hardware fault rather than putting you through more " +
        "questions.\n\n" +
        "A replacement Kestrel 10 goes out today and a prepaid return label for the faulty one is on its way to " +
        "you separately. You do not need to send anything back before the new one arrives.",
    }),
  },
  {
    key: "refund-lena",
    toolName: "invoicing:documents_record_refund",
    thread: "kb-gaps",
    requestedBy: "henrik",
    notify: ["henrik", "elodie"],
    status: "pending",
    hoursAgo: 6,
    // The Field Preamp on Lena's invoice, refunded at its list price.
    payload: (ref) => ({
      document_id: ref.commerce("document", "inv-cust-lena"),
      refund_amount_minor: 39900,
      refund_kind: "partial",
    }),
  },
  {
    key: "dealer-quote-conservatoire",
    toolName: "invoicing:quote_create_and_issue",
    thread: "launch-readiness",
    requestedBy: "giulia",
    notify: ["giulia", "elodie"],
    status: "pending",
    hoursAgo: 14,
    payload: (ref) => ({
      issuer_profile_id: ref.commerce("issuer_profile", "primary"),
      currency: "EUR",
      // Linked to the school's demo store customer (DEMO_QUOTE_DEALER): its
      // record carries the buyer email Invoicing needs to invoice the order.
      // The draft's own email is on a reserved domain, which Shopify drops.
      counterparty: {
        contact_id: ref.contact(DEMO_QUOTE_DEALER.email),
        legal_name: DEMO_QUOTE_DEALER.name,
        country: DEMO_QUOTE_DEALER.country,
        address: DEMO_QUOTE_DEALER.address,
        email: DEMO_QUOTE_DEALER.email,
      },
      items: [
        { description: "Kestrel Pocket Recorder", quantity: 10, unit_price_minor: 54900 },
        { description: "Kestrel Tripod Mount", quantity: 10, unit_price_minor: 8900 },
        { description: "Extended Care Plan", quantity: 10, unit_price_minor: 7900 },
      ],
      notes: "Education tier pricing. Quote valid for 60 days.",
    }),
  },
  {
    key: "press-loan-approved",
    toolName: "mail:reply",
    thread: "launch-readiness",
    requestedBy: "giulia",
    notify: ["elodie"],
    status: "approved",
    decidedBy: "elodie",
    hoursAgo: 40,
    payload: (ref) => ({
      conversationId: ref.mailConversation("org-press-enquiry"),
      to: ["editor@soundonstage.example"],
      textBody:
        "Hello,\n\nHappy to help. A Kestrel 10 will go out to you this week on a four week loan, and we will " +
        "cover shipping both ways.\n\nBest,\nGiulia",
    }),
  },
  {
    key: "third-preamp-denied",
    toolName: "boxtal:create_shipment",
    thread: "hiss-pattern",
    requestedBy: "amina",
    notify: ["tobias"],
    status: "denied",
    decidedBy: "tobias",
    hoursAgo: 22,
    reason:
      "Not a third replacement. Run the different room, different circuit test first and send the " +
      "isolating transformer if it confirms the studio.",
    // Denied, so it never ran. A Boxtal draft is keyed by the invoicing
    // document it ships (shipment_draft_get reads it from that document), so
    // the draft is Jasper's own invoice: a placeholder id made every seed's
    // card summary read a draft that cannot exist (No invoicing document found).
    payload: (ref) => ({
      draft_id: ref.commerce("document", "inv-cust-jasper"),
      offer_code: "DHLE-Europlus",
      quoted_price_ttc: 14.7,
      quoted_currency: "EUR",
      recipient_address: { name: "Jasper Nilsson" },
      created_by: "agent",
    }),
  },
  {
    key: "bulk-close-stale",
    toolName: "tickets:bulkClose",
    thread: "kb-gaps",
    requestedBy: "lucas",
    notify: ["amina"],
    status: "approved",
    decidedBy: "amina",
    hoursAgo: 60,
    payload: (ref) => ({
      ids: [ref.ticket("no-response-fault"), ref.ticket("dealer-repair-chase")],
      idempotencyKey: ref.placeholder("bulk-close", "bulk-close-stale"),
      closedReason: "no_response",
    }),
  },

  // ── Four more waiting on a decision ─────────────────────────────────────
  //
  // Four shapes the three above do not have: a playbook rewrite carrying a
  // whole document, a merge that destroys a row, a discount with a money
  // number on it, and a mail to somebody outside the company.
  {
    key: "skill-shipment-exception-customs",
    toolName: "kernel:update_skill",
    thread: "shipping-exceptions",
    requestedBy: "margot",
    notify: ["tobias", "margot"],
    status: "pending",
    hoursAgo: 4,
    skillName: "shipment-exception",
    payload: (ref) => ({
      id: ref.skill("shipment-exception"),
      description:
        "A parcel late, stuck, refused, damaged or lost, and what to check before it leaves.",
      requiredScopes: [
        "boxtal:shipments:read",
        "boxtal:shipments:write",
        "shopify:fulfillments:read",
      ],
      body:
        "# A shipment that is not moving\n\n" +
        "The Shipping timelines article carries what we promise. This is what the operations " +
        "desk does when a parcel misses it. Read the tracking before you read the order: a " +
        "parcel with no scan for three working days is an exception whatever the promised date " +
        "said, and the last scan is the only fact in the conversation.\n\n" +
        "## Before anything leaves for a territory with a customs pack\n" +
        "THIS IS THE NEW SECTION, and it is first because it prevents the exception rather than " +
        "handling it. Five of our last eight exceptions were the same lane and the same missing " +
        "document. A shipment to a territory that has a standing customs pack does not leave " +
        "without it, and the pack is a condition of dispatch rather than a piece of paperwork " +
        "that catches up later.\n\n" +
        "If the pack is not ready, hold the parcel and say so the same day. A short delay we " +
        "chose is a sentence to the customer. A week in a customs shed is a refund, a reship and " +
        "a dealer who tells the story to other dealers.\n\n" +
        "## The five shapes\n" +
        "NO SCAN SINCE HANDOVER. The carrier may never have collected it. Check the pickup, then " +
        "open a claim rather than waiting another day.\n\n" +
        "HELD IN CUSTOMS. Almost always a missing or wrong commodity code, or a recipient who " +
        "has not answered the broker. Send the customer the invoice and the code, and tell them " +
        "who to call. Duty is theirs, and saying that early is kinder than saying it late.\n\n" +
        "REFUSED OR UNDELIVERABLE. The parcel is coming back. Tell the customer before the " +
        "carrier does, and ask whether they want it resent or refunded.\n\n" +
        "DAMAGED. Photograph what arrives back, open the carrier claim the same day, and ship " +
        "the replacement without waiting for the claim to be decided.\n\n" +
        "LOST. After the carrier search window closes, treat it as lost, ship a replacement and " +
        "pursue the claim ourselves. The customer never chases a carrier on our behalf.\n\n" +
        "## Tell the customer before they ask\n" +
        "An exception we found and reported reads as care. The same exception found by the " +
        "customer reads as neglect. One short message, carrying the fact and what we are doing " +
        "about it, beats three careful paragraphs sent two days later.\n\n" +
        "## Keep the order in step\n" +
        "Whatever we do, the order in the shop has to say it: a replacement is a new fulfillment " +
        "with its own tracking, not a note on the old one. An order that says delivered when it " +
        "is not is how the same problem gets found twice, once by us and once by finance at the " +
        "end of the month.\n\n" +
        "## When the same lane fails twice\n" +
        "Two exceptions in one lane is a coincidence and three is a process fault. Raise it on " +
        "the operations board with the tracking numbers attached, rather than handling the third " +
        "one well. The desk is measured on parcels that arrive, not on exceptions handled " +
        "gracefully.\n\n" +
        "## What needs a person\n" +
        "Buying a replacement label, refunding, any goodwill gesture, and holding a dispatch for " +
        "a missing customs pack when the customer has already been given a date.",
    }),
  },
  {
    // The duplicate pair the contacts layer seeds on purpose (a work address
    // and a second one under an abbreviated name): the survivor keeps the
    // fuller record and the work address.
    key: "merge-lena-contacts",
    toolName: "kernel:contacts_merge",
    thread: "desk-shift-handover",
    requestedBy: "lucas",
    notify: ["amina"],
    status: "pending",
    hoursAgo: 7,
    payload: (ref) => ({
      targetId: ref.contact("helena.ritter@nordlicht.example"),
      sourceId: ref.contact("h.ritter@nordlicht.example"),
      resolvedFields: { name: "Helena Ritter", email: "helena.ritter@nordlicht.example" },
    }),
  },
  {
    key: "education-discount-code",
    toolName: "shopify:discounts_create",
    thread: "product-feedback-open",
    requestedBy: "giulia",
    notify: ["elodie", "giulia"],
    status: "pending",
    hoursAgo: 11,
    // 15% off, capped at forty uses so it cannot become a general sale by accident.
    payload: (ref) => ({
      basicCodeDiscount: {
        title: "Autumn teaching rooms",
        code: "TEACHING26",
        startsAt: ref.at(3 * 24),
        endsAt: ref.at(120 * 24),
        customerSelection: { all: true },
        customerGets: { value: { percentage: 0.15 }, items: { all: true } },
        appliesOncePerCustomer: true,
        usageLimit: 40,
      },
    }),
  },
  {
    key: "mail-runtime-answer",
    toolName: "mail:compose",
    thread: "product-feedback-open",
    requestedBy: "lucas",
    notify: ["amina", "elodie"],
    status: "pending",
    hoursAgo: 16,
    payload: (ref) => ({
      accountId: ref.mailAccount("org"),
      to: ["editor@soundonstage.example"],
      subject: "The battery runtime figure you asked for, measured properly",
      textBody:
        "Hello,\n\n" +
        "You asked what our real battery runtime is with phantom power on every input, and rather " +
        "than give you a number from memory we ran it down on the bench with condensers on all six.\n\n" +
        "On a fresh set of cells that is 5 hours 40 minutes on the Kestrel 6, and 3 hours 50 on the " +
        "Kestrel 10 with all ten inputs powered. Cold weather takes a chunk out of both, which we say " +
        "on the page rather than quietly leaving out.\n\n" +
        "We are putting the method and the figures on the site this week, so you can link to them " +
        "rather than quote us.\n\n" +
        "Best,\nLucas",
    }),
  },
]
