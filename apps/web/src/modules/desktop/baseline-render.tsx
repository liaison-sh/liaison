// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The render helper behind the pre slice browser baseline (P6d-T01) and behind
// the feature detection proof that asserts against it (P6d-T17). One helper,
// imported by both, because a second one would drift and the baseline would
// then be pinning the helper rather than the app.
//
// What it does: renders each host surface this slice touches, with no desktop
// bridge on the window, and serializes what came out into a stable outline.
// A browser has no bridge and therefore no desktop UI, so every one of these
// outlines must be byte identical before and after the slice.
//
// A class string match is a REGRESSION PIN, not evidence of what a human sees.
// The picture proof is P6d-T19's driven walk. This file exists so that a
// desktop surface leaking into the browser render is loud and cheap to catch.
import { Route, Router } from "@solidjs/router"
import { render } from "@solidjs/testing-library"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { WsProvider } from "~/modules/shell/WsContext"
import { resetMessageStore } from "~/modules/threads/message-store"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"

/**
 * The host surfaces A33 names, in the order the baseline records them.
 *
 * P4c-T17 retired the agent panel and its composer, which were two of them.
 * The surface that replaces both is the dock's `conversation-tab`: the same
 * ThreadView and the same ComposeBar the rest of the app talks in, which is
 * the point of retiring the panel. `model-selector` is rendered on its own
 * because the control now has no host surface of its own and P6d-T10's
 * replacement claim (a locked pill in a browser, the app's model menu on a
 * desktop) is still worth pinning.
 */
export const BASELINE_SURFACES = [
  "thread-header",
  "thread-composer",
  "conversation-tab",
  "model-selector",
  "login",
] as const

export type BaselineSurface = (typeof BASELINE_SURFACES)[number]

// Attributes worth pinning. Everything else is either volatile (Kobalte's
// generated ids, aria-controls pointing at them) or noise.
const PINNED_ATTRIBUTES = [
  "class",
  "role",
  "type",
  "data-testid",
  "aria-label",
  "aria-hidden",
  "placeholder",
  "title",
  "disabled",
  "contenteditable",
]

function directText(element: Element): string {
  let text = ""
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === 3) text += node.textContent ?? ""
  }
  return text.replace(/\s+/g, " ").trim()
}

function describeElement(element: Element, depth: number): string {
  const parts = [`${"  ".repeat(depth)}<${element.tagName.toLowerCase()}`]
  for (const name of PINNED_ATTRIBUTES) {
    const value = element.getAttribute(name)
    if (value === null) continue
    parts.push(` ${name}="${value.replace(/\s+/g, " ").trim()}"`)
  }
  parts.push(">")
  const text = directText(element)
  if (text.length > 0) parts.push(` ${JSON.stringify(text)}`)
  return parts.join("")
}

/**
 * A stable outline of a rendered surface: one line per element, pinned
 * attributes and direct text only. Deterministic across runs: nothing here
 * reads a generated id, a timestamp or a measured size.
 */
export function serializeSurface(container: HTMLElement): string {
  const lines: string[] = []
  const walk = (element: Element, depth: number) => {
    lines.push(describeElement(element, depth))
    for (const child of Array.from(element.children)) walk(child, depth + 1)
  }
  for (const child of Array.from(container.children)) walk(child, 0)
  return lines.join("\n")
}

/** Asserts the precondition every baseline render depends on. */
export function assertNoBridge(): void {
  const bridge = (globalThis as Record<string, unknown>).__LIAISON_DESKTOP__
  if (bridge !== undefined) {
    throw new Error("baseline render requires a window with no desktop bridge on it")
  }
}

function inApp(component: () => unknown) {
  return render(() => (
    <Router>
      <Route path="/*" component={() => <ApiProvider>{component() as never}</ApiProvider>} />
    </Router>
  ))
}

/** The dock's own host: ThreadView reads WsContext, so a dock tab needs one. */
function inDock(component: () => unknown) {
  const status = () => "connected" as const
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <WsProvider send={() => {}} status={status}>
            <ApiProvider>{component() as never}</ApiProvider>
          </WsProvider>
        )}
      />
    </Router>
  ))
}

const noop = () => {}

export function threadHeaderProps() {
  return {
    threadId: "baseline-thread",
    title: "Baseline thread",
    handle: "@baseline-thread",
    participants: [
      { id: "creator", name: "Creator", avatarUrl: null },
      { id: "member", name: "Member", avatarUrl: null },
    ],
    isPinned: false,
    isPinnedByUser: false,
    isMuted: false,
    isArchived: false,
    currentUserId: "member",
    createdBy: "creator",
    canAdminThreads: false,
    onTogglePin: noop,
    onTogglePinForAll: noop,
    onToggleMute: noop,
    onArchive: noop,
    onLeave: noop,
    onAddParticipant: (_id: string, _name: string, _url: string | null) => {},
    onRemoveParticipant: noop,
  }
}

/**
 * THE SAME SURFACES, WITH AN IDENTITY (P6d-FX2, SK-9).
 *
 * The committed baseline's props carry no conversation: the thread header has
 * two human participants and no agent seat, and neither composer is given a
 * thread id, so three of this slice's controls are gated off under it and the
 * gate that reads "a browser sees the app it saw before this slice" never
 * covers them. These props are the other half: one agent seat and a thread id
 * on every surface that takes one, so RuntimeControl, the permission mode menu
 * and the runtime badge are all reachable. There is no committed snapshot for
 * them (a pre slice one cannot be captured now): the browser render of THESE
 * props, taken in the same run, is the baseline they are compared to.
 */
