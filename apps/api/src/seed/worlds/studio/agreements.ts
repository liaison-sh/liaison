// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `studio` world's agreements layer: the agreements list of the board, the client's mail
// asking for more and the change request card it gives, in the order they happened.
//
// - Each agreement is the row the agreements app writes as it works: a numbered row in its
//   series, its draft, the version frozen when it was sent, and, once a signer answered, one
//   signature event per signer. The seed is not a signature: every event it writes is at level
//   `demo`, a stand-in, never `ses`; the app's own seal of such a version is a `demo` record too.
// - The series counters are advanced past what was written, so the next agreement a visitor
//   makes takes the next number.
// - The client's mail arrives in the shared mailbox, and the change request card is staged as
//   the app's preflight stages it: the reply, the work, the hours with their source, the rate
//   and the passage of the signed text, its mail check pinned on the client's conversation and
//   its one key the client's mail. A new mail from the client stops the card.
//
// `studioAgreements` is the plan (pure, from the anchor); `seedStudioAgreements` writes it.
// Every write is keyed: a re-run adopts what is there and never adds a twin.
import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { appSequences } from "~/db/schema/kernel/app-sequences"
import { clientActions } from "~/db/schema/kernel/client-actions"
import { schemaRef } from "~/db/schema-ref"
import { generateToken, hashToken } from "~/lib/crypto"
import { writeClientActionEvent } from "~/modules/client-actions/events"
import { plainGuardSince } from "~/modules/mail/send-guard"
import type { SeedContext } from "~/seed/context"
import { type AppCell, insertAppRow, jsonCell, upsertAppRow } from "~/seed/factories/app-tables"
import { findOrCreateTitledThread, seedApprovalRequests } from "~/seed/factories/approvals/requests"
import { insertUnarmedMail } from "~/seed/factories/mail/conversations"
import { rowsOf } from "~/seed/factories/people/actors"
import { seedCompanies } from "~/seed/factories/people/companies"
import type { SeedDemoOrgResult } from "~/seed/tiers/demo/seed-org"
import { STUDIO_CONTACTS } from "./fiction"
import { STUDIO_PAST_SIGN_ON_HOURS } from "./knowledge"
import { parisCivil, studioPlan } from "./plan"

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/** The companies only the agreements list names: no project, no invoice. */
export const STUDIO_AGREEMENT_COMPANIES: ReadonlyArray<{
  key: string
  name: string
  domain: string
}> = [
  { key: "vallee", name: "Vallée Énergie", domain: "vallee-energie.example" },
  { key: "nord", name: "Maison Nord", domain: "maison-nord.example" },
]

export type StudioAgreementKind = "proposal" | "sow" | "nda" | "retainer" | "tm" | "dpa"

export type StudioAgreementStatus =
  | "sent"
  | "partly_signed"
  | "signed"
  | "ended"
  | "declined"
  | "expired"
  | "withdrawn"

/** One signer's answer, as the stand-in event records it. */
export interface StudioSignerPlan {
  /** A team key (`lea`) for the studio's own signer, or a contact key. */
  person: string
  /** Who it is, when no contact of the world names them. */
  name?: string
  email?: string
  capacity: string
  /** When they answered; null for a signer still waiting. */
  at: Date | null
}

export interface StudioAgreementPlan {
  key: string
  /** Its number in its series, `AG` or `PR`. */
  series: "AG" | "PR"
  seq: number
  kind: StudioAgreementKind
  title: string
  status: StudioAgreementStatus
  /** A client of `STUDIO_CLIENTS` or of `STUDIO_AGREEMENT_COMPANIES`. */
  company: string
  /** The contact who signs for the client, a key of `STUDIO_CONTACTS`. */
  contact: string | null
  /** The project it started. */
  project: string | null
  /** The pipeline deal it came from. */
  deal: string | null
  parent: string | null
  became: string | null
  pricingMode: "fixed" | "retainer" | "tm" | null
  priceMinor: number | null
  hoursMinutes: number | null
  rateMinor: number | null
  startsOn: string | null
  endsOn: string | null
  renewsOn: string | null
  noticeDays: number | null
  /** When its version was frozen and sent. */
  sentAt: Date
  /** When it closed: signed, ended, declined, expired or withdrawn. */
  closedAt: Date | null
  signers: StudioSignerPlan[]
  /** The frozen text, sections numbered at the start of their line. */
  text: string
}

