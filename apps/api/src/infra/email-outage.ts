// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The mail provider refusing this instance's system mail as a whole: its quota
// ran out, its credentials are refused, it cannot be reached. Instance-wide state
// (Redis, every process), never about an address, so a flow that promises an
// email can say it cannot send one to everybody alike.
//
// A send is only attempted for a known address, so the state must not move on
// what an unknown address did:
//  - while it is set, every request gets the same refusal and sends nothing;
//  - once a minute one request goes through as a probe. Whatever its address
//    does, it is answered from the state afterwards: still set, the same refusal;
//  - only an accepted send clears it, so the first mail after the provider is
//    back ends the outage for all.
// What an observer can still learn: one request's answer at the very start of an
// outage, and one at its very end, differ by whether a send was attempted.

import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"

const log = rootLogger.child({ service: "email-outage" })

export type EmailOutageKind = "quota" | "credentials" | "unreachable"

export interface EmailOutage {
  kind: EmailOutageKind
  /** ISO time of the first refusal. */
  since: string
  /** The provider's own short reason (never a recipient or message content). */
  detail: string
}

const OUTAGE_KEY = "system-email:outage"
const PROBE_KEY = "system-email:outage-probe"
/** A backstop only: the state ends on an accepted send. */
const OUTAGE_TTL_SECONDS = 48 * 60 * 60
const PROBE_EVERY_SECONDS = 60

export async function noteEmailProviderRefused(
  kind: EmailOutageKind,
  detail: string,
): Promise<void> {
  const outage: EmailOutage = {
    kind,
    since: new Date().toISOString(),
    detail: detail.slice(0, 120),
  }
  // This refusal was the minute's try.
  await redis.set(PROBE_KEY, "1", "EX", PROBE_EVERY_SECONDS)
  const first = await redis.set(OUTAGE_KEY, JSON.stringify(outage), "EX", OUTAGE_TTL_SECONDS, "NX")
  if (first !== null) {
    log.error(
      { kind, detail: outage.detail },
      "Mail provider refused system mail: sign-in mail is off",
    )
    return
  }
  await redis.expire(OUTAGE_KEY, OUTAGE_TTL_SECONDS)
}

export async function noteEmailProviderAccepted(): Promise<void> {
  const cleared = await redis.del(OUTAGE_KEY)
  if (cleared > 0) log.info("Mail provider accepts system mail again")
}

export async function readEmailOutage(): Promise<EmailOutage | null> {
  const raw = await redis.get(OUTAGE_KEY)
  if (raw === null) return null
  return JSON.parse(raw) as EmailOutage
}

/** True for at most one caller per minute: that request tries a send during an outage. */
export async function claimEmailOutageProbe(): Promise<boolean> {
  return (await redis.set(PROBE_KEY, "1", "EX", PROBE_EVERY_SECONDS, "NX")) !== null
}

/** Test isolation. */
export async function _clearEmailOutage(): Promise<void> {
  await redis.del(OUTAGE_KEY, PROBE_KEY)
}
