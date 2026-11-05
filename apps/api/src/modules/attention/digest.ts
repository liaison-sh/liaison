// SPDX-License-Identifier: FSL-1.1-ALv2
import { localizeAgentNotice, resolveLocale, type ShippedLocale } from "@liaison/shared"
import { type EmailMessage, escapeHtml } from "~/infra/email"
import { serverT } from "~/modules/i18n/server-i18n"

export interface PendingAttentionRow {
  id: string
  orgId: string
  userId: string
  app: string
  entityType: string
  entityId: string
  kind: string
  urgency: number
  summary: string
  isUrgent: boolean
  occurredAt: Date
  /** The channel a `reply_thread` row's root lives in (its `metadata.threadId`). */
  threadId?: string
  /**
   * D14: the row carries `metadata.requiredScopes` (it came from a tainted turn), so the
   * email shows a generic line, never its summary.
   */
  redacted?: boolean
}

export type DigestCadence = "urgent" | "immediate" | "hourly" | "daily"

/** Stable FNV-1a 32-bit hash. */
export function hashFNV1a(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

/**
 * Idempotency key for a given send attempt. The same set of row ids in the
 * same cadence window must produce the same key so retries through Resend are
 * suppressed by their server-side idempotency layer.
 */
export function buildIdempotencyKey(
  cadence: DigestCadence,
  userId: string,
  window: string,
  rowIds: string[],
): string {
  const sorted = [...rowIds].sort().join(",")
  return `attention-digest:${cadence}:${userId}:${window}:${hashFNV1a(sorted)}`
}

type Tr = (key: string, params?: Record<string, string | number | boolean>) => string

function formatRelative(occurredAt: Date, now: Date, tr: Tr): string {
  const diffMs = now.getTime() - occurredAt.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return tr("kernel.digest.relativeJustNow")
  if (diffMin < 60) return tr("kernel.digest.relativeMinutes", { n: diffMin })
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return tr("kernel.digest.relativeHours", { n: diffHr })
  const diffDay = Math.floor(diffHr / 24)
  return tr("kernel.digest.relativeDays", { n: diffDay })
}

/**
 * Resolve a deep-link path for a digest row using the entity's tab URL pattern.
 * Falls back to `/<entityType>/<entityId>` for unknown app/entity combinations,
 * which mirrors the kernel default and is preferable to a `?attention=` hack
 * because the receiving client wires the URL into the existing tab system.
 */
export function buildDeepLinkPath(
  app: string,
  entityType: string,
  entityId: string,
  threadId?: string,
): string {
  const idSafe = encodeURIComponent(entityId)
  if (app === "kernel") {
    if (entityType === "thread") return `/threads/${idSafe}`
    // A followed reply thread is keyed on its root; the link opens its channel.
    if (entityType === "reply_thread" && threadId) {
      return `/threads/${encodeURIComponent(threadId)}`
    }
    if (entityType === "approval_request") return `/approvals/${idSafe}`
    // A computer session's notice opens the Sessions app on it.
    if (entityType === "node_session") return `/sessions/${idSafe}`
  }
  // Manifest-defined entities follow the convention `/<entityType plural>/<id>`
  // — apps using a different pattern can override this in a future release.
  return `/${entityType}s/${idSafe}`
}

const KIND_KEYS: Record<string, string> = {
  mention: "kernel.digest.kindMention",
  thread_reply: "kernel.digest.kindReply",
  thread_followup: "kernel.digest.kindReply",
  approval_decision: "kernel.digest.kindApproval",
  system_alert: "kernel.digest.kindAlert",
  file_shared: "kernel.digest.kindFile",
  node_session_needs_you: "kernel.digest.kindSessionNeedsYou",
  node_session_done: "kernel.digest.kindSessionDone",
  node_session_failed: "kernel.digest.kindSessionFailed",
}

/**
 * A row's summary in the recipient's language when it is an agent's failure line (a
 * `thread_reply` summary quotes the message, and the runtime writes that message in fixed
 * English); any other summary is the author's own text and is left as written.
 */
function rowSummary(r: PendingAttentionRow, tr: Tr): string {
  if (r.redacted) return tr("kernel.digest.redactedSummary")
  return localizeAgentNotice(r.summary, (key) => tr(key))
}

function kindLabel(kind: string, tr: Tr): string {
  const key = KIND_KEYS[kind]
  return key ? tr(key) : kind.replace(/_/g, " ")
}

/**
 * Render the digest email. The HTML is table-layout, inline-styled, and
 * dark-mode-aware via `@media (prefers-color-scheme: dark)` (honored by
 * Apple Mail, Thunderbird, iOS Mail; Gmail and Outlook web ignore but the
 * light palette still reads correctly there).
 *
 * Design constraints worth preserving on edits:
 *   1. Tables for layout — Outlook 2007–2019 desktop renders no flex/grid.
 *   2. Inline styles everywhere a desktop client might strip `<head><style>`.
 *      The `<style>` block carries only dark-mode + hover progressive
 *      enhancements that are safe to lose.
 *   3. No external assets — emails ship self-contained; no image, no webfont,
 *      no tracking pixel. The wordmark is text-only.
 *   4. Width 560 px on a 600 px outer wrapper for comfortable margins.
 *   5. Subject + plain-text variant stay close to the v1 minimal shape so
 *      existing user-side filters keep working.
 *
 * Inputs trusted vs untrusted:
 *   - `baseUrl` and `toAddress` are trusted (env config / DB-validated email).
 *     They are interpolated raw into href/text — callers must ensure they are
 *     URL-safe and HTML-safe.
 *   - `rows[*].summary`, `rows[*].kind`, and the formatted relative-time
 *     string are passed through `escapeHtml` because summaries derive from
 *     user-controlled content (mention bodies, file names, etc.).
 *   - `rows` must be non-empty. Digest jobs filter empty groups before
 *     calling; the assertion below short-circuits any caller that doesn't.
 */
export function renderDigestEmail(args: {
  rows: PendingAttentionRow[]
  baseUrl: string
  now: Date
  toAddress: string
  /** Recipient's persisted UI language (I6). Unset/unshipped → English. */
  locale?: string | null
}): EmailMessage {
  const { rows, baseUrl, now, toAddress } = args
  if (rows.length === 0) {
    throw new Error("renderDigestEmail called with zero rows — callers must filter empty groups")
  }
  const locale: ShippedLocale = resolveLocale(args.locale ?? null, null)
  const tr: Tr = (key, params) => serverT(locale, key, params)
  const count = rows.length
  const subject =
    count === 1
      ? tr("kernel.digest.subjectOne", { count })
      : tr("kernel.digest.subjectMany", { count })

  const rowsHtml = rows
    .map((r, i) => {
      const rel = escapeHtml(formatRelative(r.occurredAt, now, tr))
      const label = escapeHtml(kindLabel(r.kind, tr))
      const summary = escapeHtml(rowSummary(r, tr))
      const href = `${baseUrl}${buildDeepLinkPath(r.app, r.entityType, r.entityId, r.threadId)}`
      const borderTop = i === 0 ? "" : "border-top:1px solid #e7e6e1;"
      return `
        <tr><td style="padding:18px 22px;${borderTop}">
          <div style="font-family:'SF Mono','Menlo','Consolas',monospace;font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:#7a786f;margin:0 0 6px 0;">
            <span class="kind-label">${label}</span>
            <span style="color:#a8a69b;"> &middot; </span>
            <span>${rel}</span>
          </div>
          <div style="font-family:'Charter','Iowan Old Style','Georgia',serif;font-size:16px;line-height:1.45;color:#15171a;margin:0 0 10px 0;">
            ${summary}
          </div>
          <a href="${href}" class="row-link" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;font-weight:500;color:#3a4a78;text-decoration:none;">
            ${escapeHtml(tr("kernel.digest.open"))} &rarr;
          </a>
        </td></tr>`
    })
    .join("")

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(subject)}</title>
<style>
  @media (prefers-color-scheme: dark) {
    body, .bg { background:#0f1014 !important; }
    .card { background:#191a1f !important; border-color:#26262c !important; }
    .body-text { color:#cdcdd4 !important; }
    .muted { color:#8a8a92 !important; }
    .row-border { border-color:#26262c !important; }
    .kind-label, .meta { color:#8a8a92 !important; }
    .row-link { color:#a3b3e0 !important; }
    .cta { background:#cdcdd4 !important; color:#0f1014 !important; }
    .divider { border-color:#26262c !important; }
  }
  .row-link:hover { text-decoration:underline !important; }
  .cta:hover { opacity:0.92 !important; }
</style>
</head>
<body class="bg" style="margin:0;padding:0;background:#f6f5f0;-webkit-font-smoothing:antialiased;">
<table class="bg" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f5f0;">
  <tr><td align="center" style="padding:32px 16px 48px 16px;">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:100%;">

      <!-- Header -->
      <tr><td style="padding:0 4px 22px 4px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="font-family:'Charter','Iowan Old Style','Georgia',serif;font-size:18px;font-weight:600;letter-spacing:-0.01em;color:#15171a;" class="body-text">
              Liaison
            </td>
            <td align="right" class="muted" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#7a786f;">
              ${escapeHtml(formatHeaderDate(now))}
            </td>
          </tr>
        </table>
      </td></tr>

      <!-- Headline -->
      <tr><td style="padding:0 4px 18px 4px;">
        <h1 class="body-text" style="margin:0;font-family:'Charter','Iowan Old Style','Georgia',serif;font-size:24px;font-weight:500;line-height:1.25;color:#15171a;letter-spacing:-0.01em;">
          ${escapeHtml(
            count === 1
              ? tr("kernel.digest.headlineOne", { count })
              : tr("kernel.digest.headlineMany", { count }),
          )}
        </h1>
      </td></tr>

      <!-- Card with rows -->
      <tr><td>
        <table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e7e6e1;border-radius:6px;">
          ${rowsHtml}
        </table>
      </td></tr>

      <!-- CTA -->
      <tr><td align="center" style="padding:28px 4px 0 4px;">
        <a href="${baseUrl}" class="cta" style="display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;font-weight:600;letter-spacing:0.01em;color:#ffffff;background:#15171a;text-decoration:none;padding:11px 22px;border-radius:4px;">
          ${escapeHtml(tr("kernel.digest.openLiaison"))} &rarr;
        </a>
      </td></tr>

      <!-- Footer -->
      <tr><td style="padding:36px 4px 0 4px;">
        <hr class="divider" style="border:none;border-top:1px solid #e7e6e1;margin:0 0 16px 0;" />
        <p class="muted" style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:11.5px;line-height:1.55;color:#7a786f;">
          ${escapeHtml(tr("kernel.digest.footer"))}
          <br />
          <a href="${baseUrl}/settings/notifications" class="row-link" style="color:#7a786f;text-decoration:underline;">${escapeHtml(
            tr("kernel.digest.footerLinkText"),
          )}</a>
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`

  const text = [
    subject,
    "",
    ...rows.map((r) => {
      const label = kindLabel(r.kind, tr)
      const rel = formatRelative(r.occurredAt, now, tr)
      const href = `${baseUrl}${buildDeepLinkPath(r.app, r.entityType, r.entityId, r.threadId)}`
      return `[${label} · ${rel}]  ${rowSummary(r, tr)}\n  ${href}`
    }),
    "",
    `${tr("kernel.digest.openLiaison")}: ${baseUrl}`,
    `${tr("kernel.digest.managePreferences")}: ${baseUrl}/settings/notifications`,
  ].join("\n")

  return {
    to: toAddress,
    subject,
    html,
    text,
    template: "attention.digest",
  }
}

function formatHeaderDate(now: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(now)
}

/** Group a flat list of pending rows by userId. */
export function groupByUser(rows: PendingAttentionRow[]): Map<string, PendingAttentionRow[]> {
  const out = new Map<string, PendingAttentionRow[]>()
  for (const r of rows) {
    const arr = out.get(r.userId) ?? []
    arr.push(r)
    out.set(r.userId, arr)
  }
  return out
}

interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function getLocalParts(date: Date, tz: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
  const parts = fmt.formatToParts(date)
  const map: Record<string, string> = {}
  for (const p of parts) if (p.type !== "literal") map[p.type] = p.value
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
  }
}

/**
 * True when the user's local clock has crossed 08:00 since `lastSentAt` (or
 * since the previous local 08:00 if `lastSentAt` is null). Used by the daily
 * digest scheduler running every 5 minutes.
 */
export function shouldFireDailyDigest(
  now: Date,
  timezone: string,
  lastSentAt: Date | null,
): boolean {
  const local = getLocalParts(now, timezone)
  const localMinutes = local.hour * 60 + local.minute
  if (localMinutes < 8 * 60) return false
  if (!lastSentAt) return true
  const lastLocal = getLocalParts(lastSentAt, timezone)
  // Already sent on this local calendar day?
  return !(
    lastLocal.year === local.year &&
    lastLocal.month === local.month &&
    lastLocal.day === local.day
  )
}

/** Discrete window label used in idempotency keys. */
export function windowLabel(cadence: DigestCadence, now: Date): string {
  if (cadence === "daily") return now.toISOString().slice(0, 10)
  if (cadence === "hourly") return now.toISOString().slice(0, 13)
  return now.toISOString().slice(0, 16)
}
