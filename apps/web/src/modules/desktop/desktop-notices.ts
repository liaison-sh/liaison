// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-T13: THE APP ALREADY HAS A WAY TO SAY THIS.
//
// The overlay drew two banners at fixed positions: one for a gated call
// waiting on a human, one for a session the shell had given up on. Both were
// the same thing the rest of this app says with a toast, drawn in a second
// visual language, at a position nothing else on the screen knew about.
//
// So there are no banners. The shell's state raises toasts, through the same
// `addToast` every other notice in this app uses, dismissing themselves the
// way every other toast does.
//
// THE THREE STATES STAY THREE. Waiting for approval and "we could not find out
// what happened to that approval" are different sentences with different
// urgencies, and collapsing them was the defect the status path exists to
// prevent: a user told their request is queued, when it may have been lost,
// waits forever for an answer nobody is coming with.
//
// A RECONNECT NAMES ITS REASON. The four reasons the shell sends are four
// different things to do, so each carries the sentence FX3 landed, and the
// Reconnect action re-runs the session start, which is also the token refresh
// path. A reason this build has never heard of still says something
// actionable rather than nothing.
//
// ONE TOAST PER LOST SESSION (P6d-FX1, SK-11), not one per distinct reason for
// the life of the window. The reconnect toast carries an action, so it never
// auto dismisses: it is taken down when the shell stops reporting a reason,
// which is what a successful reconnect does. And the memory is the LAST
// reason, cleared when it goes, so a drop, a reconnect and the same drop again
// raises the toast both times rather than only the first.

import { createEffect } from "solid-js"
import type { DesktopClaimHolder } from "~/lib/desktop-shell-contract"
import { tNow } from "~/modules/i18n/i18n-context"
import { openConversation } from "~/modules/shell/dock-store"
import { addToast, dismissToast } from "~/modules/shell/toast-store"
import { desktopState, ensureLocalSessionFor, isDesktop, lastStartRequest } from "./desktop-store"
import {
  currentLocalPrompt,
  localToolLabel,
  PERMISSION_SHOW_ACTION,
  PERMISSION_WAITING_NOTICE,
  permissionCardOnScreen,
} from "./LocalPermissionCard"

/**
 * NORMATIVE, moved from apps/desktop/src/session/desktop-copy.ts.
 *
 * Every NOTICE_* below is a CATALOG KEY (kernel.desktopUi.notice.*), not the
 * sentence: the English in kernel.json is the sentence this file used to hold,
 * byte for byte, and a French reader gets hers. The two copy helpers below
 * answer the sentence in the reader's language.
 */
export const NOTICE_WAITING_FOR_APPROVAL = "kernel.desktopUi.notice.waitingForApproval"
export const NOTICE_APPROVAL_STATUS_UNKNOWN = "kernel.desktopUi.notice.approvalStatusUnknown"
export const NOTICE_RECONNECT_ACTION = "kernel.desktopUi.notice.reconnectAction"

/**
 * A MODE CHANGE THE SHELL DID NOT MAKE (P6d-FX2, SK-3).
 *
 * The menu is not optimistic, so the pill already reads what the session is
 * actually running in; without a word beside it, a user who chose Bypass and
 * watched nothing happen has no way to tell a refusal from a control that does
 * not work.
 */
export const NOTICE_MODE_NOT_CHANGED = "kernel.desktopUi.notice.modeNotChanged"

/** The session stopped answering, with no reason from the shell. */
export const NOTICE_RECONNECT_DROPPED = "kernel.desktopUi.notice.reconnectDropped"
/** The fallback, and the sentence every reason this build cannot name gets. */
export const NOTICE_RECONNECT_REQUIRED = "kernel.desktopUi.notice.reconnectRequired"

export const NOTICE_RECONNECT_TOKEN_REFRESH_FAILED = "kernel.desktopUi.notice.tokenRefreshFailed"
export const NOTICE_RECONNECT_CONFIG_UNWRITABLE = "kernel.desktopUi.notice.configUnwritable"
export const NOTICE_RECONNECT_SIDECAR_SPAWN_FAILED = "kernel.desktopUi.notice.sidecarSpawnFailed"
export const NOTICE_RECONNECT_NOT_APPROVED = "kernel.desktopUi.notice.notApproved"
export const NOTICE_RECONNECT_CONVERSATION_LOST = "kernel.desktopUi.notice.conversationLost"
/**
 * THE GRANT REFUSALS, NAMED (2026-09-23). The shell used to lump every way the
 * device grant could fail into one opaque variant, and the page said "your
 * connection needs to be renewed" about a server that refused the desktop
 * outright: a Reconnect that could never work, offered forever.
 */
export const NOTICE_RECONNECT_DEVICE_CLIENT_NOT_ALLOWED =
  "kernel.desktopUi.notice.deviceClientNotAllowed"