export const IDENTITY_SURFACES = ["thread-header", "thread-composer", "conversation-tab"] as const

/** The agent seat those props carry, and the session the desktop half runs. */
export const IDENTITY_AGENT_ID = "baseline-agent"
export const IDENTITY_THREAD_ID = "baseline-thread"

export function identityThreadHeaderProps() {
  const base = threadHeaderProps()
  return {
    ...base,
    // A DM with an agent, as the sidebar shows it: since 2026-10-12 a titled
    // conversation of one person and one agent that is not an agent_chat is a
    // channel, and a channel never offers the runtime control.
    threadType: "agent_chat",
    participants: [
      { id: "member", name: "Member", avatarUrl: null, participantType: "user" as const },
      {
        id: "agent-seat",
        name: "Liaison",
        avatarUrl: null,
        participantType: "agent" as const,
        agentId: IDENTITY_AGENT_ID,
      },
    ],
  }
}

export function modelSelectorProps() {
  return {
    // A LOCKED ORG IS A KNOWN EMPTY BALANCE, not an unknown one. `null` used to
    // stand in for it, and a null balance is simply the balance not having
    // landed yet: that reading is what made the model control a dead pill in a
    // perfectly ordinary session. The surface this baseline wants is still the
    // locked one, so it says so with the numbers.
    balance: { included: "0", purchased: "0", currency: "EUR", tier: "starter" },
    selectedModelId: null,
    onSelect: noop,
  }
}

/** The dock tab the `conversation-tab` surface renders (dock-store's DockTab). */
export function conversationTabProps() {
  return {
    tab: {
      threadId: IDENTITY_THREAD_ID,
      expanded: true,
      openedAt: 1,
      lastActiveAt: 1,
    },
  }
}

/**
 * A dock tab reads its conversation from the thread store, and ThreadView
 * renders an empty state without one. So the surface seeds the row it is the
 * view of: two humans by default, one human and one agent seat under
 * `identity`, matching the two halves the thread header renders.
 */
function seedConversation(identity: boolean): void {
  resetThreadStore()
  // A thread whose messages a previous render (or a retried attempt) loaded skips the
  // "Loading messages..." first paint the baseline was taken with.
  resetMessageStore()
  addThread({
    id: IDENTITY_THREAD_ID,
    handle: "baseline-thread",
    title: "Baseline thread",
    isPinned: false,
    ...(identity ? { type: "agent_chat" } : {}),
    participants: identity
      ? [
          { id: "member", name: "Member", avatarUrl: null, participantType: "user" as const },
          {
            id: "agent-seat",
            name: "Liaison",
            avatarUrl: null,
            participantType: "agent" as const,
            agentId: IDENTITY_AGENT_ID,
          },
        ]
      : [
          { id: "member", name: "Member", avatarUrl: null, participantType: "user" as const },
          { id: "creator", name: "Creator", avatarUrl: null, participantType: "user" as const },
        ],
  } as never)
}

/**
 * Renders one host surface and returns its outline. The caller supplies the
 * components, because the mocks the agent panel needs must be declared in the
 * test file that owns the module registry (vi.mock is per file, not per
 * import).
 */
export async function renderBaselineSurface(
  surface: BaselineSurface,
  components: {
    ThreadHeader: (props: never) => unknown
    ComposeBar: (props: never) => unknown
    ConversationTab: (props: never) => unknown
    ModelSelector: (props: never) => unknown
    Login: () => unknown
  },
  options: { allowBridge?: boolean; identity?: boolean } = {},
): Promise<string> {
  // The baseline half of every caller renders with NO bridge and says so by
  // leaving this alone. P6d-T17's desktop half renders the same surfaces with
  // one, and is the only caller that opts out of the check: it is comparing
  // the two renders, so it needs both.
  if (!options.allowBridge) assertNoBridge()
  let container: HTMLElement
  // `identity` swaps in props that carry a conversation and an agent seat. The
  // default is untouched, because the committed baseline was taken with it.
  const identity = options.identity === true
  switch (surface) {
    case "thread-header":
      container = inApp(() =>
        components.ThreadHeader(
          (identity ? identityThreadHeaderProps() : threadHeaderProps()) as never,
        ),
      ).container
      break
    case "thread-composer":
      container = inApp(() =>
        components.ComposeBar({
          onSend: noop,
          onTyping: noop,
          ...(identity ? { threadId: IDENTITY_THREAD_ID } : {}),
        } as never),
      ).container
      break
    case "conversation-tab":
      // The dock tab always carries a thread id: the conversation IS the
      // surface here. `identity` swaps the seat on the other side of it for an
      // agent, which is what the identity gated controls read.
      seedConversation(identity)
      container = inDock(() =>
        components.ConversationTab(conversationTabProps() as never),
      ).container
      break
    case "model-selector":
      container = inApp(() => components.ModelSelector(modelSelectorProps() as never)).container
      break
    case "login":
      container = render(() => (
        <Router>
          <Route path="*" component={components.Login as never} />
        </Router>
      )).container
      break
  }
  // One microtask turn, so a surface whose first paint is synchronous but
  // whose resources resolve immediately settles the same way every run.
  await Promise.resolve()
  return serializeSurface(container)
}
