// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `saas` world's support desk: its inboxes, the ticket queue the owner
// opens on (six open tickets, S438), the shared mailbox's conversations with
// the prospects who wrote in, and the team calendar. Companies and deals are
// the pack's layer's (`plan.ts`, `layer.ts`), so the support layer seeds none.
//
// Every age is an offset in hours from the anchor; no string names a date.

import type { MailConversationSpec } from "~/seed/factories/mail/conversations"
import type { TicketSpec } from "~/seed/factories/support/tickets"
import type { DemoSupportSpecs } from "~/seed/tiers/demo/seed-support"
import { SAAS_CUSTOMER_COMPANIES, SAAS_EMAIL_DOMAIN } from "./fiction"
import { SAAS_PIPELINE_KEY } from "./plan"

export const SAAS_TICKET_CATEGORIES = [
  "Exports and payroll",
  "Billing",
  "Onboarding",
  "Mobile app",
  "Account",
] as const

/** The tickets the boards name, by spec key. */
export const SAAS_TICKET_KEYS = {
  arlonExport: "tick-412",
  arlonOlder: "tick-377",
  ombreCharge: "tick-398",
} as const

export const SAAS_TICKETS: readonly TicketSpec[] = [
  {
    key: SAAS_TICKET_KEYS.arlonExport,
    subject: "Export of last month's rotas",
    contactKey: "customer:claire-vidal",
    category: "Exports and payroll",
    team: "support",
    audience: "b2b",
    priority: "high",
    status: "open",
    assignee: "ines",
    channel: "email",
    createdHoursAgo: 30,
    body:
      "Hello, the payroll export for last month's rotas stops at the fourth hotel. Our payroll " +
      "provider needs the file before the end of the week. Can you look at it? Claire",
  },
  {
    key: SAAS_TICKET_KEYS.arlonOlder,
    subject: "Shift swap notifications arrive late",
    contactKey: "customer:claire-vidal",
    category: "Mobile app",
    team: "support",
    audience: "b2b",
    priority: "normal",
    status: "closed",
    closedReason: "resolved",
    assignee: "ines",
    channel: "email",
    createdHoursAgo: 900,
    body: "Staff at two of our hotels get the swap notification an hour after it was approved.",
    followups: [
      {
        kind: "outbound",
        author: "ines",
        hoursAfter: 20,
        body: "Fixed in the last app release: notifications now go out as soon as a swap is approved.",
      },
    ],
  },
  {
    key: SAAS_TICKET_KEYS.ombreCharge,
    subject: "Charged after cancelling",
    contactKey: "customer:emma-ombre",
    category: "Billing",
    team: "support",
    audience: "b2b",
    priority: "high",
    status: "open",
    assignee: "ines",
    channel: "email",
    createdHoursAgo: 20,
    body:
      "We cancelled our Starter plan and were charged again two days later, EUR 178.80. " +
      "Please refund it. Emma, Café Ombre",
  },
  {
    key: "vauban-onboarding",
    subject: "Adding our second restaurant",
    contactKey: "customer:paul-vauban",
    category: "Onboarding",
    team: "support",
    audience: "b2b",
    priority: "normal",
    status: "open",
    assignee: "clemence",
    channel: "email",
    createdHoursAgo: 6,
    body:
      "We just signed for Team. How do we add our second restaurant and copy the rota template " +
      "from the first one? Paul",
  },
  {
    key: "vauban-mobile-login",
    subject: "Staff cannot sign in to the app",
    contactKey: "customer:paul-vauban",
    category: "Mobile app",
    team: "support",
    audience: "b2b",
    priority: "normal",
    status: "open",
    assignee: "nolan",
    channel: "web_form",
    createdHoursAgo: 4,
    body: "Three of our waiters get 'invitation expired' when they open the link we sent them.",
  },
  {
    key: "verrieres-sso",
    subject: "Single sign-on for the group",
    contactKey: "customer:louise-verrieres",
    category: "Account",
    team: "support",
    audience: "b2b",
    priority: "low",
    status: "open",
    assignee: "nolan",
    channel: "email",
    createdHoursAgo: 52,
    body: "Can our managers sign in with the group's own accounts instead of a password?",
  },
  {
    key: "saint-cyr-invoice-copy",
    subject: "Copy of an invoice",
    contactKey: "customer:theo-saint-cyr",
    category: "Billing",
    team: "support",
    audience: "b2b",
    priority: "normal",
    status: "open",
    channel: "email",
    createdHoursAgo: 75,
    body: "Our accountant asks for a copy of the invoice for the Team plan. Théo",
  },
  {
    key: "selene-trial-question",
    subject: "How long is the trial?",
    contactKey: "customer:anais-selene",
    category: "Onboarding",
    team: "support",
    audience: "b2b",
    priority: "low",
    status: "closed",
    closedReason: "resolved",
    assignee: "clemence",
    channel: "web_form",
    createdHoursAgo: 200,
    body: "Before we sign up: how long is the trial, and can we try the Team plan?",
  },
]

