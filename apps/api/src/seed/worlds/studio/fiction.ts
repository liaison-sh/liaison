// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `studio` world's company: Halden Studio, a Lyon software services firm
// of 24 people that builds and runs systems for its clients, billed by the
// day, by the hour on a retainer, or at a fixed price per project. Its team,
// its clients and the contacts its named rows name.
//
// The privacy rules of `seed/world/fiction.ts` hold here too: every address
// outside the org is on a reserved `.example` domain, the declared VAT number
// and the IBAN have an all-zero body, and nothing names a real company or
// person. Nothing in this file is a date: every instant the pack writes is a
// role on the story clock (`../story-clock.ts`), computed by `plan.ts`.
//
// The owner's seat is the visitor's (a co-founder), so no person here holds
// the owner's name. Léa Fontaine, the other co-founder, holds the founder's
// admin role.
import type {
  DemoCompany,
  DemoCustomer,
  DemoPerson,
  DemoRole,
  DemoWorld,
} from "../../world/fiction"

/** The reserved domain the team lives under, one label per org below it. */
export const STUDIO_EMAIL_DOMAIN = "haldenstudio.example"

export const STUDIO_COMPANY: DemoCompany = {
  name: "Halden Studio",
  legalName: "Halden Studio SAS",
  // A valid key on an all-zero SIREN, so the number reads as a VAT number and names no one.
  vat: "FR00000000000",
  about:
    "Halden Studio builds and runs software for its clients: partner portals, data pipelines, " +
    "dashboards and the upkeep that follows. Billed by the day, on a monthly retainer or at a " +
    "fixed price per project, from Lyon, by a team of 24.",
  addressLine1: "14 quai des Tanneurs",
  postalCode: "69002",
  city: "Lyon",
  country: "FR",
  iban: "FR0000000000000000000000000",
  swiftBic: "HLDNFRPPXXX",
  bankName: "Banque des Tanneurs",
  supportEmail: `support@${STUDIO_EMAIL_DOMAIN}`,
  billingEmail: `billing@${STUDIO_EMAIL_DOMAIN}`,
  salesEmail: `sales@${STUDIO_EMAIL_DOMAIN}`,
  websiteUrl: `https://www.${STUDIO_EMAIL_DOMAIN}`,
  defaultCurrency: "EUR",
}

/** Hours in the studio's working day, in minutes. */
export const STUDIO_HOURS_PER_DAY_MINUTES = 7 * 60

const person = (
  key: string,
  name: string,
  jobTitle: string,
  role: DemoRole,
  bio: string,
): DemoPerson => ({ key, name, jobTitle, role, email: `${key}@${STUDIO_EMAIL_DOMAIN}`, bio })

/**
 * The ten people of delivery who carry planned work, by person key. They are
 * the people capacity lists, and the only ones with a cost rate.
 */
export const STUDIO_DELIVERY_KEYS = [
  "bastien",
  "clara",
  "emma",
  "hugo",
  "lina",
  "mathis",
  "nadia",
  "paul",
  "sofia",
  "yanis",
] as const

export type StudioDeliveryKey = (typeof STUDIO_DELIVERY_KEYS)[number]

/**
 * The 23 people beside the owner. With the owner's seat that is the 24 the
 * door names: the owner, Léa, the ten of delivery and finance are the 13 a
 * board names; the other 11 hold no planned work this period. Order is the
 * directory's.
 *
 * Developers, designers and the data engineer hold the `engineering` role:
 * projects, tasks, tickets and the knowledge base, and no invoicing write. An
 * invoice's issue approval goes to whoever holds its scope, so it reaches
 * finance, sales, the project lead and the admins, never the people who
 * deliver the work.
 */
