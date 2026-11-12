// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  agentMailAccessSchema,
  dictationPreferenceSchema,
  favoriteEmojiSchema,
  hiddenSidebarAppsSchema,
  homeCardLayoutSchema,
  magicWandInstructionsSchema,
  SHIPPED_LOCALES,
  themePreferenceSchema,
  userPreferencesSchema,
} from "@liaison/shared"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { broadcastReadState } from "~/modules/threads/read-state-broadcast"
import {
  getOrCreatePreferences,
  PreferencesServiceError,
  updateAgentMailAccess,
  updateDictationAutoClean,
  updateFavoriteEmoji,
  updateHiddenSidebarApps,
  updateHomeCardLayout,
  updateLanguage,
  updateMagicWandInstructions,
  updatePreferences,
  updateTheme,
} from "./preferences-service"

const PREFS_CODE_TO_STATUS: Record<string, number> = {
  INVALID_TIMEZONE: 400,
  INVALID_WORK_DAYS: 400,
}

function prefsError(err: PreferencesServiceError): Response {
  const status = PREFS_CODE_TO_STATUS[err.code] ?? 500
  return Response.json(
    { error: { message: err.message, code: err.code } },
    { status: status as any },
  )
}

export const preferencesRoutes = new Hono<AppEnv>()

preferencesRoutes.get("/", async (c) => {
  const userId = c.get("userId")
  const orgId = c.get("orgId")
  const result = await withRequestRls(c, (rlsTx) =>
    getOrCreatePreferences(userId, orgId, { rlsTx }),
  )
  return success(c, result)
})

// Language-only partial update (I4). The Settings language toggle only knows
// the locale; the full-replace PUT below requires the entire preferences
// object, which the toggle does not hold.
preferencesRoutes.put(
  "/language",
  // null clears the explicit choice (back to the org default, then the browser).
  zValidator("json", z.object({ language: z.enum(SHIPPED_LOCALES).nullable() })),
  async (c) => {
    const userId = c.get("userId")
    const orgId = c.get("orgId")
    const { language } = c.req.valid("json")
    const result = await withRequestRls(c, (rlsTx) =>
      updateLanguage(userId, orgId, language, { rlsTx }),
    )
    return success(c, result)
  },
)

// Theme-only partial update (Phase 14). Mirrors language: the Settings theme
// picker holds only the theme value, not the full preferences object.
preferencesRoutes.put(
  "/theme",
  zValidator("json", z.object({ theme: themePreferenceSchema })),
  async (c) => {
    const userId = c.get("userId")
    const orgId = c.get("orgId")
    const { theme } = c.req.valid("json")
    const result = await withRequestRls(c, (rlsTx) => updateTheme(userId, orgId, theme, { rlsTx }))
    return success(c, result)
  },
)

// Magic-wand-instructions-only partial update. Like /theme, the Settings field
// holds only this string. Blank/whitespace → stored as null so the proofread
// prompt omits the guidance block rather than appending an empty one.
preferencesRoutes.put("/magic-wand", zValidator("json", magicWandInstructionsSchema), async (c) => {
  const userId = c.get("userId")
  const orgId = c.get("orgId")
  const { instructions } = c.req.valid("json")
  const trimmed = instructions.trim()
  const result = await withRequestRls(c, (rlsTx) =>
    updateMagicWandInstructions(userId, orgId, trimmed === "" ? null : trimmed, { rlsTx }),
  )
  return success(c, result)
})

// "Clean up dictation automatically"-only partial update (S11). Like
// /magic-wand: the Settings toggle holds only this boolean.
preferencesRoutes.put("/dictation", zValidator("json", dictationPreferenceSchema), async (c) => {
  const userId = c.get("userId")
  const orgId = c.get("orgId")
  const { autoClean } = c.req.valid("json")
  const result = await withRequestRls(c, (rlsTx) =>
    updateDictationAutoClean(userId, orgId, autoClean, { rlsTx }),
  )
  return success(c, result)
})

// Home card layout-only partial update (Task 7, liaison-messaging-visibility).
// Like /theme, the Home drag/collapse interactions hold only the layout
// shape, not the full preferences object.
preferencesRoutes.put("/home-cards", zValidator("json", homeCardLayoutSchema), async (c) => {
  const userId = c.get("userId")
  const orgId = c.get("orgId")
  const layout = c.req.valid("json")
  const result = await withRequestRls(c, (rlsTx) =>
    updateHomeCardLayout(userId, orgId, layout, { rlsTx }),
  )
  return success(c, result)
})

// Reaction picker favourites-only partial update (S16). Like /home-cards: the
// picker holds only this list. Each entry obeys the reaction rule (S17).
preferencesRoutes.put("/favorite-emoji", zValidator("json", favoriteEmojiSchema), async (c) => {
  const userId = c.get("userId")
  const orgId = c.get("orgId")
  const { favoriteEmoji } = c.req.valid("json")
  const result = await withRequestRls(c, (rlsTx) =>
    updateFavoriteEmoji(userId, orgId, favoriteEmoji, { rlsTx }),
  )
  return success(c, result)
})

// The rail entries the caller hid from their own sidebar (0293). Like
// /favorite-emoji: the rail menu and Settings > Sidebar hold only this list.
// A display preference: it changes no access. Committed, the caller's other
// open apps re-apply it at once.
preferencesRoutes.put("/hidden-apps", zValidator("json", hiddenSidebarAppsSchema), async (c) => {
  const userId = c.get("userId")
  const orgId = c.get("orgId")
  const { hiddenSidebarApps } = c.req.valid("json")
  const result = await withRequestRls(c, (rlsTx) =>
    updateHiddenSidebarApps(userId, orgId, hiddenSidebarApps, { rlsTx }),
  )
  await broadcastReadState(orgId, userId, {
    kind: "hidden_sidebar_apps",
    hiddenSidebarApps: result.hiddenSidebarApps,
  })
  return success(c, result)
})

// The "assistant may read my mail" switch, relayed to the holder's other
// devices. Only the caller's own row is ever written (the user id is the
// token's), and the server is a relay: turning the assistant ON needs the
// device's mailbox-key MAC, which only the holder's devices can make or check.
preferencesRoutes.put(
  "/agent-mail-access",
  zValidator("json", agentMailAccessSchema),
  async (c) => {
    const userId = c.get("userId")
    const orgId = c.get("orgId")
    const record = c.req.valid("json")
    const result = await withRequestRls(c, (rlsTx) =>
      updateAgentMailAccess(userId, orgId, record, { rlsTx }),
    )
    // Committed: the holder's other devices apply it now (their own checks).
    if (result.changed && result.stored) {
      await broadcastReadState(orgId, userId, { kind: "agent_mail_access", ...result.stored })
    }
    return success(c, { agentMailAccess: result.stored, changed: result.changed })
  },
)

preferencesRoutes.put("/", zValidator("json", userPreferencesSchema), async (c) => {
  const userId = c.get("userId")
  const input = c.req.valid("json")
  try {
    const result = await withRequestRls(c, (rlsTx) => updatePreferences(userId, input, { rlsTx }))
    return success(c, result)
  } catch (err) {
    if (err instanceof PreferencesServiceError) return prefsError(err)
    throw err
  }
})
