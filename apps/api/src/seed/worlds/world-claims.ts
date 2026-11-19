// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the door says about each world, claim by claim, and the tests that
// prove each one true of the seeded world. A door string a visitor reads
// (`kernel.demo.world.<world>.*`) that makes a claim has a row here; the meta
// test (`world-claims.test.ts`) fails on a door string with no row and on a
// row with no proof, so a claim cannot reach the door unproven.
import type { DemoWorldId } from "@liaison/shared"

export interface WorldClaim {
  /** The door string, under `kernel.demo.world.<world>.`; `<prefix>.*` covers every string under it. */
  key: string
  /** The claim, in the words of the spec's claims table. */
  claim: string
  /** What must be true of the seeded world. */
  mustBeTrue: string
  /** The test files that prove it, relative to `seed/worlds/` or the api's `src/`. */
  provenBy: readonly string[]
}

/**
 * Door strings that make no claim about the world's rows (the frame around the
 * claims: who the visitor is, that it is an example). Listed so the meta test
 * can tell a deliberate frame from a forgotten claim.
 */
export const DOOR_FRAME_KEYS: Readonly<Partial<Record<DemoWorldId, readonly string[]>>> = {
  saas: ["companyFacts", "companyExample", "companyYou"],
  studio: ["companyExample", "companyYou", "teamYouRole"],
}

/** The software world seeded once and read through the product's tools. */
const READS = "saas/stripe-world-reads.saas.integration.test.ts"
/** The card-payments stand-in: answers, refusals and writes kept at the stand-in. */
const STAND_IN = "modules/demo/worlds/saas/payments/stripe-standin.integration.test.ts"

/** The services world seeded once: desks, members, apps, queues, Home and routines. */
const STUDIO_DESK = "studio/world-desk.studio.integration.test.ts"
/** Its figures read through the product's own tools: time, budgets, margin, reconcile, invoices. */
const STUDIO_FIGURES = "studio/world-figures.studio.integration.test.ts"
/** Its agreements, change request card, stand-in signatures and the client portal's preview. */
const STUDIO_AGREEMENTS = "studio/agreements-layer.studio.integration.test.ts"
/** The services world's repository stand-in. */
const STUDIO_REPOS = "modules/demo/worlds/studio/github/github-standin.integration.test.ts"
/** The client's acceptance in the tour, a stand-in that is never sealed. */
const STUDIO_ACCEPTANCE = "modules/demo/worlds/studio/cr-accepted.integration.test.ts"

