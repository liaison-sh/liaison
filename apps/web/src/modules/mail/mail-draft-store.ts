// SPDX-License-Identifier: FSL-1.1-ALv2
import { markdownToEmail } from "@liaison/shared"
import { createSignal } from "solid-js"
import { onSessionTeardown } from "~/lib/session-lifecycle"

interface MailApi {
  get?: <T = unknown>(path: string) => Promise<T>
  post?: <T = unknown>(path: string, body?: unknown) => Promise<T>
  patch?: <T = unknown>(path: string, body?: unknown) => Promise<T>
  delete?: <T = unknown>(path: string) => Promise<T>
}

export interface Draft {
  id: string
  accountId: string
  conversationId: string | null
  replyToMessageId: string | null
  to: Array<{ name?: string; email: string }>
  cc: Array<{ name?: string; email: string }>
  bcc: Array<{ name?: string; email: string }>
  subject: string
  htmlBody: string
  textBody: string
  updatedAt: string
  /**
   * The server holds this draft's subject and body as ciphertext only
   * (`encVersion > 0`). An empty `subject` then means "not opened here", never
   * "no subject".
   */
  sealed?: boolean
}

const [drafts, setDrafts] = createSignal<Record<string, Draft>>({})
const [, setLoading] = createSignal(false)
const draftByConversationId = new Map<string, string>()
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
type DraftChanges = Partial<Pick<Draft, "to" | "cc" | "bcc" | "subject" | "htmlBody" | "textBody">>
/** Changes to a draft; `markdown` is a body written in the shared editor. */
type ScheduledChanges = Omit<DraftChanges, "htmlBody" | "textBody"> & { markdown?: string }
const pendingChanges = new Map<string, ScheduledChanges>()

export { drafts }

export function upsertLocalDraft(draft: Draft): void {
  setDrafts((prev) => ({ ...prev, [draft.id]: draft }))
  if (draft.conversationId) draftByConversationId.set(draft.conversationId, draft.id)
}

function normalizeDraft(d: any): Draft {
  return {
    ...d,
    to: Array.isArray(d.to) ? d.to : [],
    cc: Array.isArray(d.cc) ? d.cc : [],
    bcc: Array.isArray(d.bcc) ? d.bcc : [],
    sealed: d.sealed ?? Number(d.encVersion ?? 0) > 0,
  }
}

export async function loadDrafts(api: MailApi): Promise<void> {
  setLoading(true)
  try {
    const list = await api.get!<Draft[]>("/mail/drafts")
    const byId: Record<string, Draft> = {}
    draftByConversationId.clear()
    for (const raw of list) {
      const d = normalizeDraft(raw)
      byId[d.id] = d
      if (d.conversationId) draftByConversationId.set(d.conversationId, d.id)
    }
    setDrafts(byId)
  } finally {
    setLoading(false)
  }
}

export async function createDraft(
  api: MailApi,
  params: {
    accountId: string
    conversationId?: string
    replyToMessageId?: string
    /** A reply draft is born with the recipients and subject its send would
     *  use, so Drafts never lists it as "(No recipients) / (No subject)". */
    to?: Array<{ name?: string; email: string }>
    cc?: Array<{ name?: string; email: string }>
    subject?: string
  },
): Promise<Draft> {
  const draft = normalizeDraft(await api.post!<Draft>("/mail/drafts", params))
  upsertLocalDraft(draft)
  return draft
}

export async function saveDraft(
  api: MailApi,
  draftId: string,
  changes: DraftChanges,
): Promise<void> {
  setDrafts((prev) => {
    const d = prev[draftId]
    if (!d) return prev
    return { ...prev, [draftId]: { ...d, ...changes } }
  })

  const updated = await api.patch!<Draft>(`/mail/drafts/${draftId}`, changes)
  if (updated) upsertLocalDraft(updated)
}

/**
 * Saves a draft once the edits pause. A body is kept as the markdown it was
 * written in, so it reopens as written; its email HTML is made once, when the
 * save goes out, not on every keystroke. Until then the local copy holds no
 * HTML, so it reopens from its markdown (draftMarkdown).
 */
export function scheduleDraftSave(api: MailApi, draftId: string, changes: ScheduledChanges): void {
  setDrafts((prev) => {
    const d = prev[draftId]
    if (!d) return prev
    return { ...prev, [draftId]: { ...d, ...withBody(changes, () => "") } }
  })

  // Accumulate changes across debounced calls so earlier field edits aren't lost
  const existing = pendingChanges.get(draftId) ?? {}
  pendingChanges.set(draftId, { ...existing, ...changes })

  const existingTimer = saveTimers.get(draftId)
  if (existingTimer) clearTimeout(existingTimer)

  const timer = setTimeout(async () => {
    const merged = pendingChanges.get(draftId) ?? changes
    pendingChanges.delete(draftId)
    await saveDraft(
      api,
      draftId,
      withBody(merged, (markdown) => markdownToEmail(markdown).html),
    )
    saveTimers.delete(draftId)
  }, 2500)

  saveTimers.set(draftId, timer)
}

function withBody(
  { markdown, ...changes }: ScheduledChanges,
  toHtml: (markdown: string) => string,
): DraftChanges {
  return markdown === undefined
    ? changes
    : { ...changes, htmlBody: toHtml(markdown), textBody: markdown }
}

export async function sendDraft(
  api: MailApi,
  draftId: string,
  payload: {
    to?: Array<{ email: string }>
    cc?: Array<{ email: string }>
    bcc?: Array<{ email: string }>
    subject?: string
    htmlBody: string
    textBody: string
  },
): Promise<{ conversationId: string; messageId: string }> {
  const result = await api.post!<{ conversationId: string; messageId: string }>(
    `/mail/drafts/${draftId}/send`,
    payload,
  )

  setDrafts((prev) => {
    const next = { ...prev }
    const draft = next[draftId]
    if (draft?.conversationId) draftByConversationId.delete(draft.conversationId)
    delete next[draftId]
    return next
  })

  return result
}

export async function discardDraft(api: MailApi, draftId: string): Promise<void> {
  // A debounced save still pending would PATCH the deleted draft.
  const timer = saveTimers.get(draftId)
  if (timer) clearTimeout(timer)
  saveTimers.delete(draftId)
  pendingChanges.delete(draftId)
  await api.delete!(`/mail/drafts/${draftId}`)
  setDrafts((prev) => {
    const next = { ...prev }
    const draft = next[draftId]
    if (draft?.conversationId) draftByConversationId.delete(draft.conversationId)
    delete next[draftId]
    return next
  })
}

export function getDraftForConversation(conversationId: string): Draft | undefined {
  const draftId = draftByConversationId.get(conversationId)
  return draftId ? drafts()[draftId] : undefined
}

export function resetMailDraftStore(): void {
  for (const timer of saveTimers.values()) clearTimeout(timer)
  saveTimers.clear()
  pendingChanges.clear()
  setDrafts({})
  draftByConversationId.clear()
  setLoading(false)
}

onSessionTeardown(resetMailDraftStore)
