// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one-time SETUP TOKEN that guards the very first registration.
//
// A fresh instance has no organisation, so `POST /api/auth/register` has no
// invitation to check: whoever arrives first creates the org and becomes its
// admin. On an internet-exposed new install that is a race the operator can
// lose to a stranger. The setup token closes it: the first registration must
// present a secret that only someone who can read the server's own log (or its
// environment) knows.
//
// WHERE THE TOKEN COMES FROM, in order:
//   1. `LIAISON_SETUP_TOKEN` if the operator set it (their own value, for
//      scripted installs).
//   2. Otherwise a value DERIVED from `JWT_SECRET` (HMAC, domain separated).
//      Deriving it rather than storing it needs no migration and no state: it is
//      identical across restarts and across the nodes of an HA pair, and it
//      reveals nothing about the secret. Whoever holds JWT_SECRET can mint any
//      session anyway, so the token adds no new trust root.
//
// It is printed in the app log at every boot WHILE THE INSTANCE IS NOT
// BOOTSTRAPPED, and never after (a bootstrapped instance does not print it, and
// does not check it: registration there needs an invitation).
//
// WHEN IT IS REQUIRED: in production, or whenever `LIAISON_SETUP_TOKEN` is set
// explicitly. Local development and the test suites (NODE_ENV other than
// production) keep the zero-friction first registration they have always had.
import { createHmac, timingSafeEqual } from "node:crypto"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { isBootstrapped } from "~/modules/auth/auth"

let requiredOverride: boolean | null = null

/** Test seam: force the requirement on or off; `null` restores the real rule. */
export const SetupTokenTestAccess = {
  setRequired(value: boolean | null): void {
    requiredOverride = value
  },
}

/** The token the first registration must present. */
export function expectedSetupToken(): string {
  const explicit = env.LIAISON_SETUP_TOKEN?.trim()
  if (explicit) return explicit
  return createHmac("sha256", env.JWT_SECRET)
    .update("liaison:setup-token:v1")
    .digest("hex")
    .slice(0, 32)
}

/** Does bootstrap registration need the token on this deployment? */
export function isSetupTokenRequired(): boolean {
  if (requiredOverride !== null) return requiredOverride
  return env.NODE_ENV === "production" || Boolean(env.LIAISON_SETUP_TOKEN?.trim())
}

/** Constant-time comparison of a presented token with the expected one. */
export function setupTokenMatches(presented: string | undefined): boolean {
  if (!presented) return false
  const a = Buffer.from(presented.trim())
  const b = Buffer.from(expectedSetupToken())
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Print the token in the app log, once per boot, while the instance has no
 * organisation yet. The message text is stable so an installer can grep it:
 * `docker compose logs app | grep "Liaison setup token"`. Never throws.
 */
export async function announceSetupToken(): Promise<void> {
  try {
    if (!isSetupTokenRequired()) return
    if (await isBootstrapped()) return
    rootLogger.warn(
      { setupToken: expectedSetupToken() },
      `Liaison setup token: ${expectedSetupToken()} (enter it on the Register page to create the first admin account)`,
    )
  } catch (err) {
    rootLogger.warn({ err }, "could not announce the setup token")
  }
}
