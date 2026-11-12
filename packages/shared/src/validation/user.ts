// SPDX-License-Identifier: FSL-1.1-ALv2
import { z } from "zod"
import { SHIPPED_LOCALES } from "../i18n/locales"
import { reactionEmojiSchema } from "./threads"

// Note: the profile picture is NOT set through this schema. It is owned by the
// dedicated POST/DELETE /users/me/avatar endpoints, which validate + store the
// image and set `avatar_url` server-side. Letting a client PATCH an arbitrary
// `avatarUrl` would allow pointing every org member's rendered avatar at an
// external tracking/exploit URL, so it is deliberately not writable here.
export const updateProfileSchema = z.object({
  name: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
  locale: z.string().min(1).optional(),
})

export const digestCadenceSchema = z.enum(["off", "immediate", "hourly", "daily"])

export const themePreferenceSchema = z.enum(["system", "light", "dark"])
export type ThemePreference = z.infer<typeof themePreferenceSchema>

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/

// ISO weekday: 1 = Monday … 7 = Sunday.
export const workDayNumberSchema = z.number().int().min(1).max(7)

export const userPreferencesSchema = z
  .object({
    digestCadence: digestCadenceSchema,
    workHoursStart: z.string().regex(timePattern, "HH:MM expected"),
    workHoursEnd: z.string().regex(timePattern, "HH:MM expected"),
    workDays: z.array(workDayNumberSchema).max(7),
    timezone: z.string().min(1),
    // null = "never chose": the org default locale, then the browser, decides.
    language: z.enum(SHIPPED_LOCALES).nullable().optional(),
    theme: themePreferenceSchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.workDays.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Pick at least one work day",
        path: ["workDays"],
      })
    }
    if (new Set(val.workDays).size !== val.workDays.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Duplicate work day entries",
        path: ["workDays"],
      })
    }
  })

export type UserPreferencesInput = z.infer<typeof userPreferencesSchema>

// Per-user "magic wand" custom instruction (tone/style). Standalone partial,
// like the /theme route — NOT folded into userPreferencesSchema (which is a
// ZodEffects full-replace body). Blank → null is handled at the route layer.
export const magicWandInstructionsSchema = z.object({
  instructions: z.string().max(2000),
})
export type MagicWandInstructionsInput = z.infer<typeof magicWandInstructionsSchema>

// Home card order/collapse persistence (liaison-messaging-visibility Task 7).
// Standalone partial, like /theme — NOT folded into userPreferencesSchema.
// Unknown card ids are accepted (forward compat with future cards); the
// caps just bound payload size, they are not a card-id allowlist.
const homeCardIdSchema = z.string().min(1).max(32)
export const homeCardLayoutSchema = z.object({
  order: z.array(homeCardIdSchema).max(16),
  collapsed: z.array(homeCardIdSchema).max(16),
})
export type HomeCardLayoutInput = z.infer<typeof homeCardLayoutSchema>

// Reaction picker favourites row (S16). Standalone partial, like /home-cards:
// the picker holds only this list. Order is the row's order; each entry obeys
// the reaction rule (S17), so a pinned favourite can always be sent.
export const FAVORITE_EMOJI_MAX = 24
export const favoriteEmojiSchema = z.object({
  favoriteEmoji: z
    .array(reactionEmojiSchema)
    .max(FAVORITE_EMOJI_MAX)
    .refine((list) => new Set(list).size === list.length, { message: "Duplicate emoji" }),
})
export type FavoriteEmojiInput = z.infer<typeof favoriteEmojiSchema>

/**
 * The rail entries a person hid from their sidebar (PUT
 * /user/preferences/hidden-apps, and an admin's PUT
 * /admin/users/:id/hidden-apps). Each id is an activity-bar entry id
 * (`sessions`, `dashboards`, an app's name). Unknown ids are kept: another
 * device may run an app this one lacks. Hiding never changes access.
 */
export const HIDDEN_SIDEBAR_APPS_MAX = 100
export const hiddenSidebarAppIdSchema = z.string().min(1).max(100)
export const hiddenSidebarAppsSchema = z.object({
  hiddenSidebarApps: z
    .array(hiddenSidebarAppIdSchema)
    .max(HIDDEN_SIDEBAR_APPS_MAX)
    .refine((list) => new Set(list).size === list.length, { message: "Duplicate app id" }),
})
export type HiddenSidebarAppsInput = z.infer<typeof hiddenSidebarAppsSchema>

/**
 * The "assistant may read my mail" switch as relayed between the account
 * holder's devices (PUT /user/preferences/agent-mail-access). `at` is the
 * change's epoch ms on the device that made it; `mac` is the device's HMAC of
 * the change under the mailbox key and is REQUIRED to turn the assistant on:
 * a relay that cannot prove the holder switched it on must not carry "on".
 */
export const agentMailAccessSchema = z
  .object({
    enabled: z.boolean(),
    at: z.number().int().positive(),
    mac: z
      .string()
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .max(128)
      .optional(),
  })
  .strict()
  .refine((v) => !v.enabled || v.mac !== undefined, {
    message: "Turning the assistant on needs the mailbox signature",
    path: ["mac"],
  })
export type AgentMailAccessInput = z.infer<typeof agentMailAccessSchema>
