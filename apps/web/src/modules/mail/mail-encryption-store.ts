// SPDX-License-Identifier: FSL-1.1-ALv2
//
// How this person's mailboxes are encrypted at rest (`/api/mailbox/encryption`).
//
// `managed` ("transparent"): encrypted with a key the server holds for that one
// mailbox; you and your agent read it with no mailbox password, your
// organization's admins cannot. `private`: zero-access, sealed to a key only
// your browser holds (mailbox password + passkey). The org decides whether
// private mailboxes are allowed; each person picks inside that.

import { createSignal } from "solid-js"
import { createAttachmentOpener } from "~/modules/mailbox/attachment-opener"
import type {
  SealedApprovalDraft,
  SealedConversationPayload,
  SealedMessagePayload,
} from "~/modules/mailbox/crypto-protocol"
import { base64ToBytes } from "~/modules/mailbox/mailbox-bytes"
import { mailboxCryptoClient } from "~/modules/mailbox/mailbox-store"

export type MailboxEncryptionMode = "managed" | "private"

export interface MailboxEncryptionSettings {
  deploymentDefault: MailboxEncryptionMode
  /** False when the deployment keeps every mailbox private. */
  allowManaged: boolean
  allowPrivate: boolean
  preference: MailboxEncryptionMode | null
  effective: MailboxEncryptionMode
  canMakeTransparent: boolean
  canSetPolicy: boolean
}

interface EncryptionApi {
  get: <T = unknown>(path: string) => Promise<T>
  post: <T = unknown>(path: string, body?: unknown) => Promise<T>
  put: <T = unknown>(path: string, body?: unknown) => Promise<T>
}

const [settings, setSettings] = createSignal<MailboxEncryptionSettings | null>(null)

/** Null until loaded, or when the server could not answer. */
export const mailboxEncryptionSettings = settings

export async function loadMailboxEncryptionSettings(api: Pick<EncryptionApi, "get">) {
  try {
    setSettings(await api.get<MailboxEncryptionSettings>("/mailbox/encryption"))
  } catch {
    setSettings(null)
  }
}

export async function setMailboxEncryptionPreference(
  api: Pick<EncryptionApi, "put">,
  mode: MailboxEncryptionMode,
) {
  const next = await api.put<MailboxEncryptionSettings>("/mailbox/encryption/preference", { mode })
  setSettings((current) => (current ? { ...current, ...next } : next))
}

export async function setAllowPrivateMailboxes(
  api: Pick<EncryptionApi, "put">,
  allowPrivate: boolean,
) {
  const next = await api.put<MailboxEncryptionSettings>("/mailbox/encryption/policy", {
    allowPrivate,
  })
  setSettings((current) => (current ? { ...current, ...next } : next))
}

/** A new personal mailbox of this person needs no mailbox password. */
export function newMailboxesAreTransparent(): boolean {
  return settings()?.effective === "managed"
}

export interface ConversionCounts {
  messages: number
  drafts: number
  conversations: number
  files: number
}

export interface MakePrivateResult extends ConversionCounts {
  done: boolean
}

export function conversionTotal(counts: ConversionCounts): number {
  return counts.messages + counts.drafts + counts.conversations + counts.files
}

/**
 * Make a transparent mailbox private, or finish an interrupted move. The
 * server does it alone (it holds the mailbox's key) and answers when done.
 */
export async function makeMailboxPrivate(
  api: Pick<EncryptionApi, "post">,
  accountId: string,
): Promise<MakePrivateResult> {
  return api.post<MakePrivateResult>(`/mailbox/encryption/accounts/${accountId}/make-private`)
}

interface PendingPage {
  items: Array<Record<string, unknown> & { id: string }>
  next: string | null
}

interface TransparentApi {
  get: <T = unknown>(path: string) => Promise<T>
  post: <T = unknown>(path: string, body?: unknown) => Promise<T>
  rawGet: (path: string) => Promise<Response>
}

