// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Demo scenario "client" (pattern: a client asks for more than was signed, the
 * agent reads the agreement, the person approves, the client answers). A
 * client's request waits on Home as one card: the reply and a change request
 * the agent drafted. The visitor asks their agent whether the request is in
 * scope (the passage and that same card, no second approval), reads the
 * agreement, approves the card, then the client approves the change request
 * (a world beat, no model spend) and the project's budget shows what moved,
 * read from the same tool the page reads.
 *
 * Played once (`singleRun`): an approved change request cannot be undone, so
 * the scenario offers Start over, never Start again.
 */
import { askAgentInRunConversation } from "../agent-steps"
import type { Tour, TourStep } from "../schema"
import {
  APPROVED_EVENT,
  dockToRunConversation,
  hop,
  RUN_COMPOSER_ANCHOR,
  RUN_CONVERSATION_EVENT,
  RUN_CONVERSATION_ROUTE,
  railHop,
  type ScenarioCfg,
  scenarioKey,
  scenarioTour,
} from "./shared"

/** What a world gives the client scenario: its copy, its change request card and its project. */
export interface ClientScenarioCfg extends ScenarioCfg {
  /** The copy namespace under `tours.scenarios` (`studioClient`). */
  copy: string
  /** The world beat's injector: the client approves the change request. */
  injector: string
  /** The title of the change request on the one card the world seeded (its approval names it). */
  cardTitle: string
  /** The project whose budget the last beat reads (`budget_get` by name). */
  projectName: string
}

/** The tool of the one card: the reply and the change request, approved together. */
export const CLIENT_CARD_TOOL = "agreements:change_request_send"

/** The tool the project's budget reads its figures from: the last beat's copy names the same. */
export const CLIENT_FIGURES_TOOL = "projects:budget_get"

const HOME_ROUTE = "/"
const AGREEMENTS_ROUTE = "/agreements"
const PROJECTS_ROUTE = "/projects"

/** The card's row on Home, by the tool it runs. */
export const CLIENT_CARD_ROW = `attention-row-*[data-tool-name=${CLIENT_CARD_TOOL}]`

/** "Do it for me": the card's row on Home, expanded, then Approve on that card. */
function approveCardInHome(): TourStep[] {
  const where = { attr: "data-tool-name", value: [CLIENT_CARD_TOOL] }
  const row = { testid: "attention-row-*", where }
  const approve = { testid: "approval-card-action-approve", where }
  return [
    { waitFor: row },
    { click: row, unlessVisible: approve },
    { waitFor: approve },
    { click: approve },
    { waitEvent: true },
  ]
}

export function buildClientTour(cfg: ClientScenarioCfg): Tour {
  const k = scenarioKey(cfg.copy)
  return scenarioTour("client", cfg, {
    app: "kernel",
    demoOnly: true,
    talksToAgent: true,
    title: k("title"),
    summary: k("summary"),
    requires: { apps: ["agreements", "mail", "projects"] },
    beats: [
      {
        id: "more-than-signed",
        kind: "show",
        title: k("moreThanSigned.title"),
        body: k("moreThanSigned.body"),
        role: k("moreThanSigned.role"),
        anchor: CLIENT_CARD_ROW,
        path: [railHop("Home")],
        route: HOME_ROUTE,
      },
      {
        id: "read-scope",
        kind: "do",
        title: k("readScope.title"),
        body: k("readScope.body"),
        role: k("readScope.role"),
        anchor: RUN_COMPOSER_ANCHOR,
        path: dockToRunConversation(k("readScope.way1"), "tours.scenarios.common.sendBelow"),
        say: { lead: k("readScope.say"), text: k("readScope.text") },
        route: HOME_ROUTE,
        event: RUN_CONVERSATION_EVENT,
        autoplay: askAgentInRunConversation(k("readScope.text")),
      },
      {
        // The answer of the turn this run's question started: the passage, and the one card
        // already waiting (no second approval). Next stays off while the agent answers.
        id: "open-agreement",
        kind: "show",
        title: k("openAgreement.title"),
        body: k("openAgreement.body"),
        role: k("openAgreement.role"),
        anchor: "agent-answer[data-turn-id={read-scope}]",
        path: dockToRunConversation(k("readScope.way1"), k("openAgreement.way3")),
        route: HOME_ROUTE,
        routePhone: RUN_CONVERSATION_ROUTE,
        waitsOn: "agent",
      },
      {
        // The one card, approved on Home: the reply leaves and the change request's link is
        // made. A card the visitor rejects does not complete it.
        id: "approve-cr",
        kind: "do",
        title: k("approveCr.title"),
        body: k("approveCr.body"),
        role: k("approveCr.role"),
        anchor: `approval-card-action-approve[data-tool-name=${CLIENT_CARD_TOOL}]`,
        path: [railHop("Home"), hop(k("approveCr.way2"), CLIENT_CARD_ROW)],
        route: HOME_ROUTE,
        event: {
          ...APPROVED_EVENT,
          match: {
            ...APPROVED_EVENT.match,
            toolName: CLIENT_CARD_TOOL,
            "currentPayload.title": cfg.cardTitle,
          },
        },
        autoplay: approveCardInHome(),
      },
      {
        // The client approves the change request on her link: the app hears it as it would.
        // Nothing here spends on a model.
        id: "client-decides",
        kind: "world",
        title: k("clientDecides.title"),
        body: k("clientDecides.body"),
        role: k("clientDecides.role"),
        injector: cfg.injector,
        anchor: "agreements-list",
        path: [hop(k("clientDecides.way1"), "agreements-list")],
        route: AGREEMENTS_ROUTE,
      },
      {
        // What moved: its copy names the project's hours as the budget reads them now.
        id: "what-moved",
        kind: "show",
        title: k("whatMoved.title"),
        body: k("whatMoved.body"),
        role: k("whatMoved.role"),
        anchor: "budget-line",
        path: [hop(k("whatMoved.way1"), "projects-home")],
        route: PROJECTS_ROUTE,
        figures: {
          tool: CLIENT_FIGURES_TOOL,
          params: { projectName: cfg.projectName },
          vars: {
            timebox: { kind: "hours", path: "timebox" },
            left: { kind: "hours", path: "left" },
          },
        },
      },
    ],
  })
}
