// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ADMINISTRATOR SIGN-IN FROM A NEW ADDRESS. Every completed sign-in (password,
// sign-in link or code, OAuth, the two-factor step that ends one) of an account
// holding an administrative scope checks whether that account signed in from
// this address in the last 90 days. A new one raises `admin_signin_new_ip`
// (security-events.ts): counted on /diag, logged, and a system alert to the
// account and the org's admins.
//
// What is kept, in Redis, per account: one key per address, named by a sha256
// of the account id and the address (never the address itself), holding when
// it was first seen, expiring 90 days after the last sign-in from it. Plus one
// marker that the account has a history at all, with the same expiry: the very
// first sign-in an account makes (a new admin, or the first after this shipped,
// or after Redis lost its data) learns the address silently instead of alerting
// every admin at once.
//
// The address is the one `getClientIp` resolves (trusted proxy hops and CIDRs),
// never a raw forwarded header. Best effort: a failure here never fails the
// sign-in.
import { createHash } from "node:crypto"
import type { Context } from "hono"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { getClientIp } from "~/lib/request-context"
import { emitSecurityEvent } from "~/modules/security/security-events"

const log = rootLogger.child({ module: "admin-signin" })

export const SIGNIN_ADDRESS_RETENTION_SECONDS = 90 * 24 * 60 * 60

export type SignInMethod = "password" | "magic_link" | "oauth" | "totp"

export interface CompletedSignIn {
  userId: string
  orgId: string
  /** Whether the session was minted for an account holding an administrative scope. */
  admin: boolean
}

/** A coarse client family from a User-Agent: browser and OS, or the Liaison app. */
export function userAgentFamily(ua: string | null | undefined): string {
  const s = (ua ?? "").slice(0, 512)
  if (!s) return "unknown client"
  if (/Liaison|Tauri/i.test(s)) {
    if (/iPhone|iPad|Android/i.test(s)) return "Liaison mobile app"
    return "Liaison desktop app"
  }
  const browser = /Edg\//.test(s)
    ? "Edge"
    : /Firefox\//.test(s)
      ? "Firefox"
      : /Chrome\/|CriOS\//.test(s)
        ? "Chrome"
        : /Safari\//.test(s)
          ? "Safari"
          : /curl|bun|node|python|go-http/i.test(s)
            ? "script"
            : "other browser"
  const os = /iPhone|iPad/.test(s)
    ? "iOS"
    : /Android/.test(s)
      ? "Android"
      : /Mac OS X|Macintosh/.test(s)
        ? "macOS"
        : /Windows/.test(s)
          ? "Windows"
          : /Linux/.test(s)
            ? "Linux"
            : null
  return os ? `${browser} on ${os}` : browser
}

export function signInAddressKey(userId: string, ip: string): string {
  const digest = createHash("sha256").update(`signin-address|${userId}|${ip}`).digest("hex")
  return `signin:addr:${userId}:${digest.slice(0, 40)}`
}

export function signInHistoryKey(userId: string): string {
  return `signin:history:${userId}`
}

/**
 * Note a completed sign-in. For an administrator, alert on an address not seen
 * in the retention window. Never throws.
 */
export async function noteSignIn(
  c: Context,
  signIn: CompletedSignIn,
  method: SignInMethod,
): Promise<void> {
  if (!signIn.admin) return
  try {
    const ip = getClientIp(c)
    const now = new Date().toISOString()
    const ttl = SIGNIN_ADDRESS_RETENTION_SECONDS
    const addrKey = signInAddressKey(signIn.userId, ip)
    const historyKey = signInHistoryKey(signIn.userId)
    const fresh = (await redis.set(addrKey, now, "EX", ttl, "NX")) === "OK"
    if (!fresh) {
      // A known address: keep it (and the history marker) for another window.
      await redis.expire(addrKey, ttl)
      await redis.expire(historyKey, ttl)
      return
    }
    const firstEver = (await redis.set(historyKey, now, "EX", ttl, "NX")) === "OK"
    if (firstEver) return
    await redis.expire(historyKey, ttl)
    await emitSecurityEvent({
      kind: "admin_signin_new_ip",
      userId: signIn.userId,
      orgId: signIn.orgId,
      detail: { ip, method, client: userAgentFamily(c.req.header("user-agent")) },
    })
  } catch (err) {
    log.warn({ err, userId: signIn.userId }, "sign-in address check failed")
  }
}
