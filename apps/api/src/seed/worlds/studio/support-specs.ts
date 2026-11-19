// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `studio` world's support desk: its inboxes and the ticket queue the
// owner opens on, three open tickets from the clients' people, each waiting
// on a reply, and the closed ones before them. Companies, deals, projects and
// mail are the pack's layer's (`layer.ts`, `agreements.ts`), so the support
// layer seeds none of them.
//
// Every age is an offset in hours from the anchor; no string names a date.
import type { EventSpec } from "~/seed/factories/calendar/events"
import type { TicketSpec } from "~/seed/factories/support/tickets"
import type { DemoSupportSpecs } from "~/seed/tiers/demo/seed-support"
import { STUDIO_CLIENTS } from "./fiction"
import { STUDIO_PIPELINE_KEY } from "./layer"

export const STUDIO_TICKET_CATEGORIES = [
  "Releases",
  "Access and sign-in",
  "Data and exports",
  "Billing",
] as const

export const STUDIO_TICKETS: readonly TicketSpec[] = [
  {
    key: "alpine-stock-export",
    number: 214,
    subject: "Stock export stopped after the last release",
    contactKey: "customer:ines-royer",
    category: "Data and exports",
    team: "support",
    audience: "b2b",
    priority: "high",
    status: "open",
    assignee: "noemie",
    channel: "email",
    createdHoursAgo: 7,
    body:
      "Hello, since the last release the nightly stock export to our suppliers is empty. Our " +
      "orders for the week depend on it. Can you look at it? Inès",
    followups: [
      {
        kind: "outbound",
        author: "noemie",
        hoursAfter: 1,
        body: "We are on it: the export job runs, but finds no stock lines since the release. We will tell you as soon as it is fixed.",
      },
      {
        kind: "inbound",
        hoursAfter: 3,
        body: "It is still empty. Can you give us a time? Our suppliers wait for the file.",
      },
    ],
  },
  {
    key: "sorel-reader-sign-in",
    number: 212,
    subject: "Readers cannot sign in with their library card",
    contactKey: "customer:thomas-blanc",
    category: "Access and sign-in",
    team: "support",
    audience: "b2b",
    priority: "normal",
    status: "open",
    assignee: "adil",
    channel: "email",
    createdHoursAgo: 22,
    body:
      "A few readers write to us that the library card sign-in on the reader site says their " +
      "card is unknown. It worked for them before. Thomas, Éditions Sorel",
    followups: [
      {
        kind: "outbound",
        author: "adil",
        hoursAfter: 1,
        body: "Thank you. Could you send us one of the card numbers that fails, so we can follow it through?",
      },
      {
        kind: "inbound",
        hoursAfter: 3,
        body: 'Here is one that fails: the reader says the site shows "card unknown" since the release.',
      },
    ],
  },
  {
    key: "marlin-invoice-address",
    number: 211,
    subject: "Invoice address for the portal project",
    contactKey: "customer:remi-castel",
    category: "Billing",
    team: "support",
    audience: "b2b",
    priority: "normal",
    status: "open",
    assignee: "noemie",
    channel: "email",
    createdHoursAgo: 30,
    body:
      "Hello, our accounts department moved. Could the next invoices for the partner portal go " +
      "to our new address? I can send it in the form you need. Rémi Castel, Groupe Marlin",
    followups: [
      {
        kind: "outbound",
        author: "noemie",
        hoursAfter: 1,
        body: "Of course. Please send us the new address with the name of the department, and we will pass it to our finance team.",
      },
      {
        kind: "inbound",
        hoursAfter: 3,
        body: "Here it is: Groupe Marlin, accounts payable, 8 rue des Mariniers, 69002 Lyon.",
      },
    ],
  },
  {
    key: "marlin-beta-access",
    number: 205,
    subject: "Beta access for two more partners",
    contactKey: "customer:pauline-gros",
    category: "Access and sign-in",
    team: "support",
    audience: "b2b",
    priority: "normal",
    status: "closed",
    closedReason: "resolved",
    assignee: "adil",
    channel: "email",
    createdHoursAgo: 190,
    body: "Can two more of our partners try the Beta of the portal?",
    followups: [
      {
        kind: "outbound",
        author: "adil",
        hoursAfter: 5,
        body: "Both partners have their Beta access; their invitations went out with the sign-in steps.",
      },
    ],
  },
  {
    key: "sorel-release-notes",
    number: 201,
    subject: "What changed in the reader site release",
    contactKey: "customer:thomas-blanc",
    category: "Releases",
    team: "support",
    audience: "b2b",
    priority: "low",
    status: "closed",
    closedReason: "resolved",
    assignee: "noemie",
    channel: "email",
    createdHoursAgo: 400,
    body: "Our editors ask what changed in the last release of the reader site.",
    followups: [
      {
        kind: "outbound",
        author: "noemie",
        hoursAfter: 6,
        body: "The release added the reading lists and fixed the search on author names.",
      },
    ],
  },
]

