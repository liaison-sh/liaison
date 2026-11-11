// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `saas` world's plan: every company and every deal the pack writes, with
// its values and its dates, as a pure function of the anchor. No database, no
// wall clock: the layer writes exactly this, and a test holds the plan to the
// world's invariants at any anchor without seeding anything.
//
// Every date is a role on the story clock (`../story-clock.ts`): "won five
// days ago" is `d(-5)`, never a literal, and "this month" stays inside this
// month however early in the month the anchor falls.
import { type StoryClock, storyClock } from "~/seed/worlds/story-clock"
import { SAAS_ACCOUNT_MANAGERS, SAAS_CUSTOMER_COMPANIES, type SaasPlan } from "./fiction"

/** Why a company is in the workspace: what INV-T-11's breakdown counts it as. */
export type SaasCompanyKind =
  | "paying"
  | "trial"
  | "cancelled-this-month"
  | "cancelled-last-month"
  | "transfer"
  | "prospect"
  | "past"

export interface SaasCompanyRow {
  key: string
  name: string
  domain: string
  kind: SaasCompanyKind
  plan?: SaasPlan
  /** Person key of the account manager, when a board names one. */
  manager?: string
  /** Customer keys (`fiction.ts`) of the people who work there. */
  contactKeys: string[]
}

export type SaasDealStage = "Lead" | "Qualified" | "Demo" | "Proposal" | "Won" | "Lost"

export interface SaasDealRow {
  /** The deal's number in the pipeline (`SALES-<n>`). */
  number: number
  key: string
  title: string
  stage: SaasDealStage
  companyKey: string
  contactKey?: string
  /** A person key, or `owner` for the workspace's owner (the visitor). */
  owner: string
  amountMinor: number
  /** When the deal was opened. With no reply on record, the deal's quiet days run from here. */
  createdAt: Date
  /** When a won or lost deal closed. */
  closedAt?: Date
  nextStep?: string
  lostReason?: string
}

/** A task under a deal: what the owner has to do before the deal moves. */
export interface SaasDealSubtask {
  number: number
  key: string
  parentNumber: number
  title: string
  owner: string
  dueAt: Date
}

/** What the owner's Home leads with, in order: approvals and attention rows. */
export interface SaasNeedsYouRow {
  key: string
  kind: "approval" | "attention"
  what: string
}

export interface SaasPlanResult {
  anchor: Date
  companies: SaasCompanyRow[]
  deals: SaasDealRow[]
  subtasks: SaasDealSubtask[]
  needsYou: SaasNeedsYouRow[]
  /** The owner's sidebar queues: open items waiting in each. */
  queues: { support: number; deals: number; tasks: number; knowledge: number }
  /** The people the door names beside the visitor, and the visitor's own seat. */
  team: { named: number; ownerSeat: 1 }
}

/** The pipeline's key: deals read `SALES-<n>`. */
export const SAAS_PIPELINE_KEY = "SALES"

const slug = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

const domainOf = (name: string) => `${slug(name)}.example`

const contactsOf = (name: string): string[] =>
  Object.entries(SAAS_CUSTOMER_COMPANIES)
    .filter(([, company]) => company === name)
    .map(([key]) => `customer:${key}`)

const managerOf = (name: string): string | undefined =>
  Object.entries(SAAS_ACCOUNT_MANAGERS).find(([, names]) => names.includes(name))?.[0]

function row(
  name: string,
  kind: SaasCompanyKind,
  plan?: SaasPlan,
  domain?: string,
): SaasCompanyRow {
  const manager = managerOf(name)
  return {
    key: slug(name),
    name,
    domain: domain ?? domainOf(name),
    kind,
    ...(plan ? { plan } : {}),
    ...(manager ? { manager } : {}),
    contactKeys: contactsOf(name),
  }
}

/** The paying customers the boards name, with their plan. */
const NAMED_PAYING: ReadonlyArray<[string, SaasPlan]> = [
  ["Maison Arlon", "group"],
  ["Les Tables Vauban", "team"],
  ["Hôtel Quai Neuf", "team"],
  ["Bistrot Garance", "team"],
  ["Tables d'Orsan", "team"],
  ["Café Sillon", "starter"],
  ["Halle Perrine", "starter"],
  ["Ker Avel", "starter"],
  ["Relais Saint-Cyr", "team"],
  ["Résidence Calanque", "team"],
  ["Domaine Astier", "group"],
]

