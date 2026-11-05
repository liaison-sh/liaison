// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Demo scenario "knowledge" (pattern: one knowledge base, every document
 * keeping its own access, and an agent that reads with the access of the
 * person asking it). The visitor sees the three sources (manuals synced from
 * GitLab, finance synced from Google Drive, a playbook written in Liaison),
 * opens the Q3 P&L, sees who it is shared with, and asks their own agent, from
 * Chats in the dock beside the P&L, a question that needs the P&L and the
 * manual. Then Lucas, from support, asks Support Desk the same question in
 * #support: the agent runs as Lucas, and the database gives it nothing he
 * could not open himself.
 */
import { askAgentInRunConversation } from "../agent-steps"
import { defineTour } from "../schema"
import {
  dockToRunConversation,
  hop,
  lastHop,
  RUN_COMPOSER_ANCHOR,
  RUN_CONVERSATION_EVENT,
  railHop,
  scenarioKey,
  WAIT_FOR_AGENT_STEPS,
} from "./shared"

const k = scenarioKey("knowledge")

/** The seeded Q3 P&L (synced from the Finance folder in Google Drive), by its title. */
export const KNOWLEDGE_SCENARIO_PL_TITLE = "Q3 2026 P&L"

/** The P&L's row in the Knowledge home's recent documents. */
const PL_RECENT_ROW = {
  testid: "knowledge-recent-*",
  where: { attr: "data-doc-title", value: KNOWLEDGE_SCENARIO_PL_TITLE },
} as const

export const scenarioKnowledgeTour = defineTour({
  id: "kernel.scenario-knowledge",
  app: "kernel",
  demoOnly: true,
  // The question goes to the visitor's agent, in their one conversation with it.
  talksToAgent: true,
  title: k("title"),
  summary: k("summary"),
  beats: [
    {
      id: "sources",
      kind: "show",
      title: k("sources.title"),
      body: k("sources.body"),
      role: k("sources.role"),
      anchor: "knowledge-sidebar",
      // A phone has no sidebar: the Knowledge home lists the collections.
      anchorPhone: "knowledge-home",
      path: [railHop("Knowledge"), lastHop(k("sources.way2"))],
      route: "/knowledge",
    },
    {
      id: "open-pl",
      kind: "show",
      title: k("openPl.title"),
      body: k("openPl.body"),
      role: k("openPl.role"),
      anchor: `knowledge-document-view[data-doc-title=${KNOWLEDGE_SCENARIO_PL_TITLE}]`,
      path: [
        hop(k("openPl.way1"), `knowledge-recent-*[data-doc-title=${KNOWLEDGE_SCENARIO_PL_TITLE}]`),
        lastHop(k("openPl.way2")),
      ],
      route: "/knowledge",
      // Play all and Take me there open it from the recent documents.
      reach: [{ click: PL_RECENT_ROW }],
    },
    {
      id: "share",
      kind: "show",
      title: k("share.title"),
      body: k("share.body"),
      role: k("share.role"),
      anchor: "knowledge-share-dialog",
      path: [hop(k("share.way1"), "knowledge-share-button"), lastHop(k("share.way2"))],
      route: "/knowledge",
      // Play all and Take me there press Share on the P&L, opening it again from
      // the recent documents when the step's route left it.
      reach: [
        { click: PL_RECENT_ROW, unlessVisible: "knowledge-share-button" },
        { click: "knowledge-share-button" },
      ],
    },
    {
      id: "ask-agent",
      kind: "do",
      title: k("askAgent.title"),
      body: k("askAgent.body"),
      role: k("askAgent.role"),
      // The visitor's conversation with their agent, opened from the dock's
      // Chats beside the P&L (the agent reads the document behind the dock);
      // a phone opens it from the Chats tab.
      anchor: RUN_COMPOSER_ANCHOR,
      path: dockToRunConversation(k("askAgent.way1"), "tours.scenarios.common.sendBelow"),
      say: { lead: k("askAgent.say"), text: k("askAgent.text") },
      route: "/knowledge",
      event: RUN_CONVERSATION_EVENT,
      autoplay: askAgentInRunConversation(k("askAgent.text")),
    },
    {
      id: "answer",
      kind: "show",
      title: k("answer.title"),
      body: k("answer.body"),
      role: k("answer.role"),
      // The answer of the turn this run's question started, in the dock beside
      // the P&L: the scenario does not move on to Lucas before it is read.
      anchor: "agent-answer[data-turn-id={ask-agent}]",
      path: dockToRunConversation(k("askAgent.way1"), k("answer.way3")),
      route: "/knowledge",
      // Next stays off while the agent is still answering.
      waitsOn: "agent",
    },
    {
      // Lucas asks Support Desk in #support; the agent's turn runs as him.
      id: "lucas-asks",
      kind: "world",
      title: k("lucasAsks.title"),
      body: k("lucasAsks.body"),
      role: k("lucasAsks.role"),
      injector: "knowledge-lucas-asks",
      // Where it lands: that stays bright while the rest dims.
      anchor: "activity-messages",
      anchorPhone: "phone-tab-chats",
      path: [railHop("Chats")],
      route: "/chats",
    },
    {
      // Support Desk's answer to Lucas, in #support: read, then Next.
      id: "lucas-answer",
      kind: "do",
      title: k("lucasAnswer.title"),
      body: k("lucasAnswer.body"),
      role: k("lucasAnswer.role"),
      anchor: "message-scroll-container",
      path: [
        railHop("Chats"),
        hop(
          k("lucasAnswer.way2"),
          // The channel in the desktop sidebar; on a phone, its row on the Chats tab.
          "thread-item[data-thread-id={lucas-asks}]",
          "chat-row[data-thread-id={lucas-asks}]",
        ),
        lastHop(k("lucasAnswer.way3")),
      ],
      route: "/threads/{lucas-asks}",
      // Support Desk's answer to Lucas in #support. Lucas's turn, not the
      // visitor's: any actor, kept to this run's channel. Only the reply to
      // the person who asked has no parent message: Support Desk asking
      // another agent (and that agent's answer) nests under the turn that
      // asked, and must not end the beat before Lucas has his answer. Support
      // Desk may give up waiting on the agent it asked and reply first ("I've
      // passed this on"): the beat completes once every turn in #support has
      // ended, so the last message there is the answer.
      event: {
        app: "kernel",
        entity: "message",
        action: "create",
        match: { threadId: "{lucas-asks}", authorType: "agent", parentMessageId: null },
        actor: "any",
        turnsEnded: true,
      },
      waitsOn: "agent",
      autoplay: WAIT_FOR_AGENT_STEPS,
    },
    {
      id: "done",
      kind: "show",
      title: k("done.title"),
      body: k("done.body"),
      role: k("done.role"),
    },
  ],
})
