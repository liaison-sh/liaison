// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHO CAN GET A SESSION IN A DEMO ORG.
//
// A demo workspace is seeded with a whole company in it: seven people who
// author tickets, are assigned work, sit in threads and fill the directory.
// They are DATA, not doors, and `seed-org.ts` leaves them with a null
// `password_hash` so the password route cannot let them in.
//
// The magic link route did not agree. `requestMagicLink` gated on
// `status !== "active"` alone, so every one of those seeded accounts could be
// issued a passwordless challenge, and a send failure is swallowed and answered
// 200 (anti enumeration), so nothing surfaced it. What kept it from being
// exploitable was that the seeded addresses sit on an unregistrable `.example`
// domain and the demo box's mail provider refuses to send: a deployment
// accident, not a rule in the code.
//
// The rule in the code is here, and it is demo side ONLY. A null password hash
// is perfectly normal for a magic link user in the product at large, and a
// product wide "no hash, no link" would lock real customers out of the only
// door they have. Inside a demo org the property is the opposite and is true by
// construction: the org is created with exactly ONE account that carries a
// password (the visitor's own, or the App Review account), and every other
// account in there is furniture. So in a demo org a magic link is issued to the
// account that can already sign in, and to nobody else. The seeded people stay
// active, stay assignable and stay authors of everything they wrote.
import { rootLogger } from "~/lib/logger"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import { loadDemoMarker } from "~/modules/demo/demo-org"

const log = rootLogger.child({ module: "demo-login" })

/**
 * May this account be issued a passwordless sign-in challenge?
 *
 * True on its FIRST LINE on every normal deployment, and true for every org on
 * a demo box that carries no demo marker, so a real customer's magic link is
 * the request it always was: no query, no branch, no allocation.
 *
 * `hasPassword` is the caller's already loaded `password_hash IS NOT NULL`, so
 * this adds no round trip of its own.
 */
export async function demoMagicLinkAllowed(
  orgId: string,
  userId: string,
  hasPassword: boolean,
): Promise<boolean> {
  if (!isDemoModeEnabled()) return true
  const marker = await loadDemoMarker(orgId)
  if (!marker) return true
  if (hasPassword) return true
  log.warn(
    { orgId, userId },
    "refused a magic link for a seeded demo account: only the owner of a demo org has a door",
  )
  return false
}