const TRIALS: ReadonlyArray<[string, SaasPlan]> = [
  ["Auberge Tilleul", "team"],
  ["Hôtel Bellerive", "team"],
  ["Groupe Lanterne", "group"],
  ["Bistrot Ardoise", "starter"],
]

const TRANSFER: ReadonlyArray<[string, SaasPlan]> = [
  ["Hôtels Belcour", "team"],
  ["Résidence Alizé", "team"],
  ["Le Comptoir Sud", "team"],
  ["Stadshotel Noord BV", "team"],
  ["Cantines du Port", "group"],
  ["Bistrot Marceau", "starter"],
  ["Hôtel Mirabel", "starter"],
  ["Domaine Ferrand", "team"],
  ["Camping Les Pins", "starter"],
  ["Groupe Verrières", "group"],
]

const PROSPECTS = [
  "Hôtels Sauvan",
  "Comptoir Sélène",
  "Hôtel Ondine",
  "Kora Hospitality",
  "KORA hospitality SAS",
  "Bistrot Carmin",
  "Pont Neuf Bistrots",
  "Brasserie Lumen",
  "Hôtel des Trois Ormes",
] as const

/** Kora's two records share the one domain: the duplicate a person merges. */
const KORA_DOMAIN = "kora-hospitality.example"

/** INV-T-11's counts: 169 paying, 4 trials, 4 cancelled this month, Café Ombre, 10 transfer, 9 prospects, 17 past. */
export const SAAS_COMPANY_COUNTS = {
  paying: 169,
  trial: 4,
  "cancelled-this-month": 4,
  "cancelled-last-month": 1,
  transfer: 10,
  prospect: 9,
  past: 17,
} as const satisfies Record<SaasCompanyKind, number>

/** The paying long tail's plan mix: 62 Starter, 83 Team, 24 Group in all (INV-T-1). */
const PLAN_MIX: Record<SaasPlan, number> = { starter: 62, team: 83, group: 24 }

const VENUE_KINDS = [
  "Hôtel",
  "Bistrot",
  "Brasserie",
  "Café",
  "Auberge",
  "Maison",
  "Résidence",
  "Cantine",
  "Relais",
  "Comptoir",
  "Table",
  "Halle",
]
const VENUE_NAMES = [
  "des Saules",
  "Belvédère",
  "du Phare",
  "des Glycines",
  "Corail",
  "des Tilleuls Bleus",
  "Marée Haute",
  "du Moulin Vert",
  "des Embruns",
  "Azurine",
  "du Vieux Quai",
  "des Lavandes",
  "Ardente",
  "du Grand Mail",
  "des Cèdres",
  "Opaline",
  "du Pont Levant",
  "des Mouettes",
  "Céladon",
  "du Clos Fleuri",
]

/** The n-th long tail name, never one a board names. */
function longTailNames(count: number, taken: ReadonlySet<string>, offset: number): string[] {
  const out: string[] = []
  let i = offset
  while (out.length < count) {
    const kind = VENUE_KINDS[i % VENUE_KINDS.length] as string
    const name = VENUE_NAMES[Math.floor(i / VENUE_KINDS.length) % VENUE_NAMES.length] as string
    const round = Math.floor(i / (VENUE_KINDS.length * VENUE_NAMES.length))
    const candidate = `${kind} ${name}${round > 0 ? ` ${round + 1}` : ""}`
    if (!taken.has(candidate)) out.push(candidate)
    i++
  }
  return out
}

function companies(): SaasCompanyRow[] {
  const out: SaasCompanyRow[] = []
  for (const [name, plan] of NAMED_PAYING) out.push(row(name, "paying", plan))
  const left = { ...PLAN_MIX }
  for (const [, plan] of NAMED_PAYING) left[plan]--
  const named = new Set([
    ...NAMED_PAYING.map(([n]) => n),
    ...TRIALS.map(([n]) => n),
    ...TRANSFER.map(([n]) => n),
    ...PROSPECTS,
    "Café Ombre",
  ])
  const tail = longTailNames(SAAS_COMPANY_COUNTS.paying - NAMED_PAYING.length + 4 + 17, named, 0)
  let t = 0
  for (const plan of ["starter", "team", "group"] as const) {
    for (let k = 0; k < left[plan]; k++) out.push(row(tail[t++] as string, "paying", plan))
  }
  for (const [name, plan] of TRIALS) out.push(row(name, "trial", plan))
  for (const plan of ["starter", "starter", "team", "team"] as const) {
    out.push(row(tail[t++] as string, "cancelled-this-month", plan))
  }
  out.push(row("Café Ombre", "cancelled-last-month", "starter"))
  for (const [name, plan] of TRANSFER) out.push(row(name, "transfer", plan))
  for (const name of PROSPECTS) {
    out.push(
      row(
        name,
        "prospect",
        undefined,
        name.toLowerCase().startsWith("kora") ? KORA_DOMAIN : undefined,
      ),
    )
  }
  for (let k = 0; k < SAAS_COMPANY_COUNTS.past; k++) out.push(row(tail[t++] as string, "past"))
  return out
}

