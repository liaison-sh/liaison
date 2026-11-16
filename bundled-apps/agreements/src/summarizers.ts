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

const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const done = (c: Card): Promise<Card> =>
  Promise.resolve({ ...c, lines: c.lines.slice(0, 40).map((l) => clip(l)) })

function signerLine(s: unknown, i: number): string {
  const o = (s ?? {}) as { contact_id?: string; email?: string; name?: string }
  const who = o.name ?? o.email ?? "a contact"
  return `Signer ${i + 1}: ${who}${o.email && o.name ? ` <${o.email}>` : ""}`
}

export function summarizeAgreementSend(params: Record<string, unknown>): Promise<Card> {
  const signers = Array.isArray(params.signers) ? params.signers : []
  const order = params.order === "any" ? "in any order" : "one after the other"
  const mode = params.mode === "accept" ? "an acceptance" : "a simple electronic signature"
  const lines = [
    `Fingerprint: ${String(params.sha256 ?? "")}`,
    `Asks: ${mode}, ${order}`,
    ...signers.map(signerLine),
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
