// SPDX-License-Identifier: FSL-1.1-ALv2
import type { ImapSyncSummary } from "@liaison/shared"
import { createStore, produce, reconcile } from "solid-js/store"
import { onSessionTeardown } from "~/lib/session-lifecycle"

interface MailApi {
  get: <T = unknown>(path: string) => Promise<T>
  post: <T = unknown>(path: string, body?: unknown) => Promise<T>
}

export interface MailAccount {
  id: string
  connectedAccountId: string | null
  provider: string
  emailAddress: string
  displayName: string | null
  ownerType: "user" | "org"
  ownerId: string | null
  syncStatus: string
  lastSyncAt: string | null
  lastSyncError: string | null
  /** A failing sync waits until then before it tries again (null: no wait). */
  nextRetryAt?: string | null
  unreadCount: number
  allowedImageSenderDomains: string[]
  // Health of the backing kernel connected account (same classifier as the
  // connection-health attention feed). Distinct from syncStatus: an OAuth
  // grant can be revoked or scope-drifted while no sync has errored yet.
  connectionHealth?: MailConnectionHealth | null
  // The mailbox encryption state machine (spec section 4.3). Personal
  // mailboxes only fetch mail while this is `ready`; every other value means
  // sync is suspended, which is what MailEncryptionEnrollmentBanner explains.
  // `null` means the server did not report a state, which is treated as
  // "unknown" rather than "suspended": a surface that guessed would banner
  // every mailbox on a deploy where the projection is missing.
  encryptionState?: MailEncryptionState | null
  // Set while the mailbox moves between encryption modes, which can stop
  // part way and be finished later: `to_private` or `to_managed`.
  encryptionConversion?: "to_private" | "to_managed" | null
  // Messages imported so far. Only meaningful while `syncStatus` is
  // `pre-sync` or `syncing`, when the first import of the mailbox is running.
  messagesSynced: number
  // What an IMAP mailbox keeps in step with its server (read, star, archive,
  // trash written back; Sent imported), from the capabilities its sync read.
  // Null for Gmail, or before the first sync.
  serverSync?: ImapSyncSummary | null
}

/** Spec section 4.3. Mirrors `apps/api/src/modules/mailbox-keys/encryption-state.ts`. */
/**
 * `ready` = private (zero-access, opened in this browser); `managed` = sealed by
 * the server under the mailbox's own key and served already readable. Both
 * sync; the others are suspended.
 */
export type MailEncryptionState =
  | "none"
  | "pending_enrollment"
  | "ready"
  | "blocked"
  | "paused"
  | "managed"

/** True when the mailbox fetches mail: private (`ready`) or server-managed. */
export function isSyncingEncryptionState(state: MailEncryptionState | null | undefined): boolean {
  return state === "ready" || state === "managed"
}

export interface MailConnectionHealth {
  status: "ok" | "needs_reconnect"
  reason?: string
  missingScopes?: string[]
  statusMessage?: string
}

interface MailAccountStoreState {
  byId: Record<string, MailAccount>
  /** True once the first account list arrived, so "no accounts" is known, not assumed. */
  loaded: boolean
}

const [mailAccountStore, setMailAccountStore] = createStore<MailAccountStoreState>({
  byId: {},
  loaded: false,
})

export { mailAccountStore }

export function getAccount(accountId: string): MailAccount | undefined {
  return mailAccountStore.byId[accountId]
}

export function allAccounts(): MailAccount[] {
  return Object.values(mailAccountStore.byId)
}

export function accountsLoaded(): boolean {
  return mailAccountStore.loaded
}

export const personalAccounts = () => allAccounts().filter((a) => a.ownerType === "user")

export const sharedAccounts = () => allAccounts().filter((a) => a.ownerType === "org")

function normalizeAccount(account: Partial<MailAccount> & Pick<MailAccount, "id">): MailAccount {
  return {
    id: account.id,
    connectedAccountId: account.connectedAccountId ?? null,
    provider: account.provider ?? "",
    emailAddress: account.emailAddress ?? "",
    displayName: account.displayName ?? null,
    ownerType: account.ownerType ?? "user",
    ownerId: account.ownerId ?? null,
    syncStatus: account.syncStatus ?? "idle",
    lastSyncAt: account.lastSyncAt ?? null,
    lastSyncError: account.lastSyncError ?? null,
    nextRetryAt: account.nextRetryAt ?? null,
    unreadCount: account.unreadCount ?? 0,
    allowedImageSenderDomains: account.allowedImageSenderDomains ?? [],
    connectionHealth: account.connectionHealth ?? null,
    encryptionState: account.encryptionState ?? null,
    encryptionConversion: account.encryptionConversion ?? null,
    messagesSynced: account.messagesSynced ?? 0,
  }
}

export async function loadAccounts(api: MailApi): Promise<void> {
  const list = await api.get<MailAccount[]>("/mail/accounts")
  const byId: Record<string, MailAccount> = {}
  for (const account of list) byId[account.id] = normalizeAccount(account)
  // Reconciled, not replaced: a refetch (any `mail:account` change event, e.g.
  // a sync tick) must keep each account's object identity, or the account list
  // re-creates every row and drops the state of what is open inside one, such
  // as a running mailbox verification sweep and its result.
  setMailAccountStore("byId", reconcile(byId))
  setMailAccountStore("loaded", true)
}

function normalizeSenderDomain(senderDomain: string): string {
  return senderDomain.trim().toLowerCase()
}

export function isSenderImageAllowed(
  accountId: string | null | undefined,
  senderDomain: string,
): boolean {
  if (!accountId) return false
  const normalized = normalizeSenderDomain(senderDomain)
  if (!normalized) return false

  return mailAccountStore.byId[accountId]?.allowedImageSenderDomains.includes(normalized) ?? false
}

export async function allowSenderImageDomain(
  api: MailApi,
  accountId: string,
  senderDomain: string,
): Promise<void> {
  const normalized = normalizeSenderDomain(senderDomain)
  if (!normalized) return

  const result = await api.post<{ allowedImageSenderDomains: string[] }>(
    `/mail/accounts/${accountId}/image-preferences`,
    { senderDomain: normalized },
  )

  setMailAccountStore(
    produce((state) => {
      const account = state.byId[accountId]
      if (!account) return
      account.allowedImageSenderDomains = result.allowedImageSenderDomains
    }),
  )
}

export function handleAccountEvent(action: string, data: any): void {
  if (action === "create") {
    setMailAccountStore("byId", data.id, normalizeAccount(data))
  } else if (action === "update") {
    setMailAccountStore(
      produce((s) => {
        const existing = s.byId[data.id]
        if (!existing) return
        s.byId[data.id] = normalizeAccount({ ...existing, ...data })
      }),
    )
  } else if (action === "delete") {
    setMailAccountStore(
      produce((s) => {
        delete s.byId[data.id]
      }),
    )
  }
}

export function resetMailAccountStore(): void {
  setMailAccountStore({ byId: {}, loaded: false })
}

onSessionTeardown(resetMailAccountStore)