/** An instant this month, `daysAgo` before the anchor, kept inside this month. */
function thisMonthDaysAgo(clock: StoryClock, daysAgo: number, i: number, of: number): Date {
  const at = clock.d(-daysAgo)
  return monthKeyOf(at) === clock.monthKey() ? at : clock.thisMonthEvent(i, of)
}

function monthKeyOf(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date)
  return `${parts.find((p) => p.type === "year")?.value}-${parts.find((p) => p.type === "month")?.value}`
}

const EUR = (euros: number) => euros * 100

function deals(clock: StoryClock, rows: readonly SaasCompanyRow[]): SaasDealRow[] {
  const keyOf = (name: string) => {
    const found = rows.find((r) => r.name === name)
    if (!found) throw new Error(`saas plan: no company '${name}'`)
    return found.key
  }
  const named: SaasDealRow[] = [
    {
      number: 3,
      key: "arlon-group",
      title: "Maison Arlon, Group plan",
      stage: "Won",
      companyKey: keyOf("Maison Arlon"),
      contactKey: "customer:claire-vidal",
      owner: "tom",
      amountMinor: EUR(17_400),
      createdAt: clock.d(-640),
      closedAt: clock.d(-610),
    },
    {
      number: 9,
      key: "trois-ormes",
      title: "Hôtel des Trois Ormes, Group plan",
      stage: "Lost",
      companyKey: keyOf("Hôtel des Trois Ormes"),
      contactKey: "customer:denis-ormes",
      owner: "tom",
      amountMinor: EUR(17_400),
      createdAt: clock.d(-60),
      closedAt: thisMonthDaysAgo(clock, 7, 0, 2),
      lostReason: "Waiting until next year",
    },
    {
      number: 11,
      key: "vauban-team",
      title: "Les Tables Vauban, Team annual",
      stage: "Won",
      companyKey: keyOf("Les Tables Vauban"),
      contactKey: "customer:paul-vauban",
      owner: "tom",
      amountMinor: EUR(5_880),
      createdAt: clock.d(-35),
      closedAt: thisMonthDaysAgo(clock, 5, 1, 2),
    },
    {
      number: 12,
      key: "lumen-team",
      title: "Lumen, Team annual",
      stage: "Proposal",
      companyKey: keyOf("Brasserie Lumen"),
      contactKey: "customer:noor-haddad",
      owner: "owner",
      amountMinor: EUR(5_880),
      createdAt: clock.d(-9),
      nextStep: "Follow up on the proposal",
    },
    {
      number: 14,
      key: "arlon-expansion",
      title: "Maison Arlon, 4 more hotels",
      stage: "Proposal",
      companyKey: keyOf("Maison Arlon"),
      contactKey: "customer:claire-vidal",
      owner: "tom",
      amountMinor: EUR(17_400),
      createdAt: clock.d(-3),
      nextStep: "Tom to confirm the rollout date",
    },
    {
      number: 15,
      key: "pont-neuf",
      title: "Pont Neuf Bistrots, Team annual",
      stage: "Demo",
      companyKey: keyOf("Pont Neuf Bistrots"),
      contactKey: "customer:julie-marchetti",
      owner: "tom",
      amountMinor: EUR(5_880),
      createdAt: clock.d(-6),
    },
    {
      number: 17,
      key: "sauvan-group",
      title: "Hôtels Sauvan, Group plan",
      stage: "Demo",
      companyKey: keyOf("Hôtels Sauvan"),
      contactKey: "customer:marc-sauvan",
      owner: "owner",
      amountMinor: EUR(17_400),
      createdAt: clock.d(-12),
      nextStep: "Send the group pricing for 11 sites",
    },
    {
      number: 18,
      key: "tilleul-team",
      title: "Auberge Tilleul, Team after the trial",
      stage: "Qualified",
      companyKey: keyOf("Auberge Tilleul"),
      contactKey: "customer:hugo-perrin",
      owner: "tom",
      amountMinor: EUR(5_880),
      createdAt: clock.d(-11),
    },
    {
      number: 21,
      key: "kora-team",
      title: "Kora Hospitality, Team annual",
      stage: "Lead",
      companyKey: keyOf("Kora Hospitality"),
      contactKey: "customer:samir-ait",
      owner: "tom",
      amountMinor: EUR(5_880),
      createdAt: clock.d(-10),
    },
    {
      number: 24,
      key: "selene-pilot",
      title: "Team pilot",
      stage: "Qualified",
      companyKey: keyOf("Comptoir Sélène"),
      contactKey: "customer:anais-selene",
      owner: "owner",
      amountMinor: EUR(3_920),
      createdAt: clock.d(-8),
    },
    {
      number: 26,
      key: "carmin",
      title: "Bistrot Carmin, Starter for two sites",
      stage: "Lead",
      companyKey: keyOf("Bistrot Carmin"),
      contactKey: "customer:lina-carmin",
      owner: "tom",
      amountMinor: EUR(3_000),
      createdAt: clock.d(-5),
    },
    {
      number: 28,
      key: "ondine",
      title: "Hôtel Ondine, Team for one hotel",
      stage: "Lead",
      companyKey: keyOf("Hôtel Ondine"),
      contactKey: "customer:victor-ondine",
      owner: "tom",
      amountMinor: EUR(3_420),
      createdAt: clock.d(-1),
    },
  ]
  // The numbers between are older deals, closed before this month: customers
  // won and prospects lost, so every number up to the last exists.
  const used = new Set(named.map((d) => d.number))
  const paying = rows.filter((r) => r.kind === "paying" && !r.manager && r.contactKeys.length === 0)
  const past = rows.filter((r) => r.kind === "past")
  const history: SaasDealRow[] = []
  let w = 0
  let l = 0
  for (let n = 1; n <= 29; n++) {
    if (used.has(n)) continue
    const won = n % 3 !== 0
    const company = won ? paying[w++] : past[l++]
    if (!company) throw new Error("saas plan: not enough companies for the deal history")
    const amountMinor = EUR(
      company.plan === "group" ? 17_400 : company.plan === "starter" ? 1_788 : 5_880,
    )
    history.push({
      number: n,
      key: `history-${n}`,
      title: `${company.name}, ${won ? "first plan" : "trial that did not convert"}`,
      stage: won ? "Won" : "Lost",
      companyKey: company.key,
      owner: n % 2 === 0 ? "tom" : "maxime",
      amountMinor: won ? amountMinor : EUR(5_880),
      // Older than any month the anchor can be in: 40 days and more back.
      createdAt: clock.d(-(420 - n * 12)),
      closedAt: clock.d(-(400 - n * 12)),
      ...(won ? {} : { lostReason: "Chose to stay on spreadsheets" }),
    })
  }
  return [...named, ...history].sort((a, b) => a.number - b.number)
}

