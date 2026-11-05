// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one name a dead sidecar is known by on the turn stream. Kept in a module
// of its own, with no imports, so the modules that react to it
// (`start-local-session.ts`, `thread-turn-bridge.ts`, `bridge.ts`) read the
// real value even where a test replaces `sidecar-client.ts` wholesale.

/**
 * The `type` a shell reported exit (`sidecar-exited`, `sidecar_watch.rs`) is
 * dispatched with to every `onTurnEvent` listener. Not a protocol 2 line: the
 * sidecar cannot report its own death, so the shell does.
 */
export const SIDECAR_EXITED_TYPE = "sidecar_exited"
