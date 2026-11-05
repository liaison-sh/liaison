// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Cluster-1 (canonical event identity) — single shared emit helper.
//
// Every Shopify domain event is `{ app: "shopify", entity, action }` — three
// SEPARATE fields. The kernel keys events on `entity:action` at every layer:
//
//   - Sandbox emit guard      rpc-bridge.ts  → `${entity}:${action}` ∈ manifest.events.emits
//   - Outbox publish guard    event-bus.ts   → `${entity}:${action}` ∈ declaredEmits
//   - Channel name            event-bus.ts   → `events:${app}:${entity}:${action}`
//   - Attention translator    translator.ts  → `${entity}:${action}` === translation.event
//   - Cross-app sub parse      runtime.ts     → `sourceApp/entity:action`
//
// This helper exists so there is ONE place that constructs the emit envelope:
// it passes `entity` / `action` through VERBATIM (no namespace collapse). The
// previous webhooks.ts helper collapsed `(entity, action)` into a single
// `{ entity: "shopify", action: "<entity>_<action>" }` token, which produced
// the wrong channel `events:shopify:shopify:<entity>_<action>` and matched no
// subscriber. Routing every emit site through here guarantees convergence on
// the canonical form.
import type { AppContext } from "@liaison/app-sdk"

/**
 * Emit a kernel event with the canonical `{ entity, action }` identity.
 *
 * `metadata` is a top-level field on the emit envelope (per SDK types); the
 * kernel attention translator extracts axes from `event.metadata`. Omit it for
 * events that carry no attention axes (the kernel tolerates an absent field).
 */
export async function emitEvent(
  ctx: AppContext,
  args: {
    entity: string
    action: string
    entityId?: string
    data?: unknown
    metadata?: Record<string, unknown>
  },
): Promise<void> {
  await ctx.emit({
    entity: args.entity,
    action: args.action,
    entityId: args.entityId,
    data: args.data,
    metadata: args.metadata,
  })
}
