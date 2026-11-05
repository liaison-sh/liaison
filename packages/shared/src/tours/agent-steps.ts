// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Steps the agent-first tours share: ask the person's own agent from the chat
 * dock (beside the screen they are on, which the agent is told about), and
 * approve what that agent proposed.
 *
 * Guards: the request is sent only into the person's own agent conversation
 * (`compose-field` carries `data-personal-agent="true"` there), never into a
 * conversation with colleagues; and the approve step presses Approve only on
 * the approval request an earlier beat of the same run created.
 */
import { RUN_CONVERSATION, type TourEventBinding, type TourStep } from "./schema"

/** The composer of the person's conversation with their agent: never another conversation's on screen. */
export const RUN_COMPOSER = {
  testid: "compose-field",
  created: { beat: RUN_CONVERSATION, attr: "data-thread-id" },
} as const

/**
 * Ask the person's own agent in their conversation with it (the tour's
 * `talksToAgent`), opened beside the screen the person is on (the chat
 * dock; a phone opens it full screen), and send `text`. The agent reads the
 * screen behind the dock. The typing goes only into that conversation's
 * composer, never into another one on screen.
 */
export function askAgentInRunConversation(text: string): TourStep[] {
  return [
    { openRunConversation: true },
    { waitFor: RUN_COMPOSER },
    { type: { testid: RUN_COMPOSER.testid, text, created: RUN_COMPOSER.created } },
    { waitFor: RUN_COMPOSER },
    // That conversation's own Send: a channel or task beside the dock has one too.
    { click: { testid: "compose-send", created: RUN_COMPOSER.created } },
    { waitEvent: true },
  ]
}

/**
 * The person's own agent conversation's composer and Send: typing and the
 * press go only there, never into a conversation with colleagues on the
 * screen behind the dock.
 */
const PERSONAL = { attr: "data-personal-agent", value: "true" } as const
/** The person's agent's row in the dock's chats list. */
const DOCK_AGENT_ROW = {
  testid: "chats-personal-agent-row",
  where: { attr: "data-in-dock", value: "true" },
} as const
const PERSONAL_COMPOSER = { testid: "compose-field", where: PERSONAL } as const
const PERSONAL_SEND = { testid: "compose-send", where: PERSONAL } as const

/**
 * Open the person's agent conversation from the dock (desktop: the Chats item,
 * then the agent at the head of the list), type `text` (a `tours.*` copy key)
 * and send it. The agent reads the screen behind the dock (the open ticket or
 * conversation), so the request can say "this customer".
 */
export function askAgentInDock(text: string): TourStep[] {
  return [
    { click: "dock-chats", unlessVisible: DOCK_AGENT_ROW },
    // The dock's row: on the Chats screen its own list has one too.
    { click: DOCK_AGENT_ROW },
    { waitFor: PERSONAL_COMPOSER },
    { type: { testid: PERSONAL_COMPOSER.testid, text, where: PERSONAL } },
    // Its own Send: the screen behind the dock may have a composer too.
    { click: PERSONAL_SEND },
    { waitEvent: true },
  ]
}

/**
 * The phone path of `askAgentInDock`: a phone has no dock beside the screen,
 * so the person opens their agent from the Chats tab of the bottom bar, then
 * types and sends the same way. The agent no longer sees the screen the
 * person left, so `text` names what the request is about.
 */
export function askAgentFromChatsTab(text: string): TourStep[] {
  return [
    { click: "phone-tab-chats", unlessVisible: "chats-personal-agent-row" },
    { click: "chats-personal-agent-row" },
    { waitFor: PERSONAL_COMPOSER },
    { type: { testid: PERSONAL_COMPOSER.testid, text, where: PERSONAL } },
    // Its own Send: the screen behind the dock may have a composer too.
    { click: PERSONAL_SEND },
    { waitEvent: true },
  ]
}

/** A held `run_on_my_computer` call: a conversation shows it as its own dispatch card. */
const DISPATCH_TOOL = "kernel:run_on_my_computer"

/**
 * The card a held request of `toolName` shows as in a conversation (pinned by
 * `data-request-id`), and its Approve (pinned by `data-entity-id`): a dispatch
 * has its own card (NodeDispatchApprovalCard), anything else the approval card.
 */
export function heldRequestCard(toolName?: string | null): { card: string; approve: string } {
  return toolName === DISPATCH_TOOL
    ? { card: "node-dispatch-approval", approve: "node-dispatch-approval-approve" }
    : { card: "approval-card", approve: "approval-card-action-approve" }
}

/**
 * Press Approve on the approval request `beat` created (its event's entity),
 * on the card a request of `toolName` shows as, wherever it is on screen. When
 * that beat recorded none (skipped), the step refuses: "Do it for me" never
 * approves anything else.
 */
export function approveCreatedSteps(beat: string, toolName?: string): TourStep[] {
  const approve = {
    testid: heldRequestCard(toolName).approve,
    created: { beat, attr: "data-entity-id" },
  } as const
  return [{ waitFor: approve }, { click: approve }, { waitEvent: true }]
}

/** An agent's gated call to `toolName` parked its approval request (the requester is the person). */
export function draftCreatedEvent(toolName: string): TourEventBinding {
  return {
    app: "kernel",
    entity: "approval_request",
    action: "create",
    match: { toolName },
    actor: "user-or-agent",
  }
}

/** The person approved the request for `toolName` themselves. */
export function draftApprovedEvent(toolName: string): TourEventBinding {
  return {
    app: "kernel",
    entity: "approval_request",
    action: "update",
    match: { status: "approved", toolName },
  }
}
