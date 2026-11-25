// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The services world's sales scenario: a prospect's brief arrives by mail; the
 * routine reads up on them, then prepares one request: the company, the deal,
 * a proposal drafted on the statement of work template with no price, and the
 * reply. The visitor approves it once, then sets the proposal's price
 * themselves: no agent sets a price.
 */
import { buildSalesTour, type SalesScenarioCfg } from "../../sales"
import { hop, lastHop, scenarioKey } from "../../shared"

/** The injector of the scenario's world beat (`modules/demo/worlds/studio/sales-email.ts`). */
export const STUDIO_SALES_EMAIL_INJECTOR = "studio-sales-email"

/** The routine the visitor switches on: it prepares a proposal for a new brief. */
export const STUDIO_PROSPECT_ROUTINE_NAME = "Prepare proposals for new briefs"

/** The request's first step: the company, written natively. */
export const STUDIO_COMPANY_WRITE_TOOL = "kernel:companies_write"

/** The proposal draft the request holds: the agreements app's create, which never sets a price. */
export const STUDIO_PROPOSAL_TOOL = "agreements:agreement_create"

/** Where the person sets the price: the proposal's own price panel, a person's action only. */
export const STUDIO_PRICE_SET = "agreement-price-set"

const k = scenarioKey("studioSales")

export const STUDIO_SALES_CFG: SalesScenarioCfg = {
  world: "studio",
  copy: "studioSales",
  injector: STUDIO_SALES_EMAIL_INJECTOR,
  prospectRoutineName: STUDIO_PROSPECT_ROUTINE_NAME,
  // The company heads the one request; when the run asked for the company
  // first and carried on after its approval, the proposal heads the rest.
  bundleHeadTools: [STUDIO_COMPANY_WRITE_TOOL, STUDIO_PROPOSAL_TOOL],
  minutes: 4,
  extraBeats: [
    {
      after: "card",
      beat: {
        // The price is the person's: the proposal waits for it, and Set price is theirs to press.
        id: "set-price",
        kind: "do",
        title: k("setPrice.title"),
        body: k("setPrice.body"),
        role: k("setPrice.role"),
        anchor: STUDIO_PRICE_SET,
        path: [
          hop(k("setPrice.way1"), "agreements-list"),
          hop(k("setPrice.way2"), "agreement-price-panel"),
          lastHop(k("setPrice.way3")),
        ],
        route: "/agreements",
        // The person's own change to the proposal, never an agent's.
        event: { app: "agreements", entity: "agreement", action: "updated", actor: "user" },
        autoplay: [{ waitFor: STUDIO_PRICE_SET }, { waitEvent: true }],
      },
    },
  ],
}

export const scenarioStudioSalesTour = buildSalesTour(STUDIO_SALES_CFG)
