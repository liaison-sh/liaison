// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Handler ctx surface for the calls app.
//
// This connector owns NO tables (spec §2 "no custom entity model" — all state
// lives in per-call knowledge documents), so unlike monitoring it never touches
// `ctx.db`. Its only write surface is the sanctioned cross-app dispatch
// `ctx.executeTool` (K4 contract — the same surface boxtal/invoicing/meta-ads
// already use from bundled-app handlers; see bundled-apps/invoicing/src/
// cross-app.ts for the envelope rationale). The K4 envelope applies because
// this app declares non-empty `cross_app_calls[]` in its manifest.
import type { AppContext, CrossAppEnvelope } from "@liaison/app-sdk"

export type { CrossAppEnvelope }

/**
 * `ctx.executeTool` signature inside a bundled-app handler. `args` MUST be a
 * plain object — the sandbox `__wrap` shim auto-stringifies object args and
 * auto-parses the JSON return; a pre-stringified (primitive) arg skips the
 * return parse and the caller reads `.status` as undefined (BL-27).
 */
export type CrossAppExecuteTool = (
  target: string,
  args: Record<string, unknown>,
) => Promise<CrossAppEnvelope>

/**
 * The runtime bridge exposes `executeTool` to every sandboxed handler
 * (rpc-bridge.ts builds it unconditionally; the executor's ctx shim mirrors
 * every bridge method) — the SDK `AppContext` type just doesn't declare it
 * yet, so this app follows the boxtal/social convention of typing it locally.
 */
export type CallsCtx = AppContext & { executeTool: CrossAppExecuteTool }
