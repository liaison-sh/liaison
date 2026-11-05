// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Platform DM reply-window classification. Meta's messaging policy lets a Page
// reply within 24h of the last inbound message under the standard window; the
// HUMAN_AGENT tag extends that to 7 days. Past 7 days the window is closed —
// no API send is possible and the UI must point the user to the native app.
//
// Boundaries are INCLUSIVE (≤), not strict (<): exactly 24h is still `none`,
// exactly 7d is still `human_agent`. The 24h/7d boundary tests pin this.

const H = 3_600_000
const DAY = 24 * H

export type DmWindowTag = "none" | "human_agent" | "closed"

export function dmWindowTag(
  lastInboundAt: string | Date | null,
  now: Date = new Date(),
): DmWindowTag {
  if (lastInboundAt == null) return "closed"
  const t = typeof lastInboundAt === "string" ? Date.parse(lastInboundAt) : lastInboundAt.getTime()
  if (Number.isNaN(t)) return "closed"
  const delta = now.getTime() - t
  if (delta <= 24 * H) return "none"
  if (delta <= 7 * DAY) return "human_agent"
  return "closed"
}

/**
 * Agent-readable reply-window descriptor (§9 #2). The reply window is recomputed
 * from the LAST INBOUND message and is what decides whether a `send_dm` can be
 * delivered and HOW (standard vs human-agent tag) vs not at all (closed → native
 * app only). dm_get / dm_list attach this to each conversation so the agent does
 * NOT have to do date arithmetic on a raw `last_inbound_at` timestamp itself
 * (a weak-model failure mode: mis-reading "5 days ago" as inside the 24h window
 * or as fully closed). It surfaces the window state at READ time, BEFORE the
 * gated send is proposed, so the agent can frame the send honestly (a normal
 * standard reply, an outside-24h human-agent reply, or — when closed — decline
 * the send and point the user to the native app instead of claiming/attempting
 * a doomed send).
 */
export interface DmReplyWindow {
  /** Canonical tag: `none` ≤24h standard · `human_agent` ≤7d · `closed` >7d / no inbound. */
  tag: DmWindowTag
  /** Can a `send_dm` be delivered via the API right now? (false ⇒ closed window.) */
  canSend: boolean
  /** Whole-days since the last inbound message (null when there is no inbound). */
  daysSinceLastInbound: number | null
  /** Plain-English window state the agent surfaces verbatim to the user. */
  explanation: string
}

export function dmReplyWindow(
  lastInboundAt: string | Date | null,
  now: Date = new Date(),
): DmReplyWindow {
  const tag = dmWindowTag(lastInboundAt, now)
  let daysSinceLastInbound: number | null = null
  if (lastInboundAt != null) {
    const t =
      typeof lastInboundAt === "string" ? Date.parse(lastInboundAt) : lastInboundAt.getTime()
    if (!Number.isNaN(t)) {
      daysSinceLastInbound = Math.floor((now.getTime() - t) / DAY)
    }
  }
  switch (tag) {
    case "none":
      return {
        tag,
        canSend: true,
        daysSinceLastInbound,
        explanation:
          "Within the platform's standard 24-hour messaging window, so a reply sends as a normal " +
          "in-platform message. The send is still gated (staged for approval, never auto-sent).",
      }
    case "human_agent":
      return {
        tag,
        canSend: true,
        daysSinceLastInbound,
        explanation:
          "OUTSIDE the platform's standard 24-hour window but still inside the extended human-agent " +
          "window (up to 7 days since the last inbound). The reply is still deliverable, but it goes " +
          "as a HUMAN-AGENT message: surface that to the user, never send it silently as if it were a " +
          "normal reply. The send is gated (staged for approval, never auto-sent). The window is " +
          "recomputed at send time, so it could lapse before approval.",
      }
    default:
      return {
        tag,
        canSend: false,
        daysSinceLastInbound,
        explanation:
          lastInboundAt == null
            ? "No inbound message on record, so the reply window cannot be opened, so an API send is not " +
              "possible. Do NOT claim a message was sent; tell the user the message must go via the " +
              "native app or another channel."
            : "The reply window is CLOSED (more than 7 days since the last inbound message), so an API " +
              "send is not possible and would be rejected at send time. Do NOT claim or attempt a send; " +
              "tell the user the messaging window has closed and the message must go via the native app " +
              "or another channel.",
      }
  }
}
