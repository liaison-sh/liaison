// SPDX-License-Identifier: FSL-1.1-ALv2
import { createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { subscribeResync } from "~/framework/resync"
import { ApiError } from "~/lib/api-error"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { isSealedRow, openSealedRow } from "~/modules/mailbox/sealed-row"
import type { Contact } from "./contact-list-store"

interface DetailApi {
  get: <T>(path: string) => Promise<T>
  getEnvelope: <T>(path: string) => Promise<{ data: T; meta?: { nextCursor?: string | null } }>
  post?: <T>(path: string, body?: unknown) => Promise<T>
  patch: <T>(path: string, body?: unknown) => Promise<T>
  delete: <T>(path: string) => Promise<T>
}

export interface ContactTicketBacklink {
  id: string
  handle: string
  subject: string
  status: string
  lastActivityAt: string | null
}

interface BacklinkState {
  byId: Record<string, any>
  ids: string[]
  cursor: string | null
  hasMore: boolean
  loading: boolean
}

interface ContactDetailState {
  contacts: Record<string, Contact>
  backlinks: Record<string, BacklinkState>
  ticketBacklinks: Record<string, ContactTicketBacklink[]>
  /** The contact's discussion thread, once opened (POST /contacts/:id/discussion). */
  discussions: Record<string, string>
}

const [contactDetailStore, setContactDetailStore] = createStore<ContactDetailState>({
  contacts: {},
  backlinks: {},
  ticketBacklinks: {},
  discussions: {},
})
const [, setLoading] = createSignal(false)

function unwrapData<T>(result: T | { data: T }): T {
  return result && typeof result === "object" && "data" in result
    ? (result as { data: T }).data
    : (result as T)
}

// Last API client seen — captured so the resync subscription can refetch
// loaded contacts without a component context.
let _contactDetailApi: DetailApi | null = null

/**
 * Load one contact into the store. Null when there is none to show (404: another org's id, a
 * deleted contact, one not shared with the reader): the page renders its not-found state from the
 * empty store entry, and nothing is thrown at a caller that fires and forgets.
 */
export async function loadContact(api: DetailApi, id: string): Promise<Contact | null> {
  _contactDetailApi = api
  setLoading(true)
  try {
    const contact = unwrapData<Contact | null>(await api.get(`/contacts/${id}`))
    if (!contact) {
      setContactDetailStore("contacts", id, undefined as unknown as Contact)
      return null
    }
    setContactDetailStore("contacts", id, contact)
    return contact
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
      setContactDetailStore("contacts", id, undefined as unknown as Contact)
      return null
    }
    throw err
  } finally {
    setLoading(false)
  }
}

// --- Resync subscription ---
// On a resync bump, refetch every loaded contact in place (setContactDetailStore
// swaps the per-id record atomically — no wipe). Idempotent.
let _contactDetailResyncSubscribed = false

export function subscribeContactDetailResync(): void {
  if (_contactDetailResyncSubscribed) return
  _contactDetailResyncSubscribed = true
  subscribeResync(() => {
    // An unlock bumps the resync: the related mail it could not open before
    // opens in place, with no refetch.
    for (const contactId of Object.keys(contactDetailStore.backlinks)) {
      void openSealedBacklinks(contactId, contactDetailStore.backlinks[contactId]?.ids ?? [])
    }
    const api = _contactDetailApi
    if (!api) return
    for (const id of Object.keys(contactDetailStore.contacts)) {
      // A failed refresh keeps what the page shows; the next resync tries again.
      loadContact(api, id).catch(() => {})
    }
  })
}

/**
 * Open the sealed related-mail rows of one contact through the mailbox, the
 * same way the Mail inbox opens its list (modules/mailbox/sealed-row). The
 * plaintext lands in `subject` / `snippet`; a locked mailbox marks the row
 * `locked` so the page can say how to unlock instead of "(No subject)".
 */
async function openSealedBacklinks(contactId: string, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    const row = contactDetailStore.backlinks[contactId]?.byId[id]
    if (!row?.sealed || row.encState === "opened") continue
    const opened = await openSealedRow(row)
    setContactDetailStore(
      produce((state) => {
        const current = state.backlinks[contactId]?.byId[id]
        if (!current) return
        if (!opened) {
          current.encState = "locked"
          return
        }
        current.subject = opened.subject ?? ""
        current.snippet = opened.snippet ?? ""
        current.encState = "opened"
      }),
    )
  }
}

