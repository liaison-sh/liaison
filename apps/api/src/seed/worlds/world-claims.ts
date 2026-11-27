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
  /** The test files that prove it, relative to `seed/worlds/`, the api's `src/` or the repository root. */
  provenBy: readonly string[]
}

/**
 * Door strings that make no claim about the world's rows (the frame around the
 * claims: who the visitor is, that it is an example). Listed so the meta test
 * can tell a deliberate frame from a forgotten claim.
 */
export const DOOR_FRAME_KEYS: Readonly<Partial<Record<DemoWorldId, readonly string[]>>> = {
  saas: ["companyFacts", "companyExample", "companyYou"],
  studio: ["companyExample", "companyYou"],
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

/** The software world's tours, from the repository root: what each pick's moment says it shows. */
const SAAS_TOURS = [
  "packages/shared/src/tours/demo/worlds/saas/saas-tours.test.ts",
  "packages/shared/src/tours/demo/worlds/saas/money-tour.test.ts",
]
/** The services world's tours, from the repository root. */
const STUDIO_TOURS = [
  "packages/shared/src/tours/demo/worlds/studio/studio-tours.test.ts",
  "packages/shared/src/tours/demo/worlds/studio/client-tour.test.ts",
]

export const WORLD_CLAIMS: Readonly<Partial<Record<DemoWorldId, readonly WorldClaim[]>>> = {
  saas: [
    {
      key: "companyAbout",
      claim: "169 customers pay by card",
      mustBeTrue: "the MRR query's active count is 169",
      provenBy: [READS, "world-claims.test.ts"],
    },
    {
      key: "companyAbout",
      claim: "sold by subscription from €149 to €1,450 a month",
      mustBeTrue: "the plans' monthly prices",
      provenBy: ["saas/plan-invariants.test.ts", "world-claims.test.ts"],
    },
    {
      key: "pickMoment.*",
      claim: "one moment of each pick's tour, in the words of the tour's own beats",
      mustBeTrue:
        "each tour plays that moment: the reply draft approved, the breakdown, the cited page, the one request, the failed card's note, the pull request and its reply, the restricted policy",
      provenBy: SAAS_TOURS,
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
      key: "companySimulated",
      claim: "no mail leaves; the clients and their replies are stand-ins",
      mustBeTrue:
        "the client's acceptance is a stand-in that is never sealed, and its link mail is recorded, not sent",
      provenBy: [STUDIO_ACCEPTANCE],
    },
    {
      key: "pickMoment.*",
      claim: "one moment of each pick's tour, in the words of the tour's own beats",
      mustBeTrue:
        "each tour plays that moment: the routine's note and reply, the breakdown and the weekly report, the cited page, the proposal with no price, the agreement check and change request, the pull request and its reply, the restricted costs",
      provenBy: STUDIO_TOURS,
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