export interface MakeTransparentResult {
  done: boolean
  converted: number
  /** Items this browser could not open; they keep the mailbox from finishing. */
  failed: number
  remaining: number
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

/**
 * Starting the move hands the server a private mailbox's content, so it needs
 * the account holder to confirm again: the current password, or this code,
 * emailed for this purpose only.
 */
export function requestMakeTransparentCode(api: Pick<TransparentApi, "post">): Promise<unknown> {
  return api.post("/auth/totp/step-up", { purpose: "mailbox_transparent" })
}

/** The step-up proof that starts the move. A move already under way needs none. */
export interface MakeTransparentStepUp {
  stepUpCode?: string
  currentPassword?: string
}

/**
 * Make a private mailbox transparent, or carry on an interrupted move. The
 * server cannot open a private mailbox, so THIS browser (unlocked) opens every
 * row still sealed to the owner (messages with their extra headers, drafts,
 * conversations, attachments) and hands the server its plaintext, a batch at a
 * time, to seal under the mailbox's own key. With each row go the field
 * subkeys it was opened with, so the server can check the plaintext against
 * what the row holds. The mailbox stays private until nothing is left; then
 * the server flips it. Safe to stop and run again.
 */
export async function makeMailboxTransparent(
  api: TransparentApi,
  accountId: string,
  onProgress?: (converted: number) => void,
  stepUp?: MakeTransparentStepUp,
): Promise<MakeTransparentResult> {
  const base = `/mailbox/encryption/accounts/${accountId}/make-transparent`
  await api.post(base, stepUp ?? {})
  let converted = 0
  const failed = new Set<string>()
  const report = (n: number) => {
    converted += n
    onProgress?.(converted)
  }

  // Up to three passes: mail that arrives while this runs is sealed to the
  // owner too, and the next pass picks it up.
  for (let pass = 0; pass < 3; pass++) {
    let movedThisPass = 0
    for (const entity of ["messages", "drafts", "conversations"] as const) {
      let after: string | null = null
      for (;;) {
        const page: PendingPage = await api.get<PendingPage>(
          `${base}/pending?entity=${entity}&limit=25${after ? `&after=${after}` : ""}`,
        )
        const batch: Array<Record<string, unknown>> = []
        for (const item of page.items) {
          const contentKeyWrapped = str(item.contentKeyWrapped)
          if (!contentKeyWrapped) {
            failed.add(item.id)
            continue
          }
          const opened = await openPendingRow(entity, item)
          if (!opened) {
            failed.add(item.id)
            continue
          }
          batch.push({ id: item.id, contentKeyWrapped, ...opened })
        }
        if (batch.length > 0) {
          const result = await api.post<{ resealed: number }>(`${base}/batch`, {
            [entity]: batch,
          })
          report(result.resealed)
          movedThisPass += result.resealed
        }
        if (!page.next) break
        after = page.next
      }
    }
    // Attachments, one at a time: each is opened whole, then sealed again.
    let after: string | null = null
    for (;;) {
      const page: PendingPage = await api.get<PendingPage>(
        `${base}/pending?entity=files&limit=25${after ? `&after=${after}` : ""}`,
      )
      for (const item of page.items) {
        if (await convertFile(api, base, item.id)) {
          report(1)
          movedThisPass += 1
        } else {
          failed.add(item.id)
        }
      }
      if (!page.next) break
      after = page.next
    }
    const finish = await api.post<{ done: boolean; remaining: number }>(`${base}/finish`)
    if (finish.done) return { done: true, converted, failed: 0, remaining: 0 }
    if (movedThisPass === 0) {
      return { done: false, converted, failed: failed.size, remaining: finish.remaining }
    }
  }
  const progress = await api.get<{ remaining: number }>(base)
  return { done: false, converted, failed: failed.size, remaining: progress.remaining }
}

async function openPendingRow(
  entity: "messages" | "drafts" | "conversations",
  item: Record<string, unknown> & { id: string },
): Promise<Record<string, unknown> | null> {
  const client = mailboxCryptoClient()
  if (!client) return null
  try {
    return await openPendingRowWith(client, entity, item)
  } catch {
    return null
  }
}

async function openPendingRowWith(
  client: NonNullable<ReturnType<typeof mailboxCryptoClient>>,
  entity: "messages" | "drafts" | "conversations",
  item: Record<string, unknown> & { id: string },
): Promise<Record<string, unknown> | null> {
  const withFieldKeys = { withFieldKeys: true }
  const encVersion = Number(item.encVersion)
  const encKeyId = Number(item.encKeyId)
  const contentKeyWrapped = str(item.contentKeyWrapped) ?? ""
  const contentKeyEpk = str(item.contentKeyEpk) ?? ""
  if (entity === "messages") {
    const sealed: SealedMessagePayload = {
      id: item.id,
      encVersion,
      encKeyId,
      contentKeyWrapped,
      contentKeyEpk,
      subjectCiphertext: str(item.subjectCiphertext),
      textBodyCiphertext: str(item.textBodyCiphertext),
      htmlBodyCiphertext: str(item.htmlBodyCiphertext),
      snippetCiphertext: str(item.snippetCiphertext),
      rawHeadersCiphertext: str(item.rawHeadersCiphertext),
    }
    const opened = await client.openMessage(sealed, withFieldKeys)
    return {
      subject: opened.subject,
      textBody: opened.textBody,
      htmlBody: opened.htmlBody,
      snippet: opened.snippet,
      rawHeaders: opened.rawHeaders ?? null,
      fieldKeys: opened.fieldKeys ?? {},
    }
  }
  if (entity === "conversations") {
    const sealed: SealedConversationPayload = {
      id: item.id,
      sourceMessageId: str(item.sourceMessageId),
      encVersion,
      encKeyId,
      contentKeyWrapped,
      contentKeyEpk,
      subjectCiphertext: str(item.subjectCiphertext),
      snippetCiphertext: str(item.snippetCiphertext),
    }
    const opened = await client.openConversation(sealed, withFieldKeys)
    return {
      subject: opened.subject,
      snippet: opened.snippet,
      fieldKeys: opened.fieldKeys ?? {},
    }
  }
  // A draft row is sealed under the draft contexts bound to its own id, the
  // same binding a gated send's draft uses: the approval-draft opener opens it.
  const sealed: SealedApprovalDraft = {
    approvalRequestId: item.id,
    encVersion,
    encKeyId,
    contentKeyWrapped,
    contentKeyEpk,
    subjectCiphertext: str(item.subjectCiphertext),
    bodyCiphertext: str(item.bodyCiphertext),
    htmlBodyCiphertext: str(item.htmlBodyCiphertext),
  }
  const opened = await client.openApprovalDraft(sealed, withFieldKeys)
  return {
    subject: opened.subject,
    textBody: opened.textBody,
    htmlBody: opened.htmlBody,
    fieldKeys: opened.fieldKeys ?? {},
  }
}

async function convertFile(api: TransparentApi, base: string, fileId: string): Promise<boolean> {
  const client = mailboxCryptoClient()
  if (!client) return false
  try {
    const metadata = await api.get<{ encryption: { contentKeyWrappedBase64?: string } | null }>(
      `/files/${fileId}/metadata`,
    )
    const contentKeyWrapped = metadata?.encryption?.contentKeyWrappedBase64
    if (!contentKeyWrapped) return false
    const opener = createAttachmentOpener({
      client,
      openOptions: { withFieldKeys: true },
      fetchMetadata: async () => metadata,
      fetchCiphertext: async (id) => {
        const response = await api.rawGet(`/files/${id}/inline?download=1`)
        return await response.arrayBuffer()
      },
    })
    const [opened] = await opener([fileId])
    if (!opened?.fieldKey) return false
    const bytes = base64ToBytes(opened.bytesBase64)
    // `fk`: the file's key the bytes were opened with, the server's proof that
    // they are the stored attachment's own.
    const result = await api.post<{ resealed: boolean }>(
      `${base}/files/${fileId}?ck=${encodeURIComponent(contentKeyWrapped)}&fk=${encodeURIComponent(opened.fieldKey)}`,
      new Blob([bytes as unknown as BlobPart], { type: "application/octet-stream" }),
    )
    return result.resealed === true
  } catch {
    return false
  }
}
