// SPDX-License-Identifier: FSL-1.1-ALv2
// Ticket draft store — localStorage-backed composer drafts keyed as
// `tickets.draft.<userId>.<ticketId>.<reply|note>` so text a human typed but
// never sent survives tab switches/reloads for the same browser profile.
// (Denied/expired gated replies are NOT restored here — editing a gated
// draft happens in place on its ApprovalCard.)
import { createStore, produce } from "solid-js/store"
import { onSessionTeardown } from "~/lib/session-lifecycle"

export interface TicketDraftPayload {
  body?: string
  textBody?: string
  htmlBody?: string
  followup?: { at?: string; reason?: string; trigger?: string }
}

interface DraftRecord {
  body: string
  payload: TicketDraftPayload
  updatedAt: string
}

interface DraftState {
  drafts: Record<string, DraftRecord>
}

export function draftKey(userId: string, ticketId: string, kind: "reply" | "note"): string {
  return `tickets.draft.${userId}.${ticketId}.${kind}`
}

function readRecord(key: string): DraftRecord | undefined {
  if (typeof localStorage === "undefined") return undefined
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as TicketDraftPayload | string
    const payload = typeof parsed === "string" ? { body: parsed, textBody: parsed } : parsed
    const body = payload.textBody ?? payload.body ?? ""
    if (!body.trim()) return undefined
    return { body, payload, updatedAt: new Date().toISOString() }
  } catch {
    return undefined
  }
}

function writeRecord(key: string, payload: TicketDraftPayload): DraftRecord | undefined {
  const body = payload.textBody ?? payload.body ?? ""
  if (typeof localStorage !== "undefined") {
    try {
      if (body.trim().length === 0) localStorage.removeItem(key)
      else localStorage.setItem(key, JSON.stringify(payload))
    } catch {
      // quota exceeded — non-fatal
    }
  }
  if (body.trim().length === 0) return undefined
  return { body, payload, updatedAt: new Date().toISOString() }
}

const [ticketDraftStore, setTicketDraftStore] = createStore<DraftState>({ drafts: {} })

export { ticketDraftStore }

export function getDraft(userId: string, ticketId: string, kind: "reply" | "note"): string {
  const key = draftKey(userId, ticketId, kind)
  const existing = ticketDraftStore.drafts[key] ?? readRecord(key)
  return existing?.body ?? ""
}

export function saveDraft(
  userId: string,
  ticketId: string,
  kind: "reply" | "note",
  body: string,
  extra: Omit<TicketDraftPayload, "body" | "textBody"> = {},
): void {
  saveDraftPayload(userId, ticketId, kind, { ...extra, body, textBody: body })
}

export function saveDraftPayload(
  userId: string,
  ticketId: string,
  kind: "reply" | "note",
  payload: TicketDraftPayload,
): void {
  const key = draftKey(userId, ticketId, kind)
  setTicketDraftStore(
    produce((s) => {
      const record = writeRecord(key, payload)
      if (record) s.drafts[key] = record
      else delete s.drafts[key]
    }),
  )
}

export function clearDraft(userId: string, ticketId: string, kind: "reply" | "note"): void {
  saveDraftPayload(userId, ticketId, kind, {})
}

export function resetTicketDraftStore(): void {
  setTicketDraftStore("drafts", {})
  if (typeof localStorage === "undefined") return
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i)
    if (key?.startsWith("tickets.draft.")) localStorage.removeItem(key)
  }
}

onSessionTeardown(resetTicketDraftStore)
