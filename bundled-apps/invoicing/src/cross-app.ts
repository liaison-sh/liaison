// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 fix Q1 — Shared K4 cross-app envelope type.
//
// `ctx.executeTool(target, params)` is the sandbox cross-app dispatch surface.
// The K4 contract (spec §"App ↔ Other apps") guarantees three envelope
// variants: `completed`, `pending_approval`, `error`. The legacy `blocked`
// shape is translated away from K4-compliant apps (i.e. apps that declare
// non-empty `cross_app_calls[]` in their manifest — this app does).
//
// Every handler that does cross-app calls imports this type instead of
// re-declaring its own envelope shape. Drift between handler ctxs (e.g. the
// pre-fix `OrderPaidCtx` had a bogus `"blocked"` variant that never matched)
// is the natural consequence of duplicating the contract per file.

import type { CrossAppEnvelope } from "@liaison/app-sdk"

export type { CrossAppEnvelope }

/**
 * `ctx.executeTool` signature inside a bundled-app handler. The args parameter
 * MUST be a plain object — the sandbox `__wrap` helper at
 * `apps/api/src/modules/apps/sandbox/executor.ts` auto-stringifies the object on
 * the way in AND auto-parses the JSON string return on the way out.
 *
 * `args` is deliberately NOT `string | Record` (BL-27, l69). The `__wrap` shim
 * only JSON-parses a host method's STRING return when a NON-primitive arg was
 * passed (it auto-detects raw-vs-SDK call shape by arg primitivity). So passing
 * an ALREADY-stringified JSON arg (a primitive string) makes the shim skip the
 * return parse → the caller gets an UNPARSED JSON string instead of the envelope
 * object, and reads `.status`/`.result` as `undefined`. That silently dead-ended
 * `documents_send_to_customer` recipient resolution on `no_recipient` for a
 * contact that DID have an email. Passing an object (the only form now allowed)
 * is the same class of fix as the l62 `ctx.fetch(url, { method })` opts-object
 * fix. Every other caller (boxtal, issue.ts) already passes an object.
 *
 * Returns the parsed envelope object.
 */
export type CrossAppExecuteTool = (
  target: string,
  args: Record<string, unknown>,
) => Promise<CrossAppEnvelope>
