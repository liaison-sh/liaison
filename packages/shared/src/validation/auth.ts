// SPDX-License-Identifier: FSL-1.1-ALv2
import { z } from "zod"

export const registerSchema = z.object({
  inviteToken: z.string().optional(),
  // First registration of a fresh instance only: the one-time setup token the
  // server printed in its log at boot (required in production).
  setupToken: z.string().max(256).optional(),
  email: z.string().email().optional(),
  // Passwordless-first: registration no longer requires a password. Magic-link /
  // Google are the primary login methods, so bootstrap + invite-accept create the
  // user with a null password hash. A password MAY still be supplied to opt into
  // the retained password login path (used by test/seed infrastructure and kept
  // as a latent alternate sign-in method).
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password too long")
    .optional(),
  name: z.string().min(1, "Name is required"),
})

// Retained password login (latent alternate sign-in method; primary flow is
// magic-link — see magicLinkRequestSchema / magicLinkVerifySchema below).
export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  orgSlug: z.string().optional(),
})

// ── Passwordless magic-link login (primary) ───────────────────────────────
// One request mints a single challenge delivered by email as BOTH a clickable
// link and a 6-digit code; either verifies the same challenge (Anthropic-style).

export const magicLinkRequestSchema = z.object({
  email: z.string().email(),
  /** Disambiguates when the same email exists in multiple orgs (mirrors login). */
  orgSlug: z.string().optional(),
})

export const magicLinkVerifySchema = z
  .object({
    challengeId: z.string().min(1),
    /** 6-digit numeric code entered on the code-entry screen. */
    code: z
      .string()
      .length(6, "Code must be exactly 6 digits")
      .regex(/^\d+$/, "Code must contain only digits")
      .optional(),
    /** Opaque secret carried by the emailed magic link. */
    token: z.string().min(1).optional(),
  })
  .refine((d) => (d.code === undefined) !== (d.token === undefined), {
    message: "Provide exactly one of code or token",
  })

export const totpVerifySchema = z
  .object({
    challengeToken: z.string(),
    /** 6-digit numeric TOTP code produced by an authenticator app. */
    code: z
      .string()
      .length(6, "TOTP code must be exactly 6 digits")
      .regex(/^\d+$/, "TOTP code must contain only digits")
      .optional(),
    /** Recovery code — typically 8–12 alphanumeric characters (app-generated). */
    recoveryCode: z
      .string()
      .min(8, "Recovery code too short")
      .max(64, "Recovery code too long")
      .optional(),
  })
  .refine((d) => d.code !== undefined || d.recoveryCode !== undefined, {
    message: "Either code or recoveryCode is required",
  })

export const totpConfirmSchema = z.object({
  code: z.string().length(6),
})

// Re-confirmation for sensitive TOTP setup/disable. Password accounts may pass
// `currentPassword` (retained path); passwordless accounts request an emailed
// 6-digit step-up code and pass it as `stepUpCode`. Exactly one is required.
export const totpStepUpSchema = z
  .object({
    currentPassword: z.string().min(1).optional(),
    stepUpCode: z
      .string()
      .length(6, "Step-up code must be exactly 6 digits")
      .regex(/^\d+$/, "Step-up code must contain only digits")
      .optional(),
  })
  .refine((d) => d.currentPassword !== undefined || d.stepUpCode !== undefined, {
    message: "Provide currentPassword or stepUpCode",
  })

// Refresh uses httpOnly cookie, body is empty
export const refreshSchema = z.object({})

export const passwordResetRequestSchema = z.object({
  email: z.string().email(),
  // Required only when the address exists in more than one organization.
  orgSlug: z.string().optional(),
})

export const passwordResetConfirmSchema = z.object({
  token: z.string(),
  newPassword: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password too long"),
})

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password too long"),
})

export const createInviteSchema = z.object({
  email: z.string().email(),
  roleId: z.string().uuid(),
})
