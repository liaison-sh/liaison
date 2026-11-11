// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `saas` world's company: Tideform, a Paris software company that sells
// rota and shift planning to hospitality groups by subscription. Its team, the
// desks its agents speak for and the customer contacts its named rows name.
//
// The privacy rules of `seed/world/fiction.ts` hold here too: every address
// outside the org is on a reserved `.example` domain, every declared VAT number
// and the IBAN have an all-zero body, and nothing names a real company or
// person. Nothing in this file is a date: every instant the pack writes is a
// role on the story clock (`../story-clock.ts`), computed at seed time.
//
// The owner's seat is the visitor's (they are the CEO), so no person here is
// the CEO and no seeded row carries the owner's name. Yann, the CTO and
// co-founder, holds the founder's admin role: with no owner (an org nobody
// signs into) the org is created around his seat.
import type {
  DemoCompany,
  DemoCustomer,
  DemoPerson,
  DemoRole,
  DemoRoleAgent,
  DemoWorld,
} from "~/seed/world/fiction"

/** The reserved domain the team lives under, one label per org below it. */
export const SAAS_EMAIL_DOMAIN = "tideform.example"

export const SAAS_COMPANY: DemoCompany = {
  name: "Tideform",
  legalName: "Tideform SAS",
  vat: "FR00000000000",
  about:
    "Tideform makes rota and shift planning software for hospitality groups: hotels, restaurants " +
    "and canteens plan their teams, swap shifts and export hours to payroll. Sold by subscription " +
    "from Paris, by a team of 14.",
  addressLine1: "8 rue des Marées",
  postalCode: "75010",
  city: "Paris",
  country: "FR",
  iban: "FR0000000000000000000000000",
  swiftBic: "TDFMFRPPXXX",
  bankName: "Banque des Marées",
  supportEmail: `support@${SAAS_EMAIL_DOMAIN}`,
  billingEmail: `billing@${SAAS_EMAIL_DOMAIN}`,
  salesEmail: `sales@${SAAS_EMAIL_DOMAIN}`,
  websiteUrl: `https://www.${SAAS_EMAIL_DOMAIN}`,
  defaultCurrency: "EUR",
}

/** Plans per month, excluding VAT, in minor units. Yearly bills twelve months at once. */
export const SAAS_PLANS = {
  starter: { name: "Starter", monthlyMinor: 14_900 },
  team: { name: "Team", monthlyMinor: 49_000 },
  group: { name: "Group", monthlyMinor: 145_000 },
} as const

export type SaasPlan = keyof typeof SAAS_PLANS

const person = (
  key: string,
  name: string,
  jobTitle: string,
  role: DemoRole,
  bio: string,
): DemoPerson => ({ key, name, jobTitle, role, email: `${key}@${SAAS_EMAIL_DOMAIN}`, bio })

/**
 * The 13 people beside the owner. With the owner's seat that is the 14 the
 * door names. Order is the directory's.
 */
export const SAAS_TEAM: DemoPerson[] = [
  person(
    "tom",
    "Tom Reyes",
    "Sales",
    "sales",
    "Runs new business: demos, proposals and the pipeline. Most open deals are his.",
  ),
  person(
    "elodie",
    "Élodie Renard",
    "Account Manager",
    "sales",
    "Looks after the larger hotel groups once they sign: renewals, rollouts and the people who use the rota every week.",
  ),
  person(
    "ines",
    "Inès Caron",
    "Support Lead",
    "support",
    "Leads support: the ticket queue, the help centre and the hand over of bugs to the developers.",
  ),
  person(
    "yann",
    "Yann Le Goff",
    "CTO and co-founder",
    "founder_admin",
    "Co-founded the company and runs the product's engineering. Holds the keys to the workspace's settings.",
  ),
  person(
    "sara",
    "Sara Benali",
    "Finance",
    "finance",
    "Runs billing and the books: invoices, failed card payments, refunds and the month end.",
  ),
  person(
    "lucie",
    "Lucie Vasseur",
    "Product Manager",
    "ops_lead",
    "Owns the roadmap and the feedback that feeds it, and keeps support and engineering talking.",
  ),
  person(
    "baptiste",
    "Baptiste Noël",
    "Developer",
    "fulfillment",
    "Works on the planning engine and the payroll exports.",
  ),
  person(
    "amel",
    "Amel Saïdi",
    "Developer",
    "fulfillment",
    "Builds the mobile app staff use to see and swap their shifts.",
  ),
  person(
    "jonas",
    "Jonas Keller",
    "Developer",
    "fulfillment",
    "Looks after integrations and the reliability of the rota bugs room's fixes.",
  ),
  person(
    "clemence",
    "Clémence Roy",
    "Support",
    "support",
    "Answers tickets and runs onboarding calls for new venues.",
  ),
  person(
    "nolan",
    "Nolan Faure",
    "Support",
    "support",
    "Answers tickets and writes most of the help centre's how-to articles.",
  ),
  person(
    "maxime",
    "Maxime Aubert",
    "Sales",
    "sales",
    "Prospects independent restaurants and small hotel groups.",
  ),
  person(
    "rose",
    "Rose Delmas",
    "Office Manager",
    "finance",
    "Keeps the office, the suppliers and the team's admin running.",
  ),
]