/**
 * The team calendar's standing meetings, weekly or monthly from three weeks before the board's
 * week, so any month the visitor opens holds the delivery cadence the brief describes. No
 * one-off date: a due date lives on its task, where it moves with the plan.
 */
export const STUDIO_EVENTS: EventSpec[] = [
  {
    key: "delivery-review",
    title: "Delivery review",
    description:
      "Every project in a quarter of an hour each: what moved, what is due, who has room.",
    location: "Lyon, meeting room",
    day: -21,
    startHour: 10,
    durationMinutes: 60,
    attendees: ["lea", "bastien", "nadia", "mathis", "sofia", "emma", "anais"],
    recurrence: ["RRULE:FREQ=WEEKLY;COUNT=12"],
  },
  {
    key: "portal-check-in",
    title: "Partner portal check-in",
    description: "The portal's week with Groupe Marlin: the Beta's open items and the launch plan.",
    day: -18,
    startHour: 14,
    durationMinutes: 45,
    attendees: ["bastien", "nadia", "mathis"],
    recurrence: ["RRULE:FREQ=WEEKLY;COUNT=10"],
  },
  {
    key: "retainer-review",
    title: "Publishing retainer review",
    description: "The month's hours on the Éditions Sorel retainer, before the invoice goes out.",
    day: -20,
    startHour: 11,
    durationMinutes: 30,
    attendees: ["bastien", "anais", "emma"],
    recurrence: ["RRULE:FREQ=MONTHLY;COUNT=6"],
  },
]

export const STUDIO_SUPPORT_SPECS: DemoSupportSpecs = {
  customerCompanies: Object.fromEntries(
    STUDIO_CLIENTS.flatMap((c) => c.contactKeys.map((k) => [k, c.name])),
  ),
  contactDuplicates: [],
  inboxes: { support: "Support", sales: "Sales", bugs: "Client issues" },
  ticketCategories: STUDIO_TICKET_CATEGORIES,
  tickets: STUDIO_TICKETS,
  ticketMerges: [],
  projects: [],
  calendarName: "Halden team",
  events: STUDIO_EVENTS,
  mail: [],
  mailTourConversation: null,
  companies: STUDIO_CLIENTS.map((c) => ({
    key: c.key,
    name: c.name,
    domain: c.domain,
    // The support layer keys its customers' contacts `customer:<key>`.
    contactKeys: c.contactKeys.map((k) => `customer:${k}`),
    // Its first contact is its main one, whom its invoices go to (a card's Create needs one).
    ...(c.contactKeys[0] ? { mainContactKey: `customer:${c.contactKeys[0]}` } : {}),
  })),
  // The pipeline's deals are the layer's (`layer.ts`).
  pipeline: {
    key: STUDIO_PIPELINE_KEY,
    name: "Sales pipeline",
    description: "New work from briefs to signed agreements.",
    deals: [],
  },
  approvals: [],
  productScenarios: false,
}
