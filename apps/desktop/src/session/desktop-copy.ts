// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SHELL'S REFUSALS, IN WORDS, and nothing else any more.
//
// This module used to hold every string the overlay drew. A33 moved the UI
// into apps/web, so those strings moved with their components and this file
// shrank to the one group that never belonged to a component: `start_session`
// and `read_local_file` answer with VARIANTS (`sidecar-ipc-contract.md`),
// never with sentences, so the copy for each one lives here and the mapping
// lives in `sidecar-client.ts`, which is behaviour and stays on this side. A
// variant that reached a person unmapped would show a Rust identifier to
// somebody who can only act on a sentence.
//
// No dash punctuation (A7). The repo-wide sweep covers this file:
// `scripts/lint-copy-dashes.ts` has `apps/desktop/src` among its roots.

export const START_ERROR_UNKNOWN_PERMISSION_MODE =
  "That permission mode is not one this app can run. Choose another mode."
export const START_ERROR_CWD_NOT_A_DIRECTORY =
  "That folder is not on this machine any more. Choose another folder."
export const START_ERROR_BYPASS_DECLINED = "Bypass was not turned on, so the session did not start."
/** Auto or Edit was not confirmed in the shell's own dialog (D11). */
export const START_ERROR_MODE_DECLINED =
  "Running without asking first was not confirmed, so the session did not start."
/** The sidecar exited before its first line. What it said follows, as the
 *  refusal's `detail`. */
export const START_ERROR_SIDECAR_EXITED =
  "The assistant on this computer stopped before it started."
/** Anything the shell refuses with that this build has no words for. */
export const START_ERROR_UNKNOWN = "The session could not be started. Try again."

/**
 * The four reconnect reasons and the unapproved grant are one sentence on
 * purpose: all four are fixed by reconnecting, and naming which internal step
 * failed helps nobody. The per-reason copy a PERSON reads is apps/web's
 * (`modules/desktop/desktop-notices.ts`), keyed by the reason code the shell
 * sends; this is the message a refusal carries to a caller.
 */
export const BANNER_RECONNECT_REQUIRED = "Your Liaison connection needs to be renewed."

/** The one grant refusal reconnecting cannot fix: the server's own setting. */
export const START_ERROR_DEVICE_CLIENT_NOT_ALLOWED =
  "This Liaison server does not allow the desktop app to run conversations on this machine. An administrator has to allow it."

/** Reading a file the session produced. */
export const FILE_ERROR_NO_SESSION = "No local session is running, so there is no file to read."
export const FILE_ERROR_OUTSIDE_SESSION_FOLDER =
  "That file is outside the folder this session runs in."
export const FILE_ERROR_TOO_LARGE = "That file is too large to attach."
