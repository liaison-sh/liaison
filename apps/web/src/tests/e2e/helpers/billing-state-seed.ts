// SPDX-License-Identifier: FSL-1.1-ALv2
// Seeds the billing state a managed cell holds after a control plane push
// (kernel.org_billing_state, served by GET /api/billing/state), for scenarios
// that need a managed org with a plan. Through the seed route's
// `billing.state` factory (apps/api/test-support/seed/factories.ts).
import type { WorkerEnv } from "@liaison/test-helpers"
import { seedFactory } from "./seed"

export async function seedBillingState(
  env: WorkerEnv,
  orgId: string,
  state: {
    plan: "preview" | "base" | "pro"
    status?: "active" | "past_due" | "suspended" | "closed"
    /** Default far in the future. */
    periodEnd?: Date
    /** The period's included credits; default 10000. */
    includedCredits?: number
  },
): Promise<void> {
  await seedFactory(env, orgId, "billing.state", {
    plan: state.plan,
    status: state.status ?? "active",
    periodEnd: (state.periodEnd ?? new Date("2099-01-01T00:00:00Z")).toISOString(),
    includedCredits: state.includedCredits ?? 10000,
  })
}
