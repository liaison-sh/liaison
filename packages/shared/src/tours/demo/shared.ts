// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Pieces the demo scenarios share: the copy-key helper and the scripts that
 * bring an agent into a conversation and approve what it proposes.
 */
import { approveCreatedSteps, heldRequestCard } from "../agent-steps"
import {
  RUN_CONVERSATION,
  type TourBeat,
  type TourEventBinding,
  type TourPathHop,
  type TourStep,
} from "../schema"

/** A `tours.scenarios.<need>.*` copy key. */
export const scenarioKey =
  (need: string) =>
  (path: string): string =>
    `tours.scenarios.${need}.${path}`

/**
 * Approve exactly the approval the `proposedBeat` beat recorded: the Approve
 * of any other card on screen is never pressed.
 */
export function approveProposalSteps(proposedBeat: string): TourStep[] {
  const approve = {
    testid: "approval-card-action-approve",
    created: { beat: proposedBeat, attr: "data-entity-id" },
  }
  return [{ waitFor: approve }, { click: approve }, { waitEvent: true }]
}

/** Where the person's conversation with their agent opens full screen (a phone, Chats). */
export const RUN_CONVERSATION_ROUTE = `/threads/{${RUN_CONVERSATION}}`

/** The person's own message to their agent, in their conversation with it. */
export const RUN_CONVERSATION_EVENT = {
  app: "kernel",
  entity: "message",
  action: "create",
  match: { threadType: "agent_chat", threadId: `{${RUN_CONVERSATION}}` },
} as const

/**
 * The agent proposed an approval on `toolName` in the turn answering
 * `askBeat`'s message: never an approval some other turn or tour left on
 * screen, nor another approval the same turn raised (a second write the
 * turn proposed). Web reads never raise one.
 */
export function proposedBy(askBeat: string, toolName: string): TourEventBinding {
  return {
    app: "kernel",
    entity: "approval_request",
    action: "create",
    match: { toolName },
    actor: "user-or-agent",
    causedBy: askBeat,
  }
}

/** The person approved the very approval `proposedBeat` recorded. */
export function approvedProposal(proposedBeat: string): TourEventBinding {
  return { ...APPROVED_EVENT, match: { ...APPROVED_EVENT.match }, sameEntityAs: proposedBeat }
}

/** A task the agent created in the turn answering `askBeat`'s message. */
export function taskCreatedBy(askBeat: string): TourEventBinding {
  return {
    app: "projects",
    entity: "task",
    action: "created",
    actor: "user-or-agent",
    causedBy: askBeat,
  }
}

/**
 * Work a routine (or anyone) does on what this run brought in: the event
 * `app:entity:action` whose `match` names an earlier beat's entity
 * (`{live-ticket}`). A routine acts unasked and as its own owner, so the actor
 * is not the person; the match keeps the beat to its own run.
 */
export function routineWorkOn(
  app: string,
  entity: string,
  action: string,
  match: Record<string, string>,
): TourEventBinding {
  return { app, entity, action, match, actor: "any" }
}

/** A beat the agent completes: "Do it for me" has nothing to press, it waits for the agent. */
export const WAIT_FOR_AGENT_STEPS: TourStep[] = [{ waitEvent: true }]

/** The event an approval completes on: the person approved it themselves. */
export const APPROVED_EVENT = {
  app: "kernel",
  entity: "approval_request",
  action: "update",
  match: { status: "approved" },
} as const

/**
 * The person's own message in a conversation with their agent (the one the
 * chat dock opens beside the screen, or the Chats tab on a phone).
 */
export const AGENT_CONVERSATION_EVENT = {
  app: "kernel",
  entity: "message",
  action: "create",
  match: { threadType: "agent_chat" },
} as const

/** The apps a scenario's way starts from, on the desktop rail. */
type RailApp =
  | "Home"
  | "Tickets"
  | "Projects"
  | "Chats"
  | "Mail"
  | "Agents"
  | "Shopify"
  | "Invoicing"
  | "Sessions"
  | "Knowledge"

/** The first hop of a way into another app: its entry on the left bar (ringed from the beat's route). */
export function railHop(app: RailApp): TourPathHop {
  return { label: `tours.scenarios.common.rail${app}`, rail: true }
}

/** A hop that rings `anchor` (the row, the agent to pick) until the person passed it. */
export function hop(label: string, anchor: string, anchorPhone?: string): TourPathHop {
  return anchorPhone ? { label, anchor, anchorPhone } : { label, anchor }
}

/** The last hop, once there: what to do with what the step points at. */
export function lastHop(label: string): TourPathHop {
  return { label }
}

/**
 * The person's conversation with their agent, in the dock's chats list: its
 * row at the head of the agents there (pressing it opens that one DM beside
 * the screen). On the Chats screen its own list holds the same row: the dock's
 * is the one a step rings. A phone has no dock: the Chats tab's row.
 */
export const RUN_CONVERSATION_ROW = "chats-personal-agent-row[data-in-dock=true]"
export const RUN_CONVERSATION_ROW_PHONE = "chats-personal-agent-row"

/** The composer of the person's conversation with their agent (what the step's request goes into). */
export const RUN_COMPOSER_ANCHOR = `compose-field[data-thread-id={${RUN_CONVERSATION}}]`

/**
 * The way to the person's conversation with their agent beside the screen the
 * scenario is on: Chats in the dock (`first` says beside what), the agent at
 * the head of the list, then `last` (what to do there). A phone opens it from
 * the Chats tab, full screen.
 */
export function dockToRunConversation(first: string, last: string): TourPathHop[] {
  return [
    hop(first, "dock-chats", "phone-tab-chats"),
    hop(
      "tours.scenarios.common.openRunConversation",
      RUN_CONVERSATION_ROW,
      RUN_CONVERSATION_ROW_PHONE,
    ),
    lastHop(last),
  ]
}

/** What an approve step says while the approval waits out its undo window. */
export function undoWindow(body: string) {
  return {
    title: "tours.scenarios.common.undoTitle",
    role: "tours.scenarios.common.undoRole",
    body,
  }
}

/**
 * The beat approving what the `heldBeat` write parked as (its `heldAs`): the
 * agent's conversation read outside text, or data some readers of the target
 * cannot see, so the agent asks before it writes. Played only when that write
 * was held; a write that ran at once passes it. The card is approved in the
 * person's conversation with their agent, opened from Chats in the dock
 * beside `besideRoute` (the screen the scenario is on); a phone opens it from
 * the Chats tab, full screen.
 */
export function approveHeldWrite(
  id: string,
  heldBeat: string,
  besideRoute: string,
  /** The held call's tool, when its card is not the approval card (a dispatch). */
  toolName?: string,
): TourBeat {
  return {
    id,
    kind: "do",
    title: "tours.scenarios.common.held.title",
    body: "tours.scenarios.common.held.body",
    role: "tours.scenarios.common.held.role",
    anchor: `${heldRequestCard(toolName).card}[data-request-id={${heldBeat}}]`,
    path: dockToRunConversation(
      "tours.scenarios.common.held.way1",
      "tours.scenarios.common.held.way3",
    ),
    route: besideRoute,
    routePhone: RUN_CONVERSATION_ROUTE,
    whenHeld: heldBeat,
    // The very request the held beat saw proposed, approved by the person.
    event: approvedProposal(heldBeat),
    waitsOn: "agent",
    autoplay: [{ openRunConversation: true }, ...approveCreatedSteps(heldBeat, toolName)],
    undo: undoWindow("tours.scenarios.common.held.undo"),
  }
}
