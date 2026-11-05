// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Security alert signals: the moments an operator or an org admin should hear
// about, emitted through ONE helper so every site says the same thing the same
// way.
//
//   guess_ceiling          an account used up a budget of wrong answers to one
//                          factor (password, TOTP, step-up code or password,
//                          sign-in code). Emitted on the answer that reaches
//                          the ceiling, so once per crossing, not per refusal.
//   lockout                a brute-force counter reached its block threshold
//                          (an identifier, or a source address).
//   mcp_client_registered  a new MCP OAuth client registered (dynamic client
//                          registration is unauthenticated by design).
//   malware_quarantined    the virus scanner (CLAMAV_HOST) found an inbound
//                          attachment infected; it was kept in quarantine.
//   admin_signin_new_ip    an account holding an administrative scope signed in
//                          from an address it has not signed in from in the
//                          last 90 days (admin-signin.ts). The account itself
//                          is told too, not only the org's admins.
//   clamav_unavailable     CLAMAV_HOST is set but clamd could not be reached
//                          (refused, unresolvable, timed out); the attachment
//                          was stored unscanned. Counted on every failure, the
//                          org alert at most once an hour per org and process.
//
// Each signal goes three ways, none of them new machinery:
//
//   1. a structured log line (service "security", `securityEvent`, `alert`),
//      the same `alert:` convention the rest of the API logs for operators;
//   2. a per-kind counter on `/diag` (`securityEvents`), which the monitor
//      watchdog already polls, so a burst is visible without a log search;
//   3. when the signal belongs to an org, a kernel `security_event:create`
//      event, which the attention translator turns into a `system_alert` for
//      the org's admins (kernel-translations.ts). The row is keyed per signal,
//      account and day, so a second crossing the same day refreshes one row
//      instead of adding another.
//
// Best effort by construction: a signal must never fail or slow the request
// that raised it, so every failure here is logged and swallowed.
import { createHash } from "node:crypto"
import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import type { AppEvent } from "~/infra/events/event-bus"
import { rootLogger } from "~/lib/logger"

export const securityLogger = rootLogger.child({ service: "security" })

export type SecurityEventKind =
  | "guess_ceiling"
  | "lockout"
  | "mcp_client_registered"
  | "malware_quarantined"
  | "admin_signin_new_ip"
  | "clamav_unavailable"

export type SecurityFactor =
  | "password"
  | "totp"
  | "step_up_code"
  | "step_up_password"
  | "sign_in_code"

export interface SecuritySignal {
  kind: SecurityEventKind
  /** The factor whose budget ran out (guess_ceiling). */
  factor?: SecurityFactor
  /** The account concerned, when known. Its org is looked up when `orgId` is not given. */
  userId?: string | null
  orgId?: string | null
  /** What the counter is keyed on (lockout): an address or an identifier. */
  scope?: "identifier" | "address"
  /** Free, non-secret detail for the log line (a client name, a count). */
  detail?: Record<string, unknown>
  /**
   * The org alert (not the log line or the counter) at most once per this many
   * milliseconds per signal kind and org, in this process. For a signal that
   * repeats on every request while a dependency is down.
   */
  orgAlertEveryMs?: number
}

interface Counter {
  count: number
  lastAt: string
}

const counters = new Map<string, Counter>()

function counterKey(signal: SecuritySignal): string {
  const sub = signal.factor ?? signal.scope
  return sub ? `${signal.kind}:${sub}` : signal.kind
}

/** Signals since this process started, per kind (and factor or scope). Served on /diag. */
export function getSecurityEventDiag(): Record<string, Counter> {
  return Object.fromEntries([...counters].map(([k, v]) => [k, { ...v }]))
}

/** When each throttled signal last reached an org, per `kind|orgId`. */
const lastOrgAlert = new Map<string, number>()

/** Test seam: forget the counters and the alert throttle. */
export function resetSecurityEventDiag(): void {
  counters.clear()
  lastOrgAlert.clear()
}

const FACTOR_LABEL: Record<SecurityFactor, string> = {
  password: "wrong passwords",
  totp: "wrong two-factor codes",
  step_up_code: "wrong confirmation codes",
  step_up_password: "wrong passwords at a confirmation step",
  sign_in_code: "wrong sign-in codes",
}

