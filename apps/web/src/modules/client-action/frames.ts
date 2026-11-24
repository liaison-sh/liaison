// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The twelve pages a link that cannot be used shows (A-09): which one an answer
// of the public routes means, and what each offers as the next step. A dead page
// shows who sent it and that next step, never the document, a price or another
// name; `notfound` and `down` show no sender at all, since nobody is known.

import type { PublicAnswer } from "./public-api"

export const FRAMES = [
  "expired",
  "used",
  "revoked",
  "wrong",
  "declined",
  "signed",
  "attempts",
  "locked",
  "replaced",
  "ended",
  "notfound",
  "down",
] as const

export type FrameId = (typeof FRAMES)[number]

/** What a frame's button asks the server for (`request`), or a local retry. */
export type FrameAction =
  | { kind: "request"; type: "new_link" | "resend_link" | "copy" | "not_me" | "question" }
  | { kind: "invite" }
  | { kind: "retry" }
  | { kind: "identity" }

export interface FrameFacts {
  frame: FrameId
  /** The sender as the server named it; absent on `notfound` and `down`. */
  sender: { name: string; org: string } | null
  /** `attempts`: when the pause ends. */
  retryAt?: string | null
  /** `signed`: where the holder's own copy stands, as the server said. */
  copy?: CopyState | null
  /** `signed`: the masked address the copy goes to. */
  copyTo?: string | null
  /**
   * `replaced`: true when a new link really went to the same address (the link was
   * rotated by a reminder or a resend); false when the version was replaced and no new
   * link has been sent, so the page offers asking the sender instead.
   */
  relinked?: boolean
}

/** Where a signer's copy of a signed document stands (the server's `copy`). */
export const COPY_STATES = [
  "waiting_for_others",
  "on_its_way",
  "sent",
  "not_sent",
  "not_completed",
] as const
export type CopyState = (typeof COPY_STATES)[number]

/** The server's `copy`, or null when it named none (or one this page does not know). */
export function copyStateOf(body: Record<string, unknown> | null): CopyState | null {
  const c = body?.copy
  return typeof c === "string" && (COPY_STATES as readonly string[]).includes(c)
    ? (c as CopyState)
    : null
}

/** A copy that will not move any more without a person: no point asking again. */
export const copySettled = (c: CopyState | null) =>
  c === "sent" || c === "not_sent" || c === "not_completed"

export const FRAME_ACTIONS: Record<FrameId, FrameAction[]> = {
  expired: [{ kind: "request", type: "new_link" }],
  used: [
    { kind: "request", type: "copy" },
    { kind: "request", type: "not_me" },
  ],
  revoked: [{ kind: "request", type: "question" }],
  wrong: [{ kind: "invite" }],
  declined: [{ kind: "request", type: "new_link" }],
  signed: [{ kind: "request", type: "copy" }],
  attempts: [{ kind: "identity" }],
  locked: [{ kind: "request", type: "new_link" }],
  replaced: [{ kind: "request", type: "resend_link" }],
  ended: [{ kind: "request", type: "question" }],
  notfound: [{ kind: "retry" }],
  down: [{ kind: "retry" }],
}

/** What a page offers: a replaced version with no new link sent asks the sender for one. */
export function frameActions(facts: FrameFacts): FrameAction[] {
  if (facts.frame === "replaced" && facts.relinked === false)
    return [{ kind: "request", type: "new_link" }]
  return FRAME_ACTIONS[facts.frame]
}

/** The words a page reads from (`client-action.page.frame.<key>`). */
export function frameWords(facts: FrameFacts): string {
  return facts.frame === "replaced" && facts.relinked === false ? "replacedNoLink" : facts.frame
}

/** The frames that name nobody: whoever holds the link is not known. */
export const NAMELESS: ReadonlySet<FrameId> = new Set(["notfound", "down"])

const SERVER_DEAD: Record<string, FrameId> = {
  expired: "expired",
  used: "used",
  revoked: "revoked",
  declined: "declined",
  signed: "signed",
  // The server's `attempts` is the link locked after 20 wrong codes in all.
  attempts: "locked",
  replaced: "replaced",
  ended: "ended",
}

function senderOf(body: Record<string, unknown> | null): FrameFacts["sender"] {
  const s = body?.sender as { name?: unknown; org?: unknown } | undefined
  if (!s || typeof s.org !== "string") return null
  return { name: typeof s.name === "string" ? s.name : s.org, org: s.org }
}

/**
 * The frame an answer means, or null when it is not a frame (an open action, or
 * an error the step itself explains, such as a wrong code).
 */
export function frameOfAnswer(
  answer: PublicAnswer,
  known?: FrameFacts["sender"],
): FrameFacts | null {
  const { status, body } = answer
  if (status === 0 || status >= 500 || body?.state === "down") {
    return { frame: "down", sender: null }
  }
  if (status === 404 && (body?.error as { code?: unknown } | undefined)?.code === "not_found") {
    return { frame: "notfound", sender: null }
  }
  const code = (body?.error as { code?: unknown } | undefined)?.code
  if (status === 423 || code === "paused") {
    const retry = (body?.error as { retry_at?: unknown } | undefined)?.retry_at
    return {
      frame: "attempts",
      sender: known ?? null,
      retryAt: typeof retry === "string" ? retry : null,
    }
  }
  if (code === "NO_MAIL_ON_DEMO") return { frame: "down", sender: null }
  if (code === "VERSION_CHANGED")
    return { frame: "replaced", sender: known ?? null, relinked: false }
  const state = typeof body?.state === "string" ? body.state : null
  if (state && state !== "open" && SERVER_DEAD[state]) {
    const frame = SERVER_DEAD[state] as FrameId
    const facts: FrameFacts = { frame, sender: senderOf(body) ?? known ?? null }
    if (frame === "replaced") facts.relinked = body?.next === "resend_link"
    if (frame === "signed") {
      facts.copy = copyStateOf(body)
      facts.copyTo = typeof body?.copy_to === "string" ? body.copy_to : null
    }
    return facts
  }
  return null
}
