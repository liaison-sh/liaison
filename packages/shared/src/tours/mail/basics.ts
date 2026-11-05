// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Mail, agent first: open a conversation, ask your agent (from the chat dock,
 * beside it) to summarise the thread and draft a reply, review and approve
 * the draft, then who the sender is and where you can still write yourself.
 *
 * Nothing reaches the correspondent without the person's approval: the
 * agent's reply is a gated draft, and "Do it for me" presses Approve only on
 * the approve beat (the person chose it), only on the draft this run's agent
 * made. The agent is asked in the person's conversation with it, opened in
 * the dock beside the mail (`talksToAgent`).
 */
import {
  approveCreatedSteps,
  askAgentInRunConversation,
  draftApprovedEvent,
  draftCreatedEvent,
} from "../agent-steps"
import { defineTour } from "../schema"

const k = (path: string) => `tours.mail.basics.${path}`

const REPLY_TOOL = "mail:reply"

/** A conversation row still unread (`data-unread`): waiting for someone, not answered. */
const UNREAD = { attr: "data-unread", value: "true" } as const

export const mailBasicsTour = defineTour({
  id: "mail.basics",
  app: "mail",
  title: k("title"),
  summary: k("summary"),
  talksToAgent: true,
  beats: [
    {
      id: "inbox",
      kind: "show",
      title: k("inbox.title"),
      body: k("inbox.body"),
      anchor: "mail-inbox",
      route: "/mail",
    },
    {
      id: "open",
      kind: "show",
      title: k("open.title"),
      body: k("open.body"),
      anchor: "conversation-row",
      route: "/mail",
    },
    {
      id: "summarise-draft",
      kind: "do",
      title: k("summariseDraft.title"),
      body: k("summariseDraft.body"),
      anchor: "dock-chats",
      anchorPhone: "phone-tab-chats",
      // Its script starts from the mail list: played from another screen, it goes there first.
      route: "/mail",
      event: draftCreatedEvent(REPLY_TOOL),
      // From the list (the scenario playing on), open the newest conversation
      // first: the agent reads the conversation behind the dock. Phone has no
      // dock beside it, so the person asks from Chats.
      autoplay: [
        // An unread conversation first: one a routine already answered is not the one to draft for.
        { click: "conversation-row", unlessVisible: "mail-reply-bar", prefer: UNREAD },
        { waitFor: "mail-reply-bar" },
        ...askAgentInRunConversation(k("summariseDraft.text")),
      ],
      // Phone: the request names the conversation (the newest, the one the
      // script opened): the agent no longer sees the screen the person left.
      autoplayPhone: [
        { click: "conversation-row", unlessVisible: "mail-action-bar", prefer: UNREAD },
        { waitFor: "mail-action-bar" },
        ...askAgentInRunConversation(k("summariseDraft.phoneText")),
      ],
    },
    {
      id: "approve",
      kind: "do",
      title: k("approve.title"),
      body: k("approve.body"),
      // The draft's own card, wherever it is on screen: in the conversation
      // the ask opened, or under the agent's answer in the person's conversation with it.
      anchor: "approval-card[data-request-id={summarise-draft}]",
      // Asked from the Chats tab, a phone is no longer on the conversation
      // (walk D31): it approves the draft from the approvals screen.
      anchorPhone: "approvals-screen",
      routePhone: "/approvals",
      event: draftApprovedEvent(REPLY_TOOL),
      // The draft's card comes with the agent's message, which may still be writing.
      waitsOn: "agent",
      // Resumed elsewhere (a reload lands on Home, walk D69), the conversation
      // the ask opened is not on screen: the person's conversation with the
      // agent, opened beside the screen, holds the same card under its answer.
      autoplay: [{ openRunConversation: true }, ...approveCreatedSteps("summarise-draft")],
      autoplayPhone: approveCreatedSteps("summarise-draft"),
    },
    {
      id: "crm",
      kind: "show",
      title: k("crm.title"),
      body: k("crm.body"),
      anchor: "customer-card",
      // Only where a connection fills the customer lookup.
      optional: { whenFeature: "customer-card" },
    },
    {
      id: "yourself",
      kind: "show",
      title: k("yourself.title"),
      body: k("yourself.body"),
      anchor: "mail-reply-bar",
      // Phone: the conversation's bottom bar opens the reply sheet.
      anchorPhone: "mail-action-bar",
    },
  ],
})
