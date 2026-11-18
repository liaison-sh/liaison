// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Approval cards of the gated tools, built from the parked payload alone (the
// sandbox evaluates this bundle; no database read). The handler checks the
// version and its fingerprint again when the card is approved.

interface Card {
  kind: string
  title: string
  subtitle?: string
  lines: string[]
}

import { moneyText, replyAsSent, replyWithLinkNote } from "./change-request-send"

const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const done = (c: Card): Promise<Card> =>
  Promise.resolve({ ...c, lines: c.lines.slice(0, 40).map((l) => clip(l)) })

/**
 * One signer on the card. A signer named by contact only carries no address in the call: the
 * preflight's pinned check lists each signer's address, in the same order.
 */
function signerLine(s: unknown, i: number, pinned: unknown[]): string {
  const o = (s ?? {}) as { contact_id?: string; email?: string; name?: string }
  const email = o.email ?? (typeof pinned[i] === "string" ? (pinned[i] as string) : undefined)
  const who = o.name ?? email ?? "a contact"
  return `Signer ${i + 1}: ${who}${email && o.name ? ` <${email}>` : ""}`
}

function pinnedAddresses(params: Record<string, unknown>): unknown[] {
  const a = (params.sendGuard as { addresses?: unknown } | undefined)?.addresses
  return Array.isArray(a) ? a : []
}

export function summarizeAgreementSend(params: Record<string, unknown>): Promise<Card> {
  const signers = Array.isArray(params.signers) ? params.signers : []
  const order = params.order === "any" ? "in any order" : "one after the other"
  const mode = params.mode === "accept" ? "an acceptance" : "a simple electronic signature"
  const lines = [
    `Fingerprint: ${String(params.sha256 ?? "")}`,
    `Asks: ${mode}, ${order}`,
    ...signers.map((x, i) => signerLine(x, i, pinnedAddresses(params))),
    `Links last ${String(params.expires_in_days ?? 14)} days`,
  ]
  if (typeof params.required_phrase === "string" && params.required_phrase)
    lines.push(`Each signer types: "${params.required_phrase}"`)
  if (typeof params.message === "string" && params.message) lines.push(`Message: ${params.message}`)
  return done({
    kind: "agreement_send",
    title: `Send a frozen agreement version to ${signers.length} signer(s)`,
    subtitle: "Nothing is sent if the version changed since this card",
    lines,
  })
}

/** The rate and the price it makes, in the agreement's currency; nothing for an unreadable rate. */
function moneyLines(rate: unknown, minutes: number, currency: unknown): string[] {
  const minor =
    typeof rate === "string" && /^\d{1,15}$/.test(rate)
      ? BigInt(rate)
      : typeof rate === "number" && Number.isSafeInteger(rate) && rate >= 0
        ? BigInt(rate)
        : null
  if (minor === null) return [`Rate: ${String(rate ?? "not set")}`]
  const cur = typeof currency === "string" && currency ? currency : null
  const lines = [`Rate: ${moneyText(minor, cur)} per hour`]
  if (Number.isSafeInteger(minutes) && minutes >= 0)
    lines.push(`Price: ${moneyText((minor * BigInt(minutes) + 30n) / 60n, cur)}`)
  return lines
}

/** The reply as the approved call sends it, from the payload's own hours and rate. */
function replyShown(body: string, params: Record<string, unknown>, minutes: number): string {
  const rate = params.rate_minor
  const minor =
    typeof rate === "string" && /^\d{1,15}$/.test(rate)
      ? BigInt(rate)
      : typeof rate === "number" && Number.isSafeInteger(rate) && rate >= 0
        ? BigInt(rate)
        : null
  if (minor === null || !Number.isSafeInteger(minutes) || minutes <= 0)
    return replyWithLinkNote(body, null)
  const currency = typeof params.currency === "string" && params.currency ? params.currency : null
  return replyAsSent(body, { minutes, rate: minor, currency }, null)
}

export function summarizeChangeRequestSend(params: Record<string, unknown>): Promise<Card> {
  const reply = (params.reply ?? {}) as { body?: unknown }
  const work = Array.isArray(params.work) ? params.work.map(String) : []
  const minutes = Number(params.hours_minutes ?? 0)
  const lines = [
    `Change request: ${String(params.title ?? "")}`,
    ...work.map((w) => `Work: ${w}`),
    `Hours: ${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""} (from ${String(params.hours_source ?? "not said")})`,
    ...moneyLines(params.rate_minor, minutes, params.currency),
    "The client approves it on a link with an emailed code: a recorded approval, not a signature.",
  ]
  const card = {
    kind: "change_request_send",
    title: "Reply to the client and send a change request",
    subtitle: "Nothing is sent if the client wrote after this card",
    lines,
  }
  // The reply is read whole before it goes out: it is not cut like the other lines.
  return done(card).then((c) => ({
    ...c,
    lines: [`Reply:\n${replyShown(String(reply.body ?? ""), params, minutes)}`, ...c.lines].slice(
      0,
      16,
    ),
  }))
}

export function summarizeAgreementVoid(params: Record<string, unknown>): Promise<Card> {
  return done({
    kind: "agreement_void",
    title: "Void an agreement waiting for signatures",
    subtitle: "Every open signing link is withdrawn; signatures already given stay",
    lines: [`Reason: ${String(params.reason ?? "")}`],
  })
}

export function summarizeAgreementReminderSend(): Promise<Card> {
  return done({
    kind: "agreement_reminder_send",
    title: "Remind the signers of an agreement",
    subtitle:
      "Each signer whose link is still open gets a fresh link; the one mailed before stops working",
    lines: ["Signers who answered, or who wait for the signer before them, get nothing"],
  })
}

export function summarizeAgreementNewLink(params: Record<string, unknown>): Promise<Card> {
  const email = typeof params.email === "string" && params.email ? params.email : null
  return done({
    kind: "agreement_new_link",
    title: "A new signing link for one signer",
    subtitle: "Their earlier link stops working; signatures already given stand",
    lines: [
      email ? `Sent to: ${email} (corrected address)` : "Sent to: the signer's address on file",
      `Link lasts ${String(params.expires_in_days ?? 14)} days`,
    ],
  })
}
