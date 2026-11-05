// SPDX-License-Identifier: FSL-1.1-ALv2
import { createEffect, createResource, createSignal, type ResourceReturn } from "solid-js"
import type { ApiClient } from "~/lib/api-client"

export type BillingState =
  | {
      mode: "self_hosted"
      byokEnabled: boolean
    }
  | {
      mode: "managed"
      tier: string
      status: string
      billingPortalUrl: string
      checkoutUrl: string
      includedCredits: string
      periodEnd: string
      stale: boolean
      fetchedAt?: string
    }
  | {
      mode: "managed"
      billingUnavailable: true
      stale: true
    }

export function isManagedAvailable(
  state: BillingState,
): state is Extract<BillingState, { mode: "managed"; tier: string }> {
  return state.mode === "managed" && !("billingUnavailable" in state && state.billingUnavailable)
}

export function isManagedUnavailable(
  state: BillingState,
): state is Extract<BillingState, { mode: "managed"; billingUnavailable: true }> {
  return state.mode === "managed" && "billingUnavailable" in state
}

export function createBillingState(api: ApiClient): ResourceReturn<BillingState> {
  const result = createResource(() => api.get<BillingState>("/billing/state"))
  const [state] = result
  // Mirror the latest resolved mode into the global signal so synchronous
  // visibility predicates (e.g. the Plan settings tab) reflect it. The
  // previous implementation used a one-shot queueMicrotask which fired
  // before the resource resolved and left billingMode stuck at null,
  // hiding the Plan tab in managed mode indefinitely. createEffect runs
  // each time the resource value changes — covers initial resolve and
  // any later refetch.
  createEffect(() => {
    const value = state()
    if (value) setBillingMode(value.mode)
  })
  return result
}

const [billingMode, setBillingMode] = createSignal<"self_hosted" | "managed" | null>(null)

export { billingMode }

/**
 * Fetch /billing/state once and populate the global mode signal. Sidebar
 * `visibleWhen` predicates rely on this. Safe to call repeatedly; the latest
 * successful call wins.
 */
export async function ensureBillingModeLoaded(api: ApiClient): Promise<void> {
  try {
    const state = await api.get<BillingState>("/billing/state")
    setBillingMode(state.mode)
  } catch {
    // Non-fatal — leave the previous value in place
  }
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const BillingStateTestAccess = {
  /** Reset to initial state. */
  reset(): void {
    setBillingMode(null)
  },

  /** Force a specific billing mode synchronously. */
  setMode(mode: "self_hosted" | "managed" | null): void {
    setBillingMode(mode)
  },
}