function subtasks(clock: StoryClock): SaasDealSubtask[] {
  return [
    {
      number: 30,
      key: "arlon-rollout-plan",
      parentNumber: 14,
      title: "Draft the rollout plan for the 4 hotels",
      owner: "tom",
      dueAt: clock.d(4),
    },
    {
      number: 31,
      key: "arlon-pricing-sheet",
      parentNumber: 14,
      title: "Send the pricing sheet for the 4 hotels",
      owner: "tom",
      dueAt: clock.d(4),
    },
  ]
}

/** The `saas` world at `anchor`. Pure: two calls with one anchor are equal. */
export function saasPlan(anchor: Date): SaasPlanResult {
  const clock = storyClock(anchor)
  const rows = companies()
  return {
    anchor,
    companies: rows,
    deals: deals(clock, rows),
    subtasks: subtasks(clock),
    needsYou: [
      { key: "arlon-past-due", kind: "approval", what: "Card update reminder to Maison Arlon" },
      { key: "lumen-followup", kind: "approval", what: "Follow-up to Brasserie Lumen" },
      { key: "ombre-refund", kind: "approval", what: "Refund for Café Ombre" },
      { key: "pont-neuf-quiet", kind: "attention", what: "Pont Neuf Bistrots has gone quiet" },
    ],
    queues: { support: 6, deals: 3, tasks: 2, knowledge: 1 },
    team: { named: 13, ownerSeat: 1 },
  }
}