export const NOTICE_RECONNECT_GRANT_FAILED = "kernel.desktopUi.notice.grantFailed"
export const NOTICE_RECONNECT_UNREACHABLE = "kernel.desktopUi.notice.unreachable"

/**
 * The reasons a Reconnect cannot fix. The toast says who has to act instead of
 * offering a button that re-runs the same refusal.
 */
const NOT_RECONNECTABLE = new Set(["DeviceClientNotAllowed"])

/**
 * A REFUSED START, IN WORDS (P6d-FX5, W8).
 *
 * `startSession` answered false for a dozen different reasons and the page
 * rendered nothing at all: no toast, no line in the control, no change a user
 * could see. The charter's "a refusal is stated" was not kept for the one
 * action this slice exists for, and a person pressing Start on a stale token
 * got a window identical to the one before the press.
 *
 * Each sentence says what happened and what to do about it, because the whole
 * point of naming the refusals separately is that they are separately
 * actionable. The four the shell shares with a reconnect keep the reconnect's
 * own sentence: the same thing has happened, and a second wording for it would
 * be a second thing to learn.
 */
export const NOTICE_START_ALREADY_STARTING = "kernel.desktopUi.notice.start.alreadyStarting"
export const NOTICE_START_PATH_NOT_ALLOWED = "kernel.desktopUi.notice.start.pathNotAllowed"
export const NOTICE_START_UNKNOWN_FOLDER = "kernel.desktopUi.notice.start.unknownFolder"
export const NOTICE_START_NO_FOLDER = "kernel.desktopUi.notice.start.noFolder"
export const NOTICE_START_NO_CONVERSATION = "kernel.desktopUi.notice.start.noConversation"
export const NOTICE_START_NOT_SIGNED_IN = "kernel.desktopUi.notice.start.notSignedIn"
export const NOTICE_START_AGENT_DEFINITION_REFUSED =
  "kernel.desktopUi.notice.start.agentDefinitionRefused"
export const NOTICE_START_AUDIT_REFUSED = "kernel.desktopUi.notice.start.auditRefused"
export const NOTICE_START_CONVERSATION_CLAIMED = "kernel.desktopUi.notice.start.conversationClaimed"
// P6d-FX7 (SK-5): the 409 this window got from its own lease. There is no
// other machine and nothing to stop there, so the only thing to say is that
// the conversation is still being let go of, and roughly how long that takes.
export const NOTICE_START_CLAIM_HELD_HERE = "kernel.desktopUi.notice.start.claimHeldHere"
export const NOTICE_START_CLAIM_REFUSED = "kernel.desktopUi.notice.start.claimRefused"
export const NOTICE_START_FAILED = "kernel.desktopUi.notice.start.failed"
/**
 * THE SIDECAR DIED BEFORE ITS FIRST LINE (2026-09-23): it refused its
 * arguments, or crashed on start. The sentence carries what it said, because
 * "it did not start" is exactly the silence this refusal replaced.
 */
export const NOTICE_START_SIDECAR_EXITED = "kernel.desktopUi.notice.start.sidecarExited"
/**
 * CLAUDE ON THIS COMPUTER IS NOT SIGNED IN (2026-09-24). The composer's own
 * notice carries the sign-in (`ClaudeSignInNotice.tsx`), so no toast repeats it.
 */
export const NOTICE_START_CLAUDE_SIGN_IN_REQUIRED =
  "kernel.desktopUi.notice.start.claudeSignInRequired"

/** The refusals the composer states with an action of its own, never toasted. */
const SAID_IN_THE_COMPOSER = new Set(["ClaudeSignInRequired"])

