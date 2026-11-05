// SPDX-License-Identifier: FSL-1.1-ALv2
import type { z } from "zod"
import type {
  createInviteSchema,
  createProviderSchema,
  loginSchema,
  passwordResetConfirmSchema,
  refreshSchema,
  registerSchema,
  totpVerifySchema,
  updateOrgSchema,
  updateProfileSchema,
} from "../validation"

export * from "./approvals"
export * from "./attention"

export type RegisterInput = z.infer<typeof registerSchema>
export type LoginInput = z.infer<typeof loginSchema>
export type TotpVerifyInput = z.infer<typeof totpVerifySchema>
export type RefreshInput = z.infer<typeof refreshSchema>
export type PasswordResetConfirmInput = z.infer<typeof passwordResetConfirmSchema>
export type CreateInviteInput = z.infer<typeof createInviteSchema>
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>
export type UpdateOrgInput = z.infer<typeof updateOrgSchema>
export type CreateProviderInput = z.infer<typeof createProviderSchema>
