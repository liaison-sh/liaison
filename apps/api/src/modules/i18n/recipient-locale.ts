// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The language of a system email (sign-in code, invitation, password reset,
 * step-up code, connect link, survey): the recipient's, never a fixed English.
 *
 * Precedence, first shipped language wins:
 *   1. the recipient's explicit UI language (`user_preferences.language`),
 *   2. the recipient's account locale (`users.locale`),
 *   3. the org's default language (`organizations.default_locale`, set at
 *      signup from the locale the workspace was created with),
 *   4. the inviter's language, for an invitation to someone with no account,
 *   5. English.
 */
import { resolveLocale, type ShippedLocale } from "@liaison/shared"
import { and, eq } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { organizations, userPreferences, users } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ service: "recipient-locale" })

export interface RecipientLocaleFacts {
  chosenLanguage?: string | null
  accountLocale?: string | null
  orgDefault?: string | null
  inviterLanguage?: string | null
  inviterLocale?: string | null
}

/** The precedence above, over facts already read. */
export function pickRecipientLocale(f: RecipientLocaleFacts): ShippedLocale {
  return resolveLocale(
    f.chosenLanguage,
    f.accountLocale,
    f.orgDefault,
    f.inviterLanguage,
    f.inviterLocale,
  )
}

async function personFacts(
  tx: PrivilegedDb,
  orgId: string,
  userId: string,
): Promise<{ language: string | null; locale: string | null } | undefined> {
  const [row] = await tx
    .select({ language: userPreferences.language, locale: users.locale })
    .from(users)
    .leftJoin(userPreferences, eq(userPreferences.userId, users.id))
    .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
    .limit(1)
  return row
}

/**
 * The language to write a system email to a person in. `userId` is the
 * recipient when they have an account; `inviterId` the person who invited them.
 * Read privileged: kernel.organizations is deny-all under RLS, and the answer
 * must not depend on what a caller can see. A failed read falls back to
 * English and is logged: a language lookup never stops a sign-in mail.
 */
export async function systemMailLocale(
  orgId: string,
  who: { userId?: string | null; inviterId?: string | null } = {},
): Promise<ShippedLocale> {
  try {
    return await withPrivilegedDb(orgId, "recipient-locale", async (tx) => {
      const [org] = await tx
        .select({ defaultLocale: organizations.defaultLocale })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1)
      const user = who.userId ? await personFacts(tx, orgId, who.userId) : undefined
      const inviter = who.inviterId ? await personFacts(tx, orgId, who.inviterId) : undefined
      return pickRecipientLocale({
        chosenLanguage: user?.language,
        accountLocale: user?.locale,
        orgDefault: org?.defaultLocale,
        inviterLanguage: inviter?.language,
        inviterLocale: inviter?.locale,
      })
    })
  } catch (err) {
    log.error({ err, orgId }, "recipient locale lookup failed; the mail goes in English")
    return "en"
  }
}
