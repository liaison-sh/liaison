// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The services world's developer scenario: a client's reported bug becomes a
 * fix in that client's repository on the recorded laptop, then the agent
 * drafts the reply that tells the client, behind an approval. The ticket, the fix and the client told are
 * one thread: the recorded session fixes the bug the client reported.
 */
import { askAgentInRunConversation } from "../../../agent-steps"
import { buildDevTour, type DevScenarioCfg } from "../../dev"
import {
  approvedProposal,
  approveProposalSteps,
  dockToRunConversation,
  proposedBy,
  RUN_COMPOSER_ANCHOR,
  RUN_CONVERSATION_EVENT,
  RUN_CONVERSATION_ROUTE,
  scenarioKey,
  undoWindow,
  WAIT_FOR_AGENT_STEPS,
} from "../../shared"

const k = scenarioKey("studioDev")

/** The team channel where the developers talk about client issues (the seed writes it). */
export const STUDIO_BUGS_CHANNEL_TITLE = "Delivery"

/** The tool the agent drafts the client's reply with. */
export const STUDIO_TELL_TOOL = "tickets:reply"

/** The finished session's page, where the beats after the report still stand. */
const SESSION_ROUTE = "/sessions/{dispatch}"

const toAgent = (last: string) => dockToRunConversation(k("askTell.way1"), last)

export const STUDIO_DEV_CFG: DevScenarioCfg = {
  world: "studio",
  copy: "studioDev",
  bugsChannelTitle: STUDIO_BUGS_CHANNEL_TITLE,
  minutes: 3,
  extraBeats: [
    {
      after: "report",
      beat: {
        id: "ask-tell",
        kind: "do",
        title: k("askTell.title"),
        body: k("askTell.body"),
        role: k("askTell.role"),
        anchor: RUN_COMPOSER_ANCHOR,
        path: toAgent("tours.scenarios.common.sendBelow"),
        say: { lead: k("askTell.say"), text: k("askTell.text") },
        route: SESSION_ROUTE,
        routePhone: RUN_CONVERSATION_ROUTE,
        event: RUN_CONVERSATION_EVENT,
        autoplay: askAgentInRunConversation(k("askTell.text")),
      },
    },
    {
      after: "ask-tell",
      beat: {
        id: "reply-draft",
        kind: "do",
        title: k("replyDraft.title"),
        body: k("replyDraft.body"),
        role: k("replyDraft.role"),
        // The card the turn answering this run's request raised, in the dock beside the session.
        anchor: "approval-card[data-turn-id={ask-tell}]",
        path: toAgent(k("replyDraft.way3")),
        route: SESSION_ROUTE,
        routePhone: RUN_CONVERSATION_ROUTE,
        // The approval the agent's answer to that message proposed, nothing else.
        event: proposedBy("ask-tell", STUDIO_TELL_TOOL),
        autoplay: [{ openRunConversation: true }, ...WAIT_FOR_AGENT_STEPS],
      },
    },
    {
      after: "reply-draft",
      beat: {
        id: "approve-reply",
        kind: "do",
        title: k("approveReply.title"),
        body: k("approveReply.body"),
        role: k("approveReply.role"),
        // The very approval the reply-draft beat saw proposed, by its id.
        anchor: "approval-card[data-request-id={reply-draft}]",
        path: toAgent("tours.scenarios.common.held.way3"),
        route: SESSION_ROUTE,
        routePhone: RUN_CONVERSATION_ROUTE,
        event: approvedProposal("reply-draft"),
        waitsOn: "agent",
        autoplay: [{ openRunConversation: true }, ...approveProposalSteps("reply-draft")],
        undo: undoWindow(k("approveReply.undo")),
      },
    },
  ],
}

export const scenarioStudioDevTour = buildDevTour(STUDIO_DEV_CFG)