const SALES_BOX = `sales@${SAAS_EMAIL_DOMAIN}`

/**
 * The prospects' last words, in the shared mailbox: Marc's question two hours
 * before the anchor (the guard closes the follow-up queued before it), Anaïs's
 * reply the day before, and the auto-reply that holds Samir's follow-up.
 */
export const SAAS_MAIL: readonly MailConversationSpec[] = [
  {
    key: "sauvan-pricing",
    box: "org",
    subject: "Group pricing",
    status: "open",
    labels: ["sales"],
    isRead: false,
    isStarred: true,
    messages: [
      {
        direction: "outbound",
        fromName: "Tideform",
        fromEmail: SALES_BOX,
        toName: "Marc Sauvan",
        toEmail: "marc@hotels-sauvan.example",
        hoursAgo: 260,
        body: "Thank you for the demo. Here is the summary of what we showed your managers.",
      },
      {
        direction: "inbound",
        fromName: "Marc Sauvan",
        fromEmail: "marc@hotels-sauvan.example",
        toName: "Tideform",
        toEmail: SALES_BOX,
        hoursAgo: 2,
        body: "Can you send the group pricing for 11 sites?",
      },
    ],
  },
  {
    key: "selene-pilot",
    box: "org",
    subject: "Team pilot",
    status: "open",
    labels: ["sales"],
    isRead: true,
    isStarred: false,
    messages: [
      {
        direction: "outbound",
        fromName: "Tideform",
        fromEmail: SALES_BOX,
        toName: "Anaïs Morel",
        toEmail: "anais@comptoir-selene.example",
        hoursAgo: 70,
        body: "Here is what a Team pilot for your two counters would look like, for eight months.",
      },
      {
        direction: "inbound",
        fromName: "Anaïs Morel",
        fromEmail: "anais@comptoir-selene.example",
        toName: "Tideform",
        toEmail: SALES_BOX,
        hoursAgo: 22,
        body: "That works for us. Can we start with the counter on the quay?",
      },
    ],
  },
  {
    key: "kora-intro",
    box: "org",
    subject: "Rota planning for Kora",
    status: "open",
    labels: ["sales"],
    isRead: true,
    isStarred: false,
    messages: [
      {
        direction: "outbound",
        fromName: "Tideform",
        fromEmail: SALES_BOX,
        toName: "Samir Aït",
        toEmail: "samir@kora-hospitality.example",
        hoursAgo: 240,
        body: "Following our call, here is how teams plan a week of shifts in Tideform.",
      },
    ],
  },
]

export const SAAS_SUPPORT_SPECS: DemoSupportSpecs = {
  customerCompanies: SAAS_CUSTOMER_COMPANIES,
  contactDuplicates: [],
  inboxes: { support: "Support", sales: "Sales", bugs: "Rota bugs" },
  ticketCategories: SAAS_TICKET_CATEGORIES,
  tickets: SAAS_TICKETS,
  ticketMerges: [],
  projects: [
    {
      key: "ROTA",
      name: "Product",
      description: "The rota product's roadmap: what is being built and what is next.",
      icon: "calendar",
      owner: "lucie",
      tasks: [
        {
          key: "payroll-export-fix",
          title: "Payroll export stops after four venues",
          status: "in_progress",
          assignee: "baptiste",
          priority: "high",
          dueInDays: 2,
        },
        {
          key: "group-sso",
          title: "Single sign-on for groups",
          status: "todo",
          assignee: "jonas",
          dueInDays: 20,
        },
        {
          key: "swap-reminders",
          title: "Remind managers of swaps waiting for approval",
          status: "backlog",
          assignee: "amel",
        },
        {
          key: "pricing-page-groups",
          title: "Review the group pricing page",
          status: "todo",
          assignee: "lucie",
          dueInDays: 5,
        },
      ],
    },
  ],
  calendarName: "Tideform team",
  events: [
    {
      key: "weekly-product",
      title: "Product review",
      day: 1,
      startHour: 10,
      durationMinutes: 45,
      attendees: ["lucie", "yann", "ines", "baptiste", "amel", "jonas"],
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
    },
    {
      key: "pipeline-review",
      title: "Pipeline review",
      day: 0,
      startHour: 9,
      startMinute: 30,
      durationMinutes: 30,
      attendees: ["tom", "elodie", "maxime"],
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    },
  ],
  mail: SAAS_MAIL,
  mailTourConversation: null,
  companies: [],
  // The pipeline itself is the pack's layer's (`layer.ts`), with every deal.
  pipeline: {
    key: SAAS_PIPELINE_KEY,
    name: "Sales",
    description: "New plans and group expansions, from first call to signed plan.",
    deals: [],
  },
  approvals: [],
  productScenarios: false,
}