export const WORLD_CLAIMS: Readonly<Partial<Record<DemoWorldId, readonly WorldClaim[]>>> = {
  saas: [
    {
      key: "teamRole.*",
      claim: "the team the door names, each with a role",
      mustBeTrue: "13 named people and the owner's seat, each a member with that role",
      provenBy: [READS, "saas/plan-invariants.test.ts"],
    },
    {
      key: "companyAbout",
      claim: "169 customers pay by card",
      mustBeTrue: "the MRR query's active count is 169",
      provenBy: [READS, "world-claims.test.ts"],
    },
    {
      key: "companyAbout",
      claim: "a few larger groups pay by bank transfer",
      mustBeTrue: "Verrières and Cantines du Port Group are billed by transfer schedules",
      provenBy: [READS],
    },
    {
      key: "companyAbout",
      claim: "sold by subscription from €149 to €1,450 a month",
      mustBeTrue: "the plans' monthly prices",
      provenBy: ["saas/plan-invariants.test.ts", "world-claims.test.ts"],
    },
    {
      key: "companyOps.payments.title",
      claim: "subscriptions and payments",
      mustBeTrue: "the payments app is on with its mirror",
      provenBy: [READS],
    },
    {
      key: "companyOps.payments.body",
      claim: "the Finance Desk agent watches failed payments and drafts the note; Sara approves it",
      mustBeTrue:
        "the failed payments routine runs under the Finance Desk and Sara holds the approve scope",
      provenBy: [READS],
    },
    {
      key: "companyOps.invoicing.title",
      claim: "invoicing",
      mustBeTrue: "the invoicing app is on with the year's invoices",
      provenBy: [READS],
    },
    {
      key: "companyOps.invoicing.body",
      claim: "Liaison issues every invoice, with no gaps",
      mustBeTrue: "the issuer stream is Liaison's and numbers run with no gap",
      provenBy: [READS],
    },
    {
      key: "companyOps.support.title",
      claim: "support",
      mustBeTrue: "the tickets app is on with its queue",
      provenBy: [READS],
    },
    {
      key: "companyOps.support.body",
      claim: "customer mail lands in Tickets and the Support Desk agent drafts each reply",
      mustBeTrue: "the support inbox and the Support Desk",
      provenBy: [READS],
    },
    {
      key: "companyOps.sales.title",
      claim: "sales",
      mustBeTrue: "the pipeline exists",
      provenBy: [READS],
    },
    {
      key: "companyOps.sales.body",
      claim: "Tom's deals live on a board; a routine drafts the follow-ups",
      mustBeTrue: "the pipeline, and the deal follow-ups routine with its staged drafts",
      provenBy: [READS],
    },
    {
      key: "companyOps.product.title",
      claim: "product and chat",
      mustBeTrue: "a product project and channels",
      provenBy: [READS],
    },
    {
      key: "companyOps.product.body",
      claim: "the team plans product work in Projects and talks in Chat",
      mustBeTrue: "a product project and channels",
      provenBy: [READS],
    },
    {
      key: "companyOps.knowledge.title",
      claim: "company knowledge",
      mustBeTrue: "the knowledge base holds the company's articles",
      provenBy: [READS],
    },
    {
      key: "companyOps.knowledge.body",
      claim: "each agent reads only what its person may open",
      mustBeTrue: "the refund policy is restricted to finance",
      provenBy: [READS],
    },
    {
      key: "limitConnectors",
      claim:
        "the payments account is a stand-in; connecting a real account is refused; refunds and cancellations act on the stand-in only",
      mustBeTrue: "the stand-in answers, a real key is refused, writes stay at the stand-in",
      provenBy: [STAND_IN],
    },
    {
      key: "companySimulated",
      claim: "no mail leaves, and the payments account and its payments are stand-ins",
      mustBeTrue: "the payments stand-in answers and mail is held",
      provenBy: [STAND_IN],
    },
  ],
  studio: [
    {
      key: "companyFacts",
      claim: "a fictional company in Lyon with 24 people",
      mustBeTrue: "the company's city is Lyon and 24 people are active members",
      provenBy: [STUDIO_DESK, "studio/plan-invariants.test.ts"],
    },
    {
      key: "companyAbout",
      claim:
        "it bills by the hour or the day, at a fixed price with milestones, or on a monthly retainer",
      mustBeTrue:
        "the active projects hold a by-the-day, a fixed-price with milestones and a retainer basis",
      provenBy: [STUDIO_FIGURES, "studio/plan-invariants.test.ts"],
    },
    {
      key: "companyAbout",
      claim: "clients follow their project on a portal of their own",
      mustBeTrue: "the client access preview reads what the portal shows the fixed-price client",
      provenBy: [STUDIO_AGREEMENTS, STUDIO_FIGURES],
    },
    {
      key: "companyAbout",
      claim: "every piece of work starts from a signed agreement",
      mustBeTrue: "each active client project has its signed agreement, at the stand-in level",
      provenBy: [STUDIO_AGREEMENTS],
    },
    {
      key: "companyOps.agreements.*",
      claim:
        "proposals and contracts, signed in Liaison; the agent checks them when a client asks for more",
      mustBeTrue:
        "the agreements list, and a scope question reaching the signed passage with one card",
      provenBy: [STUDIO_AGREEMENTS, "studio/client-scope-question.studio.integration.test.ts"],
    },
    {
      key: "companyOps.delivery.*",
      claim:
        "each task has a planned time and whoever did it enters how long it took; an agent checks planned against done",
      mustBeTrue:
        "time and budgets are on for the client projects, and reconcile on last month gives the card of the board. The card shows the proofs from the repository stand-in without links: it promises no proof link",
      provenBy: [STUDIO_FIGURES, STUDIO_REPOS],
    },
    {
      key: "companyOps.billing.*",
      claim: "invoices from milestones, retainers and checked work; Anaïs issues them",
      mustBeTrue:
        "invoice numbers run with no gap, and finance sends an issued invoice with its timesheet",
      provenBy: [STUDIO_FIGURES, "studio/money-sends.studio.integration.test.ts"],
    },
    {
      key: "companyOps.clients.*",
      claim:
        "each company holds its people, deals, money and work; client reports are drafted on Fridays",
      mustBeTrue: "the clients and their people, the pipeline, and the client reports routine",
      provenBy: [STUDIO_DESK],
    },
    {
      key: "companyOps.portal.*",
      claim: "clients see their progress, reports, invoices and requests: only what was shared",
      mustBeTrue: "the client access preview reads only the shared rows",
      provenBy: [STUDIO_AGREEMENTS],
    },
    {
      key: "companyOps.knowledge.*",
      claim:
        "a wiki of past projects and playbooks; each agent reads only what its person may open",
      mustBeTrue: "the past projects' notes and the desks' reach",
      provenBy: [STUDIO_DESK, STUDIO_FIGURES],
    },
    {
      key: "companySimulated",
      claim: "no mail leaves; the clients and their replies are stand-ins",
      mustBeTrue:
        "the client's acceptance is a stand-in that is never sealed, and its link mail is recorded, not sent",
      provenBy: [STUDIO_ACCEPTANCE],
    },
    {
      key: "teamOthers.*",
      claim: "18 others, in delivery and sales",
      mustBeTrue: "24 members: the owner, the five the door names and 18 others",
      provenBy: [STUDIO_DESK],
    },
    {
      key: "teamRole.*",
      claim: "the team the door names, each with a role",
      mustBeTrue: "each named person is a member of the pack's team",
      provenBy: [STUDIO_DESK, "world-claims.test.ts"],
    },
    {
      key: "limitConnectors",
      claim:
        "repositories and clients are stand-ins; client sign-in and signing links do not work; agreements shown as signed were not signed",
      mustBeTrue:
        "the repository stand-in answers and nothing leaves, and every signed row is a stand-in level",
      provenBy: [STUDIO_REPOS, STUDIO_AGREEMENTS],
    },
  ],
}
