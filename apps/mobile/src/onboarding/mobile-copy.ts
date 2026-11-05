// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every string the first launch screen shows. It is the mobile twin of
// apps/desktop/src/session/desktop-copy.ts and apps/desktop/src/onboarding/
// onboarding-copy.ts, and the wording is deliberately the same: the two shells
// answer the same question, and a user who has seen one should recognise the
// other.
//
// This file is inside the no-dash copy lint's scope (scripts/lint-copy-dashes.ts).

/** NORMATIVE. First launch, the question. */
export const FIRST_LAUNCH_PROMPT = "Enter your Liaison org URL:"
/** NORMATIVE. First launch, helper line. */
export const FIRST_LAUNCH_HELPER = "You can also open a connect link from the web app."
/** NORMATIVE. First launch, the action. */
export const FIRST_LAUNCH_CONNECT_ACTION = "Connect"
/** NORMATIVE. First launch, refusal. */
export const FIRST_LAUNCH_INVALID_ADDRESS = "That is not a valid Liaison URL."
/**
 * Shown above a prefilled address that arrived as a `liaison://connect` link.
 * The link comes from the operating system, which means any page the user
 * visits can send one, so the address is shown and confirmed, never applied.
 */
export const DEEP_LINK_CONFIRM_PROMPT = "Connect to this Liaison org?"

/**
 * NORMATIVE. The in app notice for a push whose payload carries no text. A
 * scope tagged message is delivered with no title and no body by design
 * (apps/api/src/modules/push/redact.ts), so this is what the user reads.
 */
export const PUSH_NOTICE_FALLBACK = "New message"
/**
 * NORMATIVE. The address was valid and the server behind it did not answer.
 * Shown on the prompt, which is rendered AGAIN: nothing is stored until the
 * branding fetch has proved the address reaches a Liaison.
 */
export const FIRST_LAUNCH_UNREACHABLE = "Cannot reach this Liaison. Check the URL and try again."
