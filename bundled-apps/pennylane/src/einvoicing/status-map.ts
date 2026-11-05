// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pennylane `e_invoicing.status` words → einvoicing-pa@1 lifecycle states. Pennylane exposes words
// only (no numeric codes, no coded refusal reasons: `reason` is free text). Rows other than
// refused / rejected / collected are inferred from the word and confirmed by the first live sends.
import { LIFECYCLE_CODE, type LifecycleState } from "@liaison/app-sdk/contracts"

export const PENNYLANE_STATUS_MAP: Readonly<Record<string, LifecycleState>> = {
  submitted: "deposited",
  sent: "sent",
  accepted: "accepted",
  approved: "approved",
  in_dispute: "in_dispute",
  refused: "refused",
  rejected: "rejected",
  partially_collected: "partially_collected",
  collected: "collected",
}

/** Official lifecycle codes Pennylane does not expose (never observed through this provider). */
export const NOT_OBSERVABLE_CODES: readonly number[] = [202, 203, 206, 208, 209, 211]

export function mapPennylaneStatus(raw: unknown): { mapped: LifecycleState | null; code: number | null } {
  if (typeof raw !== "string") return { mapped: null, code: null }
  const mapped = PENNYLANE_STATUS_MAP[raw] ?? null
  return { mapped, code: mapped ? LIFECYCLE_CODE[mapped] : null }
}