export async function loadBacklinks(
  api: DetailApi,
  id: string,
  opts: { cursor?: string | null; append?: boolean } = {},
): Promise<void> {
  const params = new URLSearchParams({ contactId: id, limit: "20" })
  if (opts.cursor) params.set("cursor", opts.cursor)
  const res = await api.getEnvelope<any[]>(`/mail/conversations?${params.toString()}`)
  const rows = (res.data ?? []).map((row) => {
    const sealed = isSealedRow(row)
    return { ...row, sealed, encState: sealed ? "sealed" : undefined }
  })
  setContactDetailStore(
    produce((state) => {
      const existing = opts.append ? state.backlinks[id] : undefined
      const next: BacklinkState = existing ?? {
        byId: {},
        ids: [],
        cursor: null,
        hasMore: false,
        loading: false,
      }
      for (const row of rows) {
        next.byId[row.id] = row
        if (!next.ids.includes(row.id)) next.ids.push(row.id)
      }
      next.cursor = res.meta?.nextCursor ?? null
      next.hasMore = !!next.cursor
      state.backlinks[id] = next
    }),
  )
  await openSealedBacklinks(
    id,
    rows.map((row) => row.id),
  )
}

export async function loadTicketBacklinks(api: DetailApi, id: string): Promise<void> {
  if (!api.post) return
  try {
    const res = (await api.post<{ items: ContactTicketBacklink[] } | ContactTicketBacklink[]>(
      "/apps/run-tool",
      { toolName: "tickets:listForContact", params: { contactId: id, limit: 25 } },
    )) as { items: ContactTicketBacklink[] } | ContactTicketBacklink[]
    const items = Array.isArray(res) ? res : (res?.items ?? [])
    setContactDetailStore("ticketBacklinks", id, items)
  } catch {
    // Tickets app may not be installed; non-fatal.
  }
}

/**
 * Open the contact's discussion: its thread, created the first time, with the
 * reader enrolled (the server proves they see the contact). Throws when it
 * could not be opened; the page says so and the rest of it stands.
 */
export async function openContactDiscussion(api: DetailApi, id: string): Promise<string> {
  const known = contactDetailStore.discussions[id]
  if (known) return known
  if (!api.post) throw new Error("this api client cannot post")
  const opened = unwrapData<{ threadId: string }>(await api.post(`/contacts/${id}/discussion`))
  setContactDetailStore("discussions", id, opened.threadId)
  return opened.threadId
}

export async function updateContact(
  api: DetailApi,
  id: string,
  patch: Partial<Contact>,
): Promise<Contact> {
  const updated = unwrapData<Contact>(await api.patch(`/contacts/${id}`, patch))
  setContactDetailStore("contacts", id, updated)
  return updated
}

export async function deleteContact(api: DetailApi, id: string): Promise<void> {
  await api.delete(`/contacts/${id}`)
  setContactDetailStore(
    produce((state) => {
      delete state.contacts[id]
      delete state.backlinks[id]
    }),
  )
}

type ContactEventData = Partial<Contact> & { id: string }

export function handleContactEvent(action: string, data: ContactEventData): void {
  if (action === "update" || action === "merge") {
    setContactDetailStore(
      produce((state) => {
        state.contacts[data.id] = state.contacts[data.id]
          ? { ...state.contacts[data.id], ...data }
          : (data as Contact)
      }),
    )
  } else if (action === "delete") {
    setContactDetailStore(
      produce((state) => {
        delete state.contacts[data.id]
        delete state.backlinks[data.id]
      }),
    )
  } else if (action === "share") {
    // Its sharing changed, and with it who is in its discussion: the page opens it again.
    setContactDetailStore(
      produce((state) => {
        delete state.discussions[data.id]
      }),
    )
  }
}

export function resetContactDetailStore(): void {
  setContactDetailStore({ contacts: {}, backlinks: {}, ticketBacklinks: {}, discussions: {} })
  setLoading(false)
}

onSessionTeardown(resetContactDetailStore)

export { contactDetailStore }