export const STUDIO_TEAM: DemoPerson[] = [
  person(
    "lea",
    "Léa Fontaine",
    "Co-founder",
    "founder_admin",
    "Co-founded the studio and signs the agreements. Holds the keys to the workspace's settings.",
  ),
  person(
    "bastien",
    "Bastien Morel",
    "Project Lead",
    "ops_lead",
    "Leads delivery: plans the work, watches who has room next week and talks to clients when scope moves.",
  ),
  person(
    "clara",
    "Clara Meunier",
    "Developer",
    "engineering",
    "Builds back ends and exports for insurance and logistics clients.",
  ),
  person(
    "emma",
    "Emma Giraud",
    "Developer",
    "engineering",
    "Works on route planning and keeps the publisher's reader site running.",
  ),
  person(
    "hugo",
    "Hugo Tran",
    "Developer",
    "engineering",
    "Builds data feeds and the integrations around them.",
  ),
  person(
    "lina",
    "Lina Besson",
    "Developer",
    "engineering",
    "Builds member portals and their sign-in.",
  ),
  person(
    "mathis",
    "Mathis Aubry",
    "Developer",
    "engineering",
    "Works on connectors, test data and the cooperative's stock exports.",
  ),
  person(
    "nadia",
    "Nadia Kerroum",
    "Lead Developer",
    "engineering",
    "Leads the developers on the partner portal and reviews most pull requests.",
  ),
  person(
    "paul",
    "Paul Arnaud",
    "Developer",
    "engineering",
    "Works on rollouts and member sign-in.",
  ),
  person(
    "sofia",
    "Sofia Lind",
    "Data Engineer",
    "engineering",
    "Designs data models, imports and dashboards.",
  ),
  person(
    "yanis",
    "Yanis Belkacem",
    "Developer",
    "engineering",
    "Writes business rules and the checks on the data behind them.",
  ),
  person(
    "anais",
    "Anaïs Colin",
    "Finance",
    "finance",
    "Runs billing and the books: invoices, retainers, payments and the month end.",
  ),
  person(
    "romain",
    "Romain Pélissier",
    "Sales",
    "sales",
    "Runs new business: briefs, proposals and the pipeline.",
  ),
  person(
    "sarah",
    "Sarah Ouali",
    "Sales",
    "sales",
    "Looks after clients once they sign: renewals and the next piece of work.",
  ),
  person(
    "manon",
    "Manon Leclerc",
    "Designer",
    "engineering",
    "Designs interfaces and the screens clients sign off.",
  ),
  person(
    "victor",
    "Victor Hamon",
    "Designer",
    "engineering",
    "Designs interfaces and covers for Manon when she is away.",
  ),
  person(
    "noemie",
    "Noémie Garnier",
    "QA",
    "support",
    "Tests releases and answers the questions clients send about them.",
  ),
  person(
    "adil",
    "Adil Rahmani",
    "QA",
    "support",
    "Tests releases and keeps the test environments in shape.",
  ),
  person(
    "gaspard",
    "Gaspard Roche",
    "Operations",
    "support",
    "Runs the studio's own systems: laptops, accounts and the build machines.",
  ),
  person(
    "salome",
    "Salomé Petit",
    "Operations",
    "support",
    "Runs the office, the rota and the new starters' first week.",
  ),
  person(
    "julien",
    "Julien Marchetti",
    "Junior Developer",
    "engineering",
    "Joined delivery recently and pairs with the developers.",
  ),
  person(
    "tristan",
    "Tristan Bard",
    "Junior Developer",
    "engineering",
    "Joined delivery recently and pairs with the developers.",
  ),
  person(
    "maelle",
    "Maëlle Lopez",
    "Junior Developer",
    "engineering",
    "Joined delivery recently and pairs with the data engineer.",
  ),
]

/** A client company and its contacts. */
export interface StudioClient {
  key: string
  name: string
  /** Its reserved `.example` domain. */
  domain: string
  /** Customer keys of its contacts; the first one is invoiced and holds the billing address. */
  contactKeys: string[]
  /** Its billing address (a street of the story, not a real one). */
  street: string
  postcode: string
  city: string
}

/** The studio's own SIREN: all zero, like the declared VAT numbers here (a valid checksum). */
export const STUDIO_SIREN = "000000000"

/** Its clients' SIREN: zeros and a valid check digit, never the studio's own, so no e-invoice of
 *  the story names the same company as seller and buyer. No registered company has it. */
export const STUDIO_CLIENT_SIREN = "000000018"