/** The change request card: the client's mail, the reply and the work it adds. */
export interface StudioChangeRequestPlan {
  key: string
  parent: string
  /** The section of the parent's signed text the card quotes. */
  section: string
  title: string
  work: string[]
  hoursMinutes: number
  hoursSource: string
  rateMinor: number
  mailSubject: string
  mailBody: string
  replyBody: string
  /** When the client's mail arrived and when the card was staged. */
  mailAt: Date
  stagedAt: Date
}

export interface StudioAgreementsPlan {
  year: number
  agreements: StudioAgreementPlan[]
  changeRequest: StudioChangeRequestPlan
}

/** The signed statement of work's exclusions, quoted word for word by the change request. */
export const STUDIO_SOW_EXCLUSIONS =
  "3. Exclusions\n" +
  "The following are not part of this agreement and are quoted as a change request when asked: " +
  "single sign-on for partners or staff, a native mobile app, and migrating data from the old " +
  "portal beyond the partner list."

const PORTAL_SOW_TEXT = [
  "1. Parties",
  "Halden Studio SAS, Lyon, and Groupe Marlin, Lyon.",
  "2. Scope",
  "Rebuild of the partner portal: discovery, design, a beta with the partner list, orders and " +
    "documents, and the launch.",
  "2.1 Milestones",
  "Discovery, Design, Beta and Launch, each accepted by the client on delivery.",
  STUDIO_SOW_EXCLUSIONS,
  "4. Price",
  "A fixed price of 64,000.00 EUR excluding VAT: an advance of 20% on signature, 16,000.00 EUR " +
    "per milestone, and the last milestone less the advance.",
  "5. Changes",
  "Work outside section 2 is sized from past similar work and priced at 110.00 EUR per hour, in " +
    "a change request the client approves before it starts.",
].join("\n")

const textOf = (title: string, lines: string[]) =>
  [`${title}`, ...lines.map((l, i) => `${i + 1}. ${l}`)].join("\n")

/** The frozen source of a stand-in version: its title as a heading, each line a paragraph. */
export function blocksOfText(text: string): Array<{ type: string; text: string }> {
  const [title = "", ...lines] = text.split("\n")
  return [
    { type: "heading", text: title },
    ...lines.map((line) => ({ type: "paragraph", text: line })),
  ]
}

/** Midday on a civil day, Paris summer or winter. */
function noonOf(civil: string): Date {
  const [y, m, d] = civil.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d, 10))
}

const pad = (n: number) => String(n).padStart(2, "0")