const START_REFUSAL_COPY: Record<string, string> = {
  AlreadyStarting: NOTICE_START_ALREADY_STARTING,
  PathNotAllowed: NOTICE_START_PATH_NOT_ALLOWED,
  UnknownFolder: NOTICE_START_UNKNOWN_FOLDER,
  NoFolderChosen: NOTICE_START_NO_FOLDER,
  NoConversation: NOTICE_START_NO_CONVERSATION,
  NotSignedIn: NOTICE_START_NOT_SIGNED_IN,
  AgentDefinitionRefused: NOTICE_START_AGENT_DEFINITION_REFUSED,
  AuditRefused: NOTICE_START_AUDIT_REFUSED,
  ConversationClaimed: NOTICE_START_CONVERSATION_CLAIMED,
  ClaimHeldHere: NOTICE_START_CLAIM_HELD_HERE,
  ClaimRefused: NOTICE_START_CLAIM_REFUSED,
  // The shell's own `start_session` variants keep the sentences they already
  // have: the reconnect toast says exactly these things about exactly these
  // states, and a second wording for one state is a second thing to learn.
  UnknownPermissionMode: "kernel.desktopUi.notice.start.unknownPermissionMode",
  CwdNotADirectory: "kernel.desktopUi.notice.start.cwdNotADirectory",
  BypassDeclined: "kernel.desktopUi.notice.start.bypassDeclined",
  ModeDeclined: "kernel.desktopUi.notice.start.modeDeclined",
  UnknownModel: "kernel.desktopUi.notice.start.unknownModel",
  TokenRefreshFailed: NOTICE_RECONNECT_TOKEN_REFRESH_FAILED,
  ConfigUnwritable: NOTICE_RECONNECT_CONFIG_UNWRITABLE,
  SidecarSpawnFailed: NOTICE_RECONNECT_SIDECAR_SPAWN_FAILED,
  NotApproved: NOTICE_RECONNECT_NOT_APPROVED,
  DeviceClientNotAllowed: NOTICE_RECONNECT_DEVICE_CLIENT_NOT_ALLOWED,
  GrantFailed: NOTICE_RECONNECT_GRANT_FAILED,
  Unreachable: NOTICE_RECONNECT_UNREACHABLE,
  SidecarExited: NOTICE_START_SIDECAR_EXITED,
  ClaudeSignInRequired: NOTICE_START_CLAUDE_SIGN_IN_REQUIRED,
  StartFailed: NOTICE_START_FAILED,
}

/**
 * The shell's refusal, in words. Never nothing, and never a reason code.
 * `detail` is what the process itself said (`startErrorDetail`), used by the
 * refusals whose sentence names it.
 */
export function startRefusalCopyFor(reason: string | null, detail: string | null = null): string {
  if (!reason) return tNow(NOTICE_START_FAILED)
  const key = START_REFUSAL_COPY[reason] ?? NOTICE_START_FAILED
  if (key === NOTICE_START_SIDECAR_EXITED) {
    return tNow(key, { reason: detail ?? tNow("kernel.desktopUi.turnFailed.noReason") })
  }
  return tNow(key)
}

export const LOCAL_START_CLAIMED_YOURS = "kernel.desktopUi.localStart.claimedYours"
export const LOCAL_START_CLAIMED_NAMED = "kernel.desktopUi.localStart.claimedNamed"
export const LOCAL_START_CLAIMED_UNKNOWN = "kernel.desktopUi.localStart.claimedUnknown"
export const LOCAL_START_CLAIMED_NO_TAKE_OVER = "kernel.desktopUi.localStart.claimedNoTakeOver"

/**
 * WHOSE COMPUTER HOLDS THE CONVERSATION, in words (2026-09-23). "Another
 * machine, stop it there" sent a person who had just relaunched the app
 * looking for a computer that was their own; the server now says whose it is.
 */
export function claimedCopyFor(holder: DesktopClaimHolder | null | undefined): string {
  if (!holder) return tNow(LOCAL_START_CLAIMED_UNKNOWN)
  if (!holder.canTakeOver) return tNow(LOCAL_START_CLAIMED_NO_TAKE_OVER)
  if (holder.sameUser) return tNow(LOCAL_START_CLAIMED_YOURS)
  if (holder.holderName) return tNow(LOCAL_START_CLAIMED_NAMED, { name: holder.holderName })
  return tNow(LOCAL_START_CLAIMED_UNKNOWN)
}

const REASON_COPY: Record<string, string> = {
  TokenRefreshFailed: NOTICE_RECONNECT_TOKEN_REFRESH_FAILED,
  ConfigUnwritable: NOTICE_RECONNECT_CONFIG_UNWRITABLE,
  SidecarSpawnFailed: NOTICE_RECONNECT_SIDECAR_SPAWN_FAILED,
  NotApproved: NOTICE_RECONNECT_NOT_APPROVED,
  ConversationLost: NOTICE_RECONNECT_CONVERSATION_LOST,
  DeviceClientNotAllowed: NOTICE_RECONNECT_DEVICE_CLIENT_NOT_ALLOWED,
  GrantFailed: NOTICE_RECONNECT_GRANT_FAILED,
  Unreachable: NOTICE_RECONNECT_UNREACHABLE,
}

/** The shell's reason, in words. Never nothing. */
export function reconnectCopyFor(reason: string | null): string {
  if (!reason) return tNow(NOTICE_RECONNECT_DROPPED)
  return tNow(REASON_COPY[reason] ?? NOTICE_RECONNECT_REQUIRED)
}

/**
 * Raises the desktop's notices for as long as its owner lives.
 *
 * Called once, from the Shell, so a toast is raised once per situation rather
 * than once per surface that happens to be mounted. Each situation is
 * remembered by the value that raised it, because the shell pushes a whole
 * snapshot on every change and an effect that fired on every snapshot would
 * stack three copies of the same sentence.
 */