export const STUDIO_CLIENTS: StudioClient[] = [
  {
    key: "marlin",
    name: "Groupe Marlin",
    domain: "groupe-marlin.example",
    contactKeys: ["pauline-gros", "remi-castel"],
    street: "8 rue des Mariniers",
    postcode: "69002",
    city: "Lyon",
  },
  {
    key: "sorel",
    name: "Éditions Sorel",
    domain: "editions-sorel.example",
    contactKeys: ["thomas-blanc"],
    street: "21 rue Sainte-Hélène",
    postcode: "69002",
    city: "Lyon",
  },
  {
    key: "alpine",
    name: "Coopérative Alpine",
    domain: "cooperative-alpine.example",
    contactKeys: ["ines-royer"],
    street: "3 chemin des Alpages",
    postcode: "38000",
    city: "Grenoble",
  },
  {
    key: "tessier",
    name: "Tessier Logistique",
    domain: "tessier-logistique.example",
    contactKeys: ["jean-tessier"],
    street: "40 avenue des Entrepôts",
    postcode: "69007",
    city: "Lyon",
  },
  {
    key: "verdier",
    name: "Verdier Transports",
    domain: "verdier-transports.example",
    contactKeys: ["marc-verdier"],
    street: "12 route du Port",
    postcode: "69200",
    city: "Vénissieux",
  },
  {
    // A past client: its audit closed two months ago and its retainer offer expired unsigned.
    key: "vallee",
    name: "Vallée Énergie",
    domain: "vallee-energie.example",
    contactKeys: ["camille-roux"],
    street: "17 quai Perrache",
    postcode: "69002",
    city: "Lyon",
  },
  {
    key: "rhone",
    name: "Rhône Mutuelle",
    domain: "rhone-mutuelle.example",
    contactKeys: ["helene-faure"],
    street: "5 place des Mutuelles",
    postcode: "69003",
    city: "Lyon",
  },
]

/**
 * Clients of earlier work the year's other invoices went to: names on invoices, no contact. The
 * first two are the closed past projects BRUME and OSIER (`plan.ts`), named in their
 * descriptions; the others have no project here. Their reserved `.example` domains carry the
 * invoice address.
 */
export const STUDIO_PAST_CLIENTS: ReadonlyArray<{ key: string; name: string; domain: string }> = [
  { key: "brume", name: "Brume Conseil", domain: "brume-conseil.example" },
  { key: "osier", name: "Osier Habitat", domain: "osier-habitat.example" },
  { key: "lanthier", name: "Maison Lanthier", domain: "maison-lanthier.example" },
  { key: "vallon", name: "Papeterie du Vallon", domain: "papeterie-vallon.example" },
  { key: "garance", name: "Garance Formation", domain: "garance-formation.example" },
  { key: "corbel", name: "Corbel Ingénierie", domain: "corbel-ingenierie.example" },
]

const contact = (key: string, name: string, client: string, local: string): DemoCustomer => {
  const domain = STUDIO_CLIENTS.find((c) => c.key === client)?.domain
  if (!domain) throw new Error(`studio fiction: no client '${client}'`)
  return { key, name, email: `${local}@${domain}`, country: "FR", isVip: false }
}

/** The clients' people the studio deals with. */
export const STUDIO_CONTACTS: DemoCustomer[] = [
  contact("pauline-gros", "Pauline Gros", "marlin", "pauline"),
  contact("remi-castel", "Rémi Castel", "marlin", "remi.castel"),
  contact("thomas-blanc", "Thomas Blanc", "sorel", "thomas.blanc"),
  contact("ines-royer", "Inès Royer", "alpine", "ines.royer"),
  contact("jean-tessier", "Jean Tessier", "tessier", "jean"),
  contact("marc-verdier", "Marc Verdier", "verdier", "marc"),
  contact("helene-faure", "Hélène Faure", "rhone", "helene.faure"),
  contact("camille-roux", "Camille Roux", "vallee", "camille.roux"),
]

export const STUDIO_WORLD: DemoWorld = {
  company: STUDIO_COMPANY,
  catalog: [],
  team: STUDIO_TEAM,
  dealers: [],
  customers: STUDIO_CONTACTS,
}

/**
 * Who is away, by week on the story clock: Manon this week and next, with
 * Victor next in line. She holds no planned work, so no capacity figure moves.
 */
export const STUDIO_AWAY: ReadonlyArray<{
  key: string
  /** Weeks from this week's Monday: 0 is this week. */
  fromWeek: number
  /** Through the Sunday of this week offset. */
  throughWeek: number
  nextInLine: string
}> = [{ key: "manon", fromWeek: 0, throughWeek: 1, nextInLine: "victor" }]