/** The plan at an anchor: every date is a distance from it. */
export function studioAgreements(anchor: Date): StudioAgreementsPlan {
  const today = parisCivil(anchor)
  const [ty, tm] = today.split("-").map(Number) as [number, number]
  const ago = (days: number, hours = 0) =>
    new Date(anchor.getTime() - days * DAY_MS - hours * HOUR_MS)
  const civilAgo = (days: number) => parisCivil(ago(days))
  const monthFirst = (ahead: number) => {
    const i = ty * 12 + (tm - 1) + ahead
    return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}-01`
  }
  const monthLast = (ahead: number) => {
    const first = monthFirst(ahead + 1)
    return parisCivil(new Date(noonOf(first).getTime() - DAY_MS))
  }
  const yearsOn = (civil: string, years: number) =>
    `${Number(civil.slice(0, 4)) + years}${civil.slice(4)}`
  const daysBetween = (from: string, to: string) =>
    Math.round((noonOf(to).getTime() - noonOf(from).getTime()) / DAY_MS)

  const signedPortal = ago(209)
  const sorelRenews = monthFirst(2)
  const base = {
    parent: null,
    became: null,
    deal: null,
    project: null,
    pricingMode: null,
    priceMinor: null,
    hoursMinutes: null,
    rateMinor: null,
    startsOn: null,
    endsOn: null,
    renewsOn: null,
    noticeDays: null,
  } satisfies Partial<StudioAgreementPlan>

  const agreements: StudioAgreementPlan[] = [
    {
      ...base,
      key: "marlin-nda",
      series: "AG",
      seq: 2,
      kind: "nda",
      title: "Mutual NDA",
      status: "signed",
      company: "marlin",
      contact: "pauline-gros",
      startsOn: civilAgo(300),
      endsOn: yearsOn(civilAgo(300), 3),
      sentAt: ago(301),
      closedAt: ago(300),
      signers: [
        { person: "lea", capacity: "Co-founder", at: ago(301, -2) },
        { person: "pauline-gros", capacity: "Head of digital", at: ago(300) },
      ],
      text: textOf("Mutual NDA", [
        "Each party keeps the other's confidential information to itself.",
        "This agreement lasts three years from its signature.",
      ]),
    },
    {
      ...base,
      key: "sorel-retainer",
      series: "AG",
      seq: 6,
      kind: "retainer",
      title: "Content platform retainer",
      status: "signed",
      company: "sorel",
      contact: "thomas-blanc",
      project: "SOREL",
      pricingMode: "retainer",
      priceMinor: 450_000,
      hoursMinutes: 40 * 60,
      rateMinor: 12_000,
      startsOn: monthFirst(-10),
      renewsOn: sorelRenews,
      noticeDays: daysBetween(monthFirst(1), sorelRenews),
      sentAt: ago(320),
      closedAt: ago(318),
      signers: [
        { person: "lea", capacity: "Co-founder", at: ago(319) },
        { person: "thomas-blanc", capacity: "Publisher", at: ago(318) },
      ],
      text: textOf("Content platform retainer", [
        "40 hours of work a month on the reader site and the rights database for 4,500.00 EUR excluding VAT.",
        "Hours above 40 in a month are billed at 120.00 EUR each; unused hours do not roll over.",
        "The retainer renews each year unless notice is given a month before.",
      ]),
    },
    {
      ...base,
      key: "alpine-tm",
      series: "AG",
      seq: 9,
      kind: "tm",
      title: "Data systems, time and materials",
      status: "signed",
      company: "alpine",
      contact: "ines-royer",
      project: "ALPINE",
      pricingMode: "tm",
      rateMinor: 93_000,
      startsOn: civilAgo(150),
      endsOn: monthLast(1),
      sentAt: ago(152),
      closedAt: ago(150),
      signers: [
        { person: "lea", capacity: "Co-founder", at: ago(151) },
        { person: "ines-royer", capacity: "Data lead", at: ago(150) },
      ],
      text: textOf("Data systems, time and materials", [
        "Work on the cooperative's data exports and monitoring, by the day.",
        "A day is billed at 930.00 EUR excluding VAT, from the days planned each month.",
      ]),
    },
    {
      ...base,
      key: "portal-sow",
      series: "AG",
      seq: 11,
      kind: "sow",
      title: "Partner portal rebuild",
      status: "signed",
      company: "marlin",
      contact: "pauline-gros",
      project: "MARLIN",
      pricingMode: "fixed",
      priceMinor: 6_400_000,
      rateMinor: 11_000,
      startsOn: parisCivil(signedPortal),
      sentAt: ago(210),
      closedAt: signedPortal,
      signers: [
        { person: "lea", capacity: "Co-founder", at: ago(209, 3) },
        { person: "pauline-gros", capacity: "Head of digital", at: signedPortal },
      ],
      text: PORTAL_SOW_TEXT,
    },
    {
      ...base,
      key: "vallee-audit",
      series: "AG",
      seq: 12,
      kind: "sow",
      title: "Data pipeline audit",
      status: "ended",
      company: "vallee",
      contact: null,
      pricingMode: "fixed",
      priceMinor: 1_850_000,
      startsOn: monthFirst(-4),
      endsOn: monthLast(-2),
      sentAt: ago(130),
      closedAt: ago(128),
      signers: [
        { person: "lea", capacity: "Co-founder", at: ago(129) },
        {
          person: "vallee-contact",
          name: "Camille Roux",
          email: "camille.roux@vallee-energie.example",
          capacity: "Head of data",
          at: ago(128),
        },
      ],
      text: textOf("Data pipeline audit", [
        "An audit of the data pipeline and a written report.",
        "A fixed price of 18,500.00 EUR excluding VAT.",
      ]),
    },
    {
      ...base,
      key: "vallee-retainer",
      series: "AG",
      seq: 10,
      kind: "retainer",
      title: "Analytics retainer",
      status: "expired",
      company: "vallee",
      contact: null,
      pricingMode: "retainer",
      priceMinor: 200_000,
      sentAt: ago(51),
      closedAt: ago(37),
      signers: [
        {
          person: "vallee-contact",
          name: "Camille Roux",
          email: "camille.roux@vallee-energie.example",
          capacity: "Head of data",
          at: null,
        },
      ],
      text: textOf("Analytics retainer", [
        "Monthly analytics support for 2,000.00 EUR excluding VAT.",
      ]),
    },
    {
      ...base,
      key: "vallee-dashboards",
      series: "PR",
      seq: 16,
      kind: "proposal",
      title: "Warehouse dashboards",
      status: "withdrawn",
      company: "vallee",
      contact: null,
      pricingMode: "fixed",
      priceMinor: 940_000,
      sentAt: ago(75),
      closedAt: ago(61),
      signers: [
        {
          person: "vallee-contact",
          name: "Camille Roux",
          email: "camille.roux@vallee-energie.example",
          capacity: "Head of data",
          at: null,
        },
      ],
      text: textOf("Warehouse dashboards", ["Dashboards over the warehouse data, fixed price."]),
    },
    {
      ...base,
      key: "nord-scoping",
      series: "PR",
      seq: 19,
      kind: "proposal",
      title: "Mobile app scoping",
      status: "declined",
      company: "nord",
      contact: null,
      pricingMode: "fixed",
      priceMinor: 1_200_000,
      sentAt: ago(30),
      closedAt: ago(19),
      signers: [
        {
          person: "nord-contact",
          name: "Hugo Lemaire",
          email: "hugo.lemaire@maison-nord.example",
          capacity: "Director",
          at: null,
        },
      ],
      text: textOf("Mobile app scoping", ["Scoping of a mobile app, fixed price."]),
    },
    {
      ...base,
      key: "tessier-nda",
      series: "AG",
      seq: 13,
      kind: "nda",
      title: "Mutual NDA",
      status: "signed",
      company: "tessier",
      contact: "jean-tessier",
      startsOn: civilAgo(38),
      endsOn: yearsOn(civilAgo(38), 3),
      sentAt: ago(39),
      closedAt: ago(38),
      signers: [
        { person: "lea", capacity: "Co-founder", at: ago(39, -2) },
        { person: "jean-tessier", capacity: "Managing director", at: ago(38) },
      ],
      text: textOf("Mutual NDA", [
        "Each party keeps the other's confidential information to itself.",
        "This agreement lasts three years from its signature.",
      ]),
    },
    {
      ...base,
      key: "tessier-proposal",
      series: "PR",
      seq: 21,
      kind: "proposal",
      title: "Carrier booking and tracking system",
      // Accepted on its link, as the app records a proposal's acceptance: signed.
      status: "signed",
      company: "tessier",
      contact: "jean-tessier",
      deal: "SALES-1",
      became: "tessier-sow",
      pricingMode: "fixed",
      priceMinor: 3_800_000,
      sentAt: ago(12),
      closedAt: ago(5),
      signers: [{ person: "jean-tessier", capacity: "Managing director", at: ago(5) }],
      text: textOf("Carrier booking and tracking system", [
        "Booking, tracking and carrier invoices in one system, fixed price.",
      ]),
    },
    {
      ...base,
      key: "tessier-sow",
      series: "AG",
      seq: 14,
      kind: "sow",
      title: "Carrier booking and tracking system",
      status: "partly_signed",
      company: "tessier",
      contact: "jean-tessier",
      deal: "SALES-1",
      pricingMode: "fixed",
      priceMinor: 3_800_000,
      sentAt: ago(3),
      closedAt: null,
      signers: [
        { person: "lea", capacity: "Co-founder", at: ago(3, -1) },
        { person: "jean-tessier", capacity: "Managing director", at: null },
      ],
      text: textOf("Carrier booking and tracking system", [
        "Booking, tracking and carrier invoices in one system.",
        "A fixed price of 38,000.00 EUR excluding VAT, by milestones.",
      ]),
    },
    {
      ...base,
      key: "marlin-dpa",
      series: "AG",
      seq: 15,
      kind: "dpa",
      title: "Data processing addendum",
      status: "sent",
      company: "marlin",
      contact: "pauline-gros",
      parent: "portal-sow",
      sentAt: ago(0, 1),
      closedAt: null,
      signers: [{ person: "pauline-gros", capacity: "Head of digital", at: null }],
      text: textOf("Data processing addendum", [
        "The studio processes the partner list on the client's instructions only.",
        "Personal data stays in the European Union.",
      ]),
    },
  ]

  const signOnMeanMinutes =
    ((STUDIO_PAST_SIGN_ON_HOURS.brume + STUDIO_PAST_SIGN_ON_HOURS.osier) / 2) * 60
  return {
    year: ty,
    agreements,
    changeRequest: {
      key: "marlin-sso",
      parent: "portal-sow",
      section: "3",
      title: "Single sign-on for partners",
      work: [
        "Single sign-on for partner accounts through their own identity provider",
        "Tests and a runbook for adding a partner",
      ],
      // The mean of the two past projects' sign-on, from their Knowledge notes.
      hoursMinutes: signOnMeanMinutes,
      hoursSource: `past similar work in Knowledge: sign-on on the BRUME and OSIER projects took ${STUDIO_PAST_SIGN_ON_HOURS.brume} h and ${STUDIO_PAST_SIGN_ON_HOURS.osier} h, ${signOnMeanMinutes / 60} h on average`,
      rateMinor: 11_000,
      mailSubject: "Partner portal: one more thing",
      mailBody: "Hello, can you also add single sign-on for our partners? Thanks, Pauline",
      replyBody:
        "Hello Pauline, single sign-on is outside the signed scope (section 3). Here is a change " +
        "request for it, excluding VAT. Approve it on the link and we start. Best regards",
      mailAt: ago(0, 0.2),
      stagedAt: ago(0, 0.15),
    },
  }
}

/** An agreement's number: `AG-<year>-011`. */
export function studioAgreementNumber(
  year: number,
  a: Pick<StudioAgreementPlan, "series" | "seq">,
) {
  return `${a.series}-${year}-${String(a.seq).padStart(3, "0")}`
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

/** A version row is written once: a re-run leaves the one already there alone. */
async function insertOnce(
  tx: Parameters<typeof insertAppRow>[0],
  table: string,
  row: Record<string, AppCell> & { id: string; org_id: string },
) {
  const found = rowsOf<{ id: string }>(
    await tx.execute(
      sql`SELECT id::text AS id FROM ${sql.identifier(schemaRef("app_agreements"))}.${sql.identifier(table)}
          WHERE id = ${row.id}::uuid LIMIT 1`,
    ),
  )
  if (found.length === 0) await insertAppRow(tx, "agreements", table, row)
}

/** The words a stand-in signature event records: no person signed anything. */
export const STAND_IN_CONSENT_WORDS = "A stand-in for the demo: no signature took place."

/**
 * A stand-in signature event (level `demo`): what the services world records where a fictional
 * client "signs". The seal finds only `demo` events and writes a stand-in record: no seal, no
 * signed copy, no timestamp, no copy mail. Written once per id.
 */
export async function writeStandInSignatureEvent(
  tx: Parameters<typeof insertAppRow>[0],
  e: {
    id: string
    orgId: string
    versionId: string
    clientActionId: string
    signerOrder: number | null
    signerContactId: string | null
    signerUserId: string | null
    invitedEmail: string
    invitedBy: string
    typedName: string
    capacity: string
    documentSha256: string
    at: Date
  },
): Promise<void> {
  await insertOnce(tx, "signature_events", {
    id: e.id,
    org_id: e.orgId,
    version_id: e.versionId,
    client_action_id: e.clientActionId,
    signer_order: e.signerOrder,
    signer_contact_id: e.signerContactId,
    signer_user_id: e.signerUserId,
    invited_email: e.invitedEmail,
    invited_by: e.invitedBy,
    typed_name: e.typedName,
    capacity: e.capacity,
    consent_words: STAND_IN_CONSENT_WORDS,
    consent_lang: "en",
    level: "demo",
    document_sha256: e.documentSha256,
    signed_at: e.at.toISOString(),
    created_at: e.at.toISOString(),
  })
}

export interface StudioAgreementsInput {
  ctx: SeedContext
  org: SeedDemoOrgResult
  owner: UserContext
  companyIds: Readonly<Record<string, string>>
  projectIds: Readonly<Record<string, string>>
  dealIds: Readonly<Record<string, string>>
  /** The fixed-price project's quote, when the money layer wrote it. */
  quoteDocumentId: string | null
}

/**
 * Write the plan: the companies only it names, each agreement in the order it was sent, the
 * series counters, the client's mail, then the change request card.
 */
export async function seedStudioAgreements(input: StudioAgreementsInput): Promise<void> {
  const { ctx, org, owner } = input
  const plan = studioAgreements(ctx.now)
  const projects = studioPlan(ctx.now).projects
  const projectOf = (key: string) => projects.find((p) => p.key === key)
  const lea = org.peopleByKey.lea?.userId
  if (!lea) throw new Error("studio agreements: no co-founder")
  const ownerId = org.ownerUserId ?? org.adminUserId

  const extra = await seedCompanies(
    ctx,
    owner,
    STUDIO_AGREEMENT_COMPANIES.map((c) => ({ key: c.key, name: c.name, domain: c.domain })),
    {},
  )
  const companyIds = { ...input.companyIds, ...extra }
  const contactRows = await withPrivilegedDb(ctx.orgId, "seed-studio:agreement-contacts", (tx) =>
    tx.execute(sql`
      SELECT id::text AS id, lower(email) AS email FROM ${sql.raw(schemaRef("kernel"))}.contacts
       WHERE org_id = ${ctx.orgId}::uuid AND email IS NOT NULL`),
  )
  const contactIdByEmail = new Map(
    rowsOf<{ id: string; email: string }>(contactRows).map((r) => [r.email, r.id]),
  )
  const contactOf = (key: string) => {
    const c = STUDIO_CONTACTS.find((x) => x.key === key)
    const id = c ? contactIdByEmail.get(c.email.toLowerCase()) : undefined
    return c && id ? { id, name: c.name, email: c.email } : null
  }
  const agreementId = (key: string) => ctx.id("agreement", `studio:${key}`)
  const versionId = (key: string) => ctx.id("agreement_version", `studio:${key}:1`)
  const leaName = org.peopleByKey.lea?.name ?? "Léa Fontaine"
  const leaEmail = org.peopleByKey.lea?.email ?? ""

  const ordered = [...plan.agreements].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
  await withSystemDb("seed-studio-agreements", async (tx) => {
    for (const a of ordered) {
      const id = agreementId(a.key)
      const number = studioAgreementNumber(plan.year, a)
      const company = companyIds[a.company]
      if (!company) throw new Error(`studio agreements: no company ${a.company}`)
      const contact = a.contact ? contactOf(a.contact) : null
      const signedAt = a.status === "signed" || a.status === "ended" ? a.closedAt : null
      const sentIso = a.sentAt.toISOString()
      const lastIso = (a.closedAt ?? a.sentAt).toISOString()
      await upsertAppRow(tx, "agreements", "agreements", {
        id,
        org_id: ctx.orgId,
        number,
        kind: a.kind,
        status: a.status,
        title: a.title,
        company_id: company,
        contact_id: contact?.id ?? null,
        deal_task_id: a.deal ? (input.dealIds[a.deal] ?? null) : null,
        project_id: a.project ? (input.projectIds[a.project] ?? null) : null,
        // What the product records when a signed agreement makes its project: whether the
        // project uses time and budgets, and the whole-project timebox it was given. A change
        // request reads both.
        project_time_budgets: a.project ? (projectOf(a.project)?.timeBudgets ?? null) : null,
        project_timebox_minutes: a.project ? (projectOf(a.project)?.timeboxMinutes ?? null) : null,
        quote_document_id: a.key === "portal-sow" ? input.quoteDocumentId : null,
        parent_agreement_id: a.parent ? agreementId(a.parent) : null,
        became_agreement_id: a.became ? agreementId(a.became) : null,
        language: "en",
        fit_tag: "commercial",
        pricing_mode: a.pricingMode,
        price_minor: a.priceMinor === null ? null : String(a.priceMinor),
        currency: a.priceMinor === null && a.rateMinor === null ? null : "EUR",
        priced_by_user_id: a.priceMinor === null ? null : lea,
        amended_total_minor: a.priceMinor === null ? null : String(a.priceMinor),
        hours_minutes: a.hoursMinutes,
        rate_minor: a.rateMinor === null ? null : String(a.rateMinor),
        starts_on: a.startsOn,
        ends_on: a.endsOn,
        renews_on: a.renewsOn,
        notice_days: a.noticeDays,
        signed_at: signedAt ? signedAt.toISOString() : null,
        org_access: "editor",
        acl_user_ids: jsonCell([]),
        created_by_user_id: lea,
        created_at: new Date(a.sentAt.getTime() - DAY_MS).toISOString(),
        updated_at: lastIso,
      })
      await upsertAppRow(tx, "agreements", "agreement_drafts", {
        id: ctx.id("agreement_draft", `studio:${a.key}`),
        org_id: ctx.orgId,
        agreement_id: id,
        next_number: 2,
        lock_version: 1,
        updated_by_user_id: lea,
        created_at: new Date(a.sentAt.getTime() - DAY_MS).toISOString(),
        updated_at: sentIso,
      })
      const closedSigned = a.status === "signed" || a.status === "ended"
      const digest = sha256(a.text)
      await insertOnce(tx, "agreement_versions", {
        id: versionId(a.key),
        org_id: ctx.orgId,
        agreement_id: id,
        number: 1,
        source_text: a.text,
        source: jsonCell({ body: { blocks: blocksOfText(a.text) } }),
        sha256: digest,
        byte_size: Buffer.byteLength(a.text, "utf8"),
        frozen_at: sentIso,
        frozen_by_user_id: lea,
        source_kind: "generated",
        source_text_origin: "rendered",
        status: closedSigned ? "signed" : "frozen",
        created_at: sentIso,
        updated_at: lastIso,
      })
      for (const [i, s] of a.signers.entries()) {
        if (!s.at) continue
        const staff = s.person === "lea"
        const c = staff ? null : contactOf(s.person)
        await writeStandInSignatureEvent(tx, {
          id: ctx.id("signature_event", `studio:${a.key}:${i}`),
          orgId: ctx.orgId,
          versionId: versionId(a.key),
          clientActionId: ctx.id("client_action", `studio:${a.key}:${i}`),
          signerOrder: i + 1,
          signerContactId: c?.id ?? null,
          signerUserId: staff ? lea : null,
          invitedEmail: staff ? leaEmail : (c?.email ?? s.email ?? ""),
          invitedBy: leaName,
          typedName: staff ? leaName : (c?.name ?? s.name ?? ""),
          capacity: s.capacity,
          documentSha256: digest,
          at: s.at,
        })
      }
    }
  })

  // The next agreement a person makes takes the next number of its series.
  const highest = new Map<string, number>()
  for (const a of plan.agreements) {
    const key = `agreements:${a.series}:${plan.year}`
    highest.set(key, Math.max(highest.get(key) ?? 0, a.seq))
  }
  await withPrivilegedDb(ctx.orgId, "seed-studio:agreement-sequences", async (tx) => {
    for (const [key, value] of highest) {
      await tx
        .insert(appSequences)
        .values({ orgId: ctx.orgId, appId: "agreements", key, value, updatedAt: sql`now()` })
        .onConflictDoUpdate({
          target: [appSequences.orgId, appSequences.appId, appSequences.key],
          set: {
            value: sql`GREATEST(${appSequences.value}, excluded.value)`,
            updatedAt: sql`now()`,
          },
        })
    }
  })

  // Every signer of every sent agreement holds the link its send left them, in the state the
  // story reached: signed, declined, expired, withdrawn, open for the next signer, or waiting
  // its turn after them. So a page lists each signer, a closed one offers a new link, and the
  // Scope check finds who sent a signed agreement. Written without any mail (the product
  // mails at send; a seed sends nothing), so no link opens anything.
  await withPrivilegedDb(ctx.orgId, "seed-studio:signing-links", async (tx) => {
    for (const a of ordered) {
      const openAt = a.signers.findIndex((s) => !s.at)
      for (const [i, s] of a.signers.entries()) {
        const staff = s.person === "lea"
        // An outside signer is a client contact, or a person named on the agreement alone.
        const c = staff
          ? null
          : (contactOf(s.person) ??
            (s.email ? { id: null, name: s.name ?? s.email, email: s.email } : null))
        if (!staff && !c) continue
        const signed = s.at !== null
        const closedAt = a.closedAt ?? a.sentAt
        const declined = !signed && a.status === "declined" && i === openAt
        const withdrawn = !signed && a.status === "withdrawn"
        const expired = !signed && a.status === "expired"
        // The next signer holds the open link; one after them waits its turn (no token yet).
        const holdsToken = signed || declined || expired || withdrawn || i === openAt
        const id = ctx.id("client_action", `studio:${a.key}:${i}`)
        const inserted = await tx
          .insert(clientActions)
          .values({
            id,
            orgId: ctx.orgId,
            groupId: ctx.id("client_action_group", `studio:${a.key}`),
            kind: "sign",
            targetApp: "agreements",
            targetType: "agreement_version",
            targetId: versionId(a.key),
            targetSha256: sha256(a.text),
            companyId: staff ? null : (companyIds[a.company] ?? null),
            contactId: c?.id ?? null,
            signerUserId: staff ? lea : null,
            invitedEmail: (staff ? leaEmail : (c?.email ?? "")).toLowerCase(),
            invitedName: staff ? leaName : (c?.name ?? ""),
            signOrder: i + 1,
            tokenHash: holdsToken ? hashToken(generateToken(32)) : null,
            expiresAt: expired ? closedAt : new Date(a.sentAt.getTime() + 14 * DAY_MS),
            sentAt: holdsToken ? a.sentAt : null,
            ...(signed && s.at
              ? {
                  decidedAt: s.at,
                  decision: "signed",
                  decidedVia: "link",
                  codeVerifiedAt: s.at,
                  documentShownAt: s.at,
                  typedName: staff ? leaName : (c?.name ?? ""),
                  capacity: s.capacity,
                }
              : {}),
            ...(declined ? { decidedAt: closedAt, decision: "declined", decidedVia: "link" } : {}),
            ...(withdrawn
              ? { revokedAt: closedAt, revokedBy: lea, revokeReason: "withdrawn" }
              : {}),
            createdByUserId: lea,
            createdAt: a.sentAt,
          })
          .onConflictDoNothing()
          .returning({ id: clientActions.id })
        if (inserted.length === 0) continue
        await writeClientActionEvent(tx, {
          orgId: ctx.orgId,
          actionId: id,
          event: "created",
          actorKind: "staff",
          actorUserId: lea,
          meta: { kind: "sign", target: "agreements.agreement_version" },
        })
      }
    }
  })

  await seedStudioChangeRequest(ctx, org, ownerId, plan, agreementId, versionId, contactOf)
  ctx.log(`agreements: ${plan.agreements.length} rows, change request card staged`)
}

/** The client contact the change request's card answers: its reply mails them. */
export const STUDIO_CHANGE_REQUEST_CONTACT = "pauline-gros"

/** The client's mail in the shared mailbox, then the card it gives, staged as the app stages it. */
async function seedStudioChangeRequest(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  ownerId: string,
  plan: StudioAgreementsPlan,
  agreementId: (key: string) => string,
  versionId: (key: string) => string,
  contactOf: (key: string) => { id: string; name: string; email: string } | null,
): Promise<void> {
  const cr = plan.changeRequest
  const client = contactOf(STUDIO_CHANGE_REQUEST_CONTACT)
  if (!client) throw new Error("studio agreements: no client contact for the change request")
  const [mailbox] = await withPrivilegedDb(ctx.orgId, "seed-studio:cr-mailbox", async (tx) =>
    rowsOf<{ email: string; name: string | null }>(
      await tx.execute(sql`
        SELECT email_address AS email, display_name AS name
          FROM ${sql.raw(schemaRef("app_mail"))}.accounts
         WHERE org_id = ${ctx.orgId}::uuid AND owner_type = 'org'
         ORDER BY created_at, id LIMIT 1`),
    ),
  )
  if (!mailbox) throw new Error("studio agreements: no shared mailbox for the client's mail")
  const hoursAgo = (at: Date) => (ctx.now.getTime() - at.getTime()) / HOUR_MS
  const { conversationIds } = await insertUnarmedMail(ctx, {
    domain: mailbox.email.split("@")[1] ?? "haldenstudio.example",
    mailboxes: [
      { box: "org", ownerUserId: null, email: mailbox.email, displayName: mailbox.name ?? "" },
    ],
    conversations: [
      {
        key: `studio:${cr.key}`,
        box: "org",
        subject: cr.mailSubject,
        status: "open",
        labels: ["INBOX"],
        isRead: false,
        isStarred: false,
        messages: [
          {
            direction: "inbound",
            fromName: client.name,
            fromEmail: client.email,
            toName: mailbox.name ?? "",
            toEmail: mailbox.email,
            hoursAgo: hoursAgo(cr.mailAt),
            body: cr.mailBody,
          },
        ],
      },
    ],
  })
  const conversationId = conversationIds[0]
  if (!conversationId) throw new Error("studio agreements: the client's mail was not written")
  const mailMessageId = ctx.id("mail-message", `studio:${cr.key}:0`)
  const parentId = agreementId(cr.parent)
  const threadId = await findOrCreateTitledThread(ctx, ownerId, "Scope check")
  const agentId = org.people.find((p) => p.userId === ownerId)?.personalAgentId ?? null
  const sendGuard = {
    ...plainGuardSince([client.email], [client.id], cr.stagedAt, conversationId),
    classification: "service" as const,
  }
  await seedApprovalRequests(ctx, [
    {
      id: ctx.id("approval", `studio:${cr.key}`),
      handle: `demo-${cr.key}`,
      threadId,
      toolName: "agreements:change_request_send",
      payload: {
        parent_agreement_id: parentId,
        title: cr.title,
        work: cr.work,
        hours_minutes: cr.hoursMinutes,
        hours_source: cr.hoursSource,
        rate_minor: String(cr.rateMinor),
        reply: { conversation_id: conversationId, body: cr.replyBody },
        passage: { version_id: versionId(cr.parent), section: cr.section },
        mail_message_id: mailMessageId,
        sendGuard,
        guardKey: `${parentId}:${mailMessageId}`,
        currency: "EUR",
      },
      requestedBy: ownerId,
      agentId,
      notifyUserIds: [ownerId],
      status: "pending",
      createdAt: cr.stagedAt,
    },
  ])
}
