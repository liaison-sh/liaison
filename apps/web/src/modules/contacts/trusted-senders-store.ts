// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org's trusted senders (/api/trusted-senders): addresses and domains staff marked as trusted.
// Shared by a ticket message's "unverified sender" badge and the contact page. Loaded once per
// session and refreshed after each change.

import { emailDomainOf, isPublicEmailProvider, type TrustedSender } from "@liaison/shared"
import { createSignal } from "solid-js"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { hasScope } from "~/modules/auth/auth-store"

interface TrustedApi {
  get: <T>(path: string) => Promise<T | { data: T }>
  post: <T>(path: string, body?: unknown) => Promise<T | { data: T }>
  delete: <T>(path: string) => Promise<T | { data: T }>
}

function unwrap<T>(result: T | { data: T }): T {
  return result && typeof result === "object" && "data" in (result as object)
    ? (result as { data: T }).data
    : (result as T)
}

const [entries, setEntries] = createSignal<TrustedSender[]>([])
let loading: Promise<void> | null = null

onSessionTeardown(() => {
  setEntries([])
  loading = null
})

export function trustedSenders(): TrustedSender[] {
  return entries()
}

/** Load once per session; later calls reuse the first load. */
export function ensureTrustedSenders(api: TrustedApi): Promise<void> {
  if (!loading) {
    loading = (async () => {
      try {
        const list = unwrap(await api.get<TrustedSender[]>("/trusted-senders"))
        setEntries(Array.isArray(list) ? list : [])
      } catch {
        loading = null
      }
    })()
  }
  return loading
}

/** The entry that makes this address trusted (its exact address first, then its domain). */
export function trustEntryFor(email: string | null | undefined): TrustedSender | null {
  const e = email?.trim().toLowerCase()
  if (!e) return null
  const list = entries()
  const exact = list.find((t) => t.kind === "address" && t.value === e)
  if (exact) return exact
  const domain = emailDomainOf(e)
  if (!domain || isPublicEmailProvider(domain)) return null
  return list.find((t) => t.kind === "domain" && t.value === domain) ?? null
}

/** Staff who may change the list: a contacts admin or a tickets settings admin. */
export function canManageTrustedSenders(): boolean {
  return hasScope("kernel:contacts:admin") || hasScope("tickets:settings:admin")
}

export async function trustSender(
  api: TrustedApi,
  kind: "address" | "domain",
  value: string,
): Promise<void> {
  const created = unwrap(await api.post<TrustedSender>("/trusted-senders", { kind, value }))
  setEntries((list) => [...list.filter((t) => t.id !== created.id), created])
}

export async function untrustSender(api: TrustedApi, id: string): Promise<void> {
  await api.delete(`/trusted-senders/${id}`)
  setEntries((list) => list.filter((t) => t.id !== id))
}
