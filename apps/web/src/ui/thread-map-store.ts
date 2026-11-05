// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The phone thread drawer's shared switch. The button that opens it lives in
// the phone top bar's registered header (MailConversationPhoneHeader,
// TicketPhoneHeader), a SEPARATE component from the conversation body that
// owns the drawer, the scroller and the messages: the same split the "⋯"
// sheets have, with the same answer, a tiny signal both sides read. Keyed by
// conversation (`mail:<id>`, `tickets:<id>`), so a drawer opened in one tab
// never opens in another.
//
// It also carries how many messages each open conversation shows: the header
// offers the button only from 3 messages, and it has no message list of its
// own to count.
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"

/** Fewer messages than this: no drawer, no button, no pill. */
export const THREAD_MAP_MIN_MESSAGES = 3

const [openKey, setOpenKey] = createSignal<string | null>(null)
const [sizes, setSizes] = createStore<Record<string, number | undefined>>({})

export function openThreadMap(key: string): void {
  setOpenKey(key)
}

export function closeThreadMap(): void {
  setOpenKey(null)
}

export function isThreadMapOpen(key: string): boolean {
  return openKey() === key
}

/** The conversation body reports how many messages it shows. */
export function setThreadMapSize(key: string, messages: number): void {
  setSizes(key, messages)
}

/** The conversation body is gone: forget its count. */
export function clearThreadMapSize(key: string): void {
  setSizes(key, undefined)
}

/** True when the conversation is long enough to offer the drawer. */
export function threadMapAvailable(key: string): boolean {
  return (sizes[key] ?? 0) >= THREAD_MAP_MIN_MESSAGES
}