export function installDesktopNotices(): void {
  let lastApprovalKey: string | null = null
  let lastReconnect: string | null = null
  /** The refusal this window has already spoken about, so it says it once. */
  let lastStartError: string | null = null
  /** The toast this window raised for the session it is losing, if any. */
  let reconnectToastId: string | null = null
  /** The prompt this window last raised a toast for, and that toast. */
  let lastPromptId: string | null = null
  let promptToastId: string | null = null

  createEffect(() => {
    if (!isDesktop()) return
    const state = desktopState()

    const approvalKey = state.pendingApprovalRequestId
      ? `${state.pendingApprovalRequestId}:${state.approvalStatus ?? "pending"}`
      : null
    if (approvalKey !== lastApprovalKey) {
      lastApprovalKey = approvalKey
      if (approvalKey) {
        const unknown = state.approvalStatus === "unknown"
        addToast({
          message: tNow(unknown ? NOTICE_APPROVAL_STATUS_UNKNOWN : NOTICE_WAITING_FOR_APPROVAL),
          type: unknown ? "warning" : "info",
        })
      }
    }

    // A LOCAL TURN WAITING ON A QUESTION NOBODY CAN SEE (2026-09-23). The
    // conversation scrolls its card into view, but the conversation may be
    // collapsed, in another tab, or behind another app: the turn then waited
    // ten minutes with nothing anywhere saying so. One toast per prompt, raised
    // only when its card is not on screen a frame later, taken down when the
    // prompt is answered. Its action opens the conversation the card is in.
    const prompt = currentLocalPrompt()
    const promptId = prompt?.requestId ?? null
    if (promptId !== lastPromptId) {
      lastPromptId = promptId
      if (promptToastId) dismissToast(promptToastId)
      promptToastId = null
      if (prompt && promptId) {
        const threadId = state.threadId
        const raise = () => {
          if (lastPromptId !== promptId || permissionCardOnScreen(promptId)) return
          promptToastId = addToast({
            message: tNow(PERMISSION_WAITING_NOTICE, {
              tool: localToolLabel(prompt.toolName, tNow),
            }),
            type: "warning",
            ...(threadId
              ? {
                  action: {
                    label: tNow(PERMISSION_SHOW_ACTION),
                    onClick: () => openConversation(threadId),
                  },
                }
              : {}),
          })
        }
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(raise)
        else raise()
      }
    }

    // A REFUSED START IS SAID OUT LOUD (P6d-FX5, W8). Remembered by the
    // reason that raised it and cleared when the shell clears it, so pressing
    // Start twice on the same stale token says so twice rather than once for
    // the life of the window.
    //
    // ONE SENTENCE PER REFUSAL. A start the shell refused with a RECONNECT
    // reason carries the same code on both fields; the reconnect toast is the
    // one with the action, so it is the one raised (again, for a second
    // refusal of the same kind), and the start toast would only repeat it.
    const reason = state.reconnectReason
    const startError = state.startError ?? null
    const refusedAgain = startError !== lastStartError && startError !== null
    lastStartError = startError
    const sameAsReconnect = startError !== null && startError === reason
    if (refusedAgain && !sameAsReconnect && !SAID_IN_THE_COMPOSER.has(startError)) {
      addToast({
        message:
          startError === "ConversationClaimed" && state.startClaimHolder
            ? claimedCopyFor(state.startClaimHolder)
            : startRefusalCopyFor(startError, state.startErrorDetail ?? null),
        type: "warning",
      })
    }

    if (reason === lastReconnect && !(refusedAgain && sameAsReconnect)) return
    lastReconnect = reason
    if (reason === null) {
      // Reconnected. The toast carries an action, so nothing takes it down on
      // its own, and one telling a user to reconnect a session that is running
      // again is worse than none.
      if (reconnectToastId) dismissToast(reconnectToastId)
      reconnectToastId = null
      return
    }
    if (reconnectToastId) dismissToast(reconnectToastId)
    // THE CONVERSATION TO RECONNECT is the running one, or, when the session
    // never started (a refused grant), the one the page last asked a start
    // for: the state names no conversation then, and a Reconnect that read
    // only the state did nothing at all.
    const pending = lastStartRequest()
    const threadId = state.threadId ?? pending?.threadId ?? null
    const agentId = state.agentId ?? pending?.agentId ?? null
    const reconnectable = !NOT_RECONNECTABLE.has(reason) && threadId !== null && agentId !== null
    reconnectToastId = addToast({
      message: reconnectCopyFor(reason),
      type: "warning",
      ...(reconnectable
        ? {
            action: {
              label: tNow(NOTICE_RECONNECT_ACTION),
              onClick: () => {
                // The same path a send takes: the conversation's folder (kept
                // on the state, or remembered across a relaunch), then the
                // start, which is where a new device approval is shown.
                void ensureLocalSessionFor(threadId, agentId)
              },
            },
          }
        : {}),
    })
  })
}
