// SPDX-License-Identifier: FSL-1.1-ALv2
import { TIER_ORDER } from "@liaison/shared"
import { z } from "zod"

export const TopUpSchema = z.object({
  orgId: z.string().uuid(),
  amountCredits: z.string().regex(/^\d+(\.\d{1,8})?$/),
  externalPaymentRef: z.string().min(1).max(128),
})

export const ResetSchema = z.object({
  orgId: z.string().uuid(),
  cycleId: z.string().min(1).max(64),
})

export const TierSchema = z.object({
  tier: z.enum([...TIER_ORDER] as [string, ...string[]]),
})
