// SPDX-License-Identifier: FSL-1.1-ALv2
export const INTERNAL_TAG = "[INTERNAL]"
export const TRUNCATION_MARKER = "[earlier messages truncated — see prior summary]"

export type CapMsg = {
  id?: string
  textBody?: string | null
  htmlBody?: string | null
  kind: string
  sentAt: string
  fromEmail?: string | null
}

export function capMessages(
  messages: CapMsg[],
  opts: { maxMessages: number; maxInputTokens: number },
): { messages: CapMsg[]; truncated: boolean } {
  const tail = messages.slice(-opts.maxMessages)
  const droppedFromHead = messages.length - tail.length
  let total = 0
  const kept: CapMsg[] = []
  for (let i = tail.length - 1; i >= 0; i--) {
    const text = tail[i].textBody || tail[i].htmlBody || ""
    const tokens = Math.ceil(text.length / 4)
    if (total + tokens > opts.maxInputTokens) break
    total += tokens
    kept.unshift(tail[i])
  }
  const truncated = droppedFromHead > 0 || kept.length < tail.length
  return { messages: kept, truncated }
}

export type PromptInputs = {
  skill: string
  ticket: {
    handle: string
    subject: string
    status: string
    priority: string
    categoryName: string | null
    contactName: string | null
    fromEmail: string | null
  }
  previousSummary: string
  newMessages: CapMsg[]
  truncated: boolean
}

export function assemblePrompt(p: PromptInputs): string {
  const contact = p.ticket.contactName ?? p.ticket.fromEmail ?? "unknown"
  const header =
    `Ticket #${p.ticket.handle}: ${p.ticket.subject}\n` +
    `Contact: ${contact}\n` +
    `Status: ${p.ticket.status}, Priority: ${p.ticket.priority}, Category: ${
      p.ticket.categoryName ?? "(uncategorized)"
    }`
  const prevBlock = p.previousSummary ? `\nPrevious summary:\n${p.previousSummary}\n` : ""
  const truncBlock = p.truncated ? `${TRUNCATION_MARKER}\n` : ""
  const msgBlock = p.newMessages
    .map((m) => {
      const tag = m.kind === "note" ? `${INTERNAL_TAG} ` : ""
      const body = m.textBody ?? m.htmlBody ?? ""
      return `${tag}[${m.sentAt}] ${m.fromEmail ?? ""}: ${body}`
    })
    .join("\n")
  return `${p.skill}\n\n${header}\n${prevBlock}\n${truncBlock}${msgBlock}`
}