/**
 * The people the named rows write to, each at their company. Keys are the
 * contact keys the support layer and the pack's layer share (`customer:<key>`).
 */
export const SAAS_CUSTOMERS: DemoCustomer[] = [
  {
    key: "claire-vidal",
    name: "Claire Vidal",
    email: "claire@maison-arlon.example",
    country: "FR",
    isVip: true,
  },
  {
    key: "noor-haddad",
    name: "Noor Haddad",
    email: "noor@brasserie-lumen.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "marc-sauvan",
    name: "Marc Sauvan",
    email: "marc@hotels-sauvan.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "hugo-perrin",
    name: "Hugo Perrin",
    email: "hugo@auberge-tilleul.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "samir-ait",
    name: "Samir Aït",
    email: "samir@kora-hospitality.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "julie-marchetti",
    name: "Julie Marchetti",
    email: "julie@pont-neuf-bistrots.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "paul-vauban",
    name: "Paul Garnier",
    email: "paul@tables-vauban.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "anais-selene",
    name: "Anaïs Morel",
    email: "anais@comptoir-selene.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "victor-ondine",
    name: "Victor Lambert",
    email: "victor@hotel-ondine.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "lina-carmin",
    name: "Lina Roussel",
    email: "lina@bistrot-carmin.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "denis-ormes",
    name: "Denis Fabre",
    email: "denis@trois-ormes.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "emma-ombre",
    name: "Emma Blanc",
    email: "emma@cafe-ombre.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "theo-saint-cyr",
    name: "Théo Mercier",
    email: "theo@relais-saint-cyr.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "louise-verrieres",
    name: "Louise Bertin",
    email: "louise@groupe-verrieres.example",
    country: "FR",
    isVip: false,
  },
]

/** The company each contact works for, by customer key. */
export const SAAS_CUSTOMER_COMPANIES: Readonly<Record<string, string>> = {
  "claire-vidal": "Maison Arlon",
  "noor-haddad": "Brasserie Lumen",
  "marc-sauvan": "Hôtels Sauvan",
  "hugo-perrin": "Auberge Tilleul",
  "samir-ait": "Kora Hospitality",
  "julie-marchetti": "Pont Neuf Bistrots",
  "paul-vauban": "Les Tables Vauban",
  "anais-selene": "Comptoir Sélène",
  "victor-ondine": "Hôtel Ondine",
  "lina-carmin": "Bistrot Carmin",
  "denis-ormes": "Hôtel des Trois Ormes",
  "emma-ombre": "Café Ombre",
  "theo-saint-cyr": "Relais Saint-Cyr",
  "louise-verrieres": "Groupe Verrières",
}

export const SAAS_WORLD: DemoWorld = {
  company: SAAS_COMPANY,
  catalog: [],
  team: SAAS_TEAM,
  dealers: [],
  customers: SAAS_CUSTOMERS,
}

/**
 * The ticket teams each desk works. Developers read the support queue, where
 * the bugs arrive; the product manager reads support and sales.
 */
export const SAAS_DESK_TEAMS: Record<Exclude<DemoRole, "founder_admin">, readonly string[]> = {
  ops_lead: ["support", "sales"],
  support: ["support"],
  fulfillment: ["support"],
  finance: ["finance"],
  sales: ["sales"],
}

/** Who looks after which named customer (account managers), by person key. */
export const SAAS_ACCOUNT_MANAGERS: Readonly<Record<string, readonly string[]>> = {
  elodie: ["Maison Arlon", "Hôtel Mirabel", "Cantines du Port", "Hôtels Belcour"],
  tom: [
    "Hôtel Ondine",
    "Auberge Tilleul",
    "Kora Hospitality",
    "Résidence Calanque",
    "Domaine Astier",
  ],
}

/**
 * Who is away, from the anchor to a day offset on the story clock. The owner
 * is next in line for Élodie, so her customers' cards stay with the visitor.
 */
export const SAAS_AWAY: ReadonlyArray<{
  key: string
  untilDay: number
  nextInLine: "owner" | null
}> = [
  { key: "maxime", untilDay: 11, nextInLine: null },
  { key: "elodie", untilDay: 41, nextInLine: "owner" },
]