/** The admin-facing line. Names the factor and never the guessed values. */
export function securityEventSummary(signal: SecuritySignal, accountLabel?: string | null): string {
  const who = accountLabel ? ` for ${accountLabel}` : ""
  switch (signal.kind) {
    case "guess_ceiling":
      return `Security: too many ${signal.factor ? FACTOR_LABEL[signal.factor] : "wrong answers"}${who}; that sign-in method is blocked for now`
    case "lockout":
      return `Security: repeated failed sign-ins${who}; further attempts are blocked for now`
    case "mcp_client_registered":
      return "Security: a new MCP client registered"
    case "malware_quarantined":
      return "Security: the virus scanner removed an inbound attachment and kept it in quarantine"
    case "admin_signin_new_ip": {
      const d = signal.detail ?? {}
      const from = typeof d.ip === "string" ? ` from ${d.ip}` : " from a new address"
      const client = typeof d.client === "string" ? ` (${d.client})` : ""
      return `Security: an administrator sign-in${who}${from}${client}, an address not used in the last 90 days. If this was not you, change the password and sign out other sessions.`
    }
    case "clamav_unavailable":
      return "Security: the virus scanner could not be reached; inbound attachments are being stored unscanned"
  }
}

/**
 * The attention row's entity id: one per signal, factor, account and UTC day,
 * shaped like a uuid. A repeat the same day lands on the same unread row.
 */
export function securityEventEntityId(signal: SecuritySignal, now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10)
  const h = createHash("sha256")
    .update(`${counterKey(signal)}|${signal.userId ?? ""}|${signal.orgId ?? ""}|${day}`)
    .digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** The kernel event an org-scoped signal becomes. Pure, so the translation is testable alone. */
export function securityAppEvent(
  signal: SecuritySignal & { orgId: string },
  accountLabel?: string | null,
  now: Date = new Date(),
): AppEvent {
  return {
    app: "kernel",
    entity: "security_event",
    action: "create",
    entityId: securityEventEntityId(signal, now),
    orgId: signal.orgId,
    actorType: "system",
    actorId: null,
    timestamp: now.toISOString(),
    data: {
      securityEvent: signal.kind,
      factor: signal.factor ?? null,
      subjectUserId: signal.userId ?? null,
      ...(signal.detail?.method ? { method: signal.detail.method } : {}),
      summary: securityEventSummary(signal, accountLabel),
    },
  }
}

/** Emit one security signal: log, count, and alert the org's admins when it has an org. */
export async function emitSecurityEvent(signal: SecuritySignal): Promise<void> {
  const key = counterKey(signal)
  const prev = counters.get(key)
  counters.set(key, { count: (prev?.count ?? 0) + 1, lastAt: new Date().toISOString() })
  securityLogger.warn(
    {
      securityEvent: signal.kind,
      alert: `security_${signal.kind}`,
      factor: signal.factor,
      scope: signal.scope,
      userId: signal.userId ?? undefined,
      orgId: signal.orgId ?? undefined,
      ...signal.detail,
    },
    "security event",
  )

  try {
    let orgId = signal.orgId ?? null
    let accountLabel: string | null = null
    if (signal.userId) {
      const [row] = await withSystemDb("security-event-user", (db) =>
        db
          .select({ orgId: users.orgId, name: users.name, email: users.email })
          .from(users)
          .where(eq(users.id, signal.userId as string))
          .limit(1),
      )
      if (row) {
        orgId ??= row.orgId
        accountLabel = row.name || row.email
      }
    }
    if (!orgId) return
    if (signal.orgAlertEveryMs) {
      const throttleKey = `${signal.kind}|${orgId}`
      const last = lastOrgAlert.get(throttleKey)
      const nowMs = Date.now()
      if (last !== undefined && nowMs - last < signal.orgAlertEveryMs) return
      lastOrgAlert.set(throttleKey, nowMs)
    }
    const event = securityAppEvent({ ...signal, orgId }, accountLabel)
    await withSystemDb("security-event", (db) => db.queueEvent(event))
  } catch (err) {
    securityLogger.warn(
      { err, securityEvent: signal.kind },
      "security event could not reach the org",
    )
  }
}