const SUPPORT_PROMPT =
  "You are the support desk at Tideform, a Paris company that makes rota and shift planning software " +
  "for hospitality groups: hotels, restaurants and canteens. You answer tickets and mail from the managers " +
  "who plan the rotas and the staff who use the app, in French or English depending on who wrote in.\n\n" +
  "What you own: every reply, from first read to the moment a person has to sign off. Ground each answer in " +
  "the knowledge base first, and read the help centre article on the feature before you explain it.\n\n" +
  "A bug is not yours to fix: write down what the customer saw, the venue and the steps, and hand it over in " +
  "the Support handover channel. A billing, invoice or card payments question: ask the finance desk " +
  "(@finance) with kernel__agents_ask. A plan change or a group rollout: ask the sales desk (@sales). Asking " +
  "posts the question and its answer in this conversation without adding that desk to it.\n\n" +
  "Escalate to Inès Caron, the support lead, the same day for a group whose rota export or payroll export " +
  "is blocked, because their staff are paid from it.\n\n" +
  "You never promise a fix date, a refund or a discount without a person approving it first."

const SALES_PROMPT =
  "You are the sales desk at Tideform, a Paris company that makes rota and shift planning software for " +
  "hospitality groups. Plans are Starter, Team and Group, priced per venue group per month, and a yearly " +
  "plan bills twelve months at once.\n\n" +
  "What you own: the pipeline from first call to signed plan. Read the deal, the company and the last " +
  "conversation before you write anything, and quote real numbers from the plan prices, never an estimate.\n\n" +
  "A follow-up is drafted for a person to approve, never sent by you. Respect an opt-out and an auto-reply: " +
  "the send check holds or stops those drafts, and you do not write around it.\n\n" +
  "A billing question goes to the finance desk (@finance) with kernel__agents_ask; a product question you " +
  "cannot answer from the knowledge base goes to the support desk (@support).\n\n" +
  "Escalate to Tom Reyes the same day for a group asking for a price for more than ten sites."

const FINANCE_PROMPT =
  "You are the finance desk at Tideform, a Paris company that sells rota and shift planning software by " +
  "subscription. Liaison issues the invoices and card payments collect them.\n\n" +
  "What you own: invoices, credit notes, failed card payments and refunds, and the VAT treatment behind " +
  "each one. State the currency and the document number every time you mention money. Before you call a " +
  "customer late, check whether the payment failed on an expired card: that customer needs a card update " +
  "link, not a reminder.\n\n" +
  "When a customer disputes a charge, read the invoice and the payment first and never refund into an open " +
  "dispute: hand it to Sara Benali, who decides.\n\n" +
  "Issuing, crediting and refunding are a person's decision. Prepare the document, state what you applied " +
  "and why, and let Sara or a person she names approve it."

/** The org's shared desks: support, sales and finance. */
export const SAAS_ROLE_AGENTS: DemoRoleAgent[] = [
  {
    handle: "@support",
    displayName: "Support Desk",
    purpose: "Answers customer tickets and mail for Tideform.",
    systemPrompt: SUPPORT_PROMPT,
    scopeRole: "support",
    toolAllowlist: [
      "tickets:search",
      "tickets:get",
      "tickets:reply",
      "tickets:addNote",
      "tickets:setStatus",
      "tickets:assign",
      "tickets:close",
      "mail:search",
      "mail:read",
      "mail:reply",
      "knowledge:search",
      "knowledge:get",
    ],
    modelPreference: "claude-sonnet-4-6",
  },
  {
    handle: "@sales",
    displayName: "Sales Desk",
    purpose: "Keeps the pipeline moving and drafts the follow-ups for the deal owners.",
    systemPrompt: SALES_PROMPT,
    scopeRole: "sales",
    toolAllowlist: [
      "projects:deals_search",
      "projects:deals_update",
      "projects:deals_rollup",
      "projects:deals_followup_candidates",
      "mail:search",
      "mail:read",
      "mail:compose",
      "knowledge:search",
      "knowledge:get",
    ],
    modelPreference: "claude-sonnet-4-6",
  },
  {
    handle: "@finance",
    displayName: "Finance Desk",
    purpose: "Handles invoices, failed card payments and refunds.",
    systemPrompt: FINANCE_PROMPT,
    scopeRole: "finance",
    toolAllowlist: [
      "invoicing:documents_search",
      "invoicing:documents_get",
      "invoicing:credit_note_create_and_issue",
      "invoicing:documents_mark_paid",
      "stripe:customers_search",
      "stripe:customers_get",
      "stripe:subscriptions_search",
      "stripe:invoices_search",
      "stripe:payments_search",
      "stripe:mrr_query",
      "stripe:card_update_link",
      "stripe:refunds_create",
      "tickets:search",
      "tickets:get",
    ],
    modelPreference: "claude-opus-4-6",
  },
]
