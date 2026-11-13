// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The secret cards in view, by id. A card reads its row once and re-reads it
// when the server says it changed (the `secret_request` event, which carries
// only the id and the status) or after the card itself saved. Nothing here
// ever holds a secret: the row names what is asked for and, once saved, the
// non-secret hint.

import {
  type ConnectFailureReason,
  connectFailureReason,
  type GoogleSetupValues,
  type ShopifyDashboardValues,
} from "@liaison/shared"
import { createStore, produce } from "solid-js/store"
import type { ApiClient } from "~/lib/api-client"
import { onSessionTeardown } from "~/lib/session-lifecycle"

export type SecretRequestKind =
  | "byok"
  | "connection_credentials"
  | "oauth_client"
  | "google_integration_client"
  | "oauth_connect"
  | "api_key"

export type SecretRequestStatus = "pending" | "saved" | "cancelled" | "expired"

export interface SecretFormField {
  name: string
  label?: string
  secret: boolean
  required: boolean
}

export interface SecretDestination {
  name: string
  value: string
}

/** The provider a connect card signs in with: its button says "Connect with <provider>". */
export type ConnectProvider = "google" | "shopify" | "microsoft" | "meta" | null

/**
 * Setup steps a client card shows above its form (the server's
 * `secret-requests/guides.ts`): the computed values of a Google or Shopify
 * setup, which the card renders with the shared guides, or an app's own steps.
 */
export type SecretRequestGuide =
  | { provider: "google"; values: GoogleSetupValues }
  | { provider: "shopify"; values: ShopifyDashboardValues }
  | { provider: "app"; summary?: string; steps: string[]; docsUrl?: string }

export interface SecretRequestRow {
  id: string
  kind: SecretRequestKind
  target: Record<string, unknown>
  title: string
  status: SecretRequestStatus
  hint: string | null
  requestedBy: string
  agentId: string | null
  threadId: string
  createdAt: string
  expiresAt: string
  completedAt: string | null
  canSubmit: boolean
  canCancel: boolean
  fields: SecretFormField[]
  destination: SecretDestination[]
  /** Credential values sent as they are (the account the request names), never asked for. */
  fixed: Record<string, string>
  /** Who asked: the agent's name, and the person it asked for. */
  agentName: string | null
  requesterName: string | null
  /** A connect card (`oauth_connect`): the provider its button signs in with. */
  connect?: { provider: ConnectProvider } | null
  /** A client card's setup steps, or null. */
  guide?: SecretRequestGuide | null
}

const [state, setState] = createStore<{
  byId: Record<string, SecretRequestRow>
  /** A connect card's consent that failed at the callback: its reason code, until the next try. */
  failures: Record<string, ConnectFailureReason>
}>({ byId: {}, failures: {} })
const inFlight = new Map<string, Promise<SecretRequestRow | undefined>>()

/** Forget every request when the session ends. */
export function resetSecretRequestStore(): void {
  inFlight.clear()
  setState({ byId: {}, failures: {} })
}

onSessionTeardown(resetSecretRequestStore)

export function getById(id: string): SecretRequestRow | undefined {
  return state.byId[id]
}

export function upsert(row: SecretRequestRow): void {
  setState(
    produce((s) => {
      s.byId[row.id] = row
    }),
  )
}

/** Read the row from the server (always), sharing a read already on its way. */
export function reload(api: ApiClient, id: string): Promise<SecretRequestRow | undefined> {
  const existing = inFlight.get(id)
  if (existing) return existing
  const promise = api
    .get<SecretRequestRow>(`/secret-requests/${id}`, { suppressGlobalError: true })
    .then((row) => {
      if (row?.id) upsert(row)
      return row
    })
    .finally(() => inFlight.delete(id))
  inFlight.set(id, promise)
  return promise
}

/** The row once: a card shown again does not re-read what it already holds. */
export function ensureLoaded(api: ApiClient, id: string): Promise<SecretRequestRow | undefined> {
  const row = state.byId[id]
  return row ? Promise.resolve(row) : reload(api, id)
}

/** Why a connect card's last consent failed, or undefined. */
export function failureOf(id: string): ConnectFailureReason | undefined {
  return state.failures[id]
}

/** Forget a card's failure: the person tries again. */
export function clearFailure(id: string): void {
  if (!state.failures[id]) return
  setState(
    produce((s) => {
      delete s.failures[id]
    }),
  )
}

/**
 * The server said a card changed: re-read it if one is on screen. A failed
 * consent's frame carries its reason code (secret-requests/service.ts,
 * announceConnectFailure), which the card shows.
 */
export function handleEvent(api: ApiClient, data: unknown): void {
  const id =
    data && typeof data === "object" && "id" in data && typeof data.id === "string" ? data.id : null
  if (!id || !state.byId[id]) return
  const failure =
    data && typeof data === "object" && "failure" in data && typeof data.failure === "string"
      ? connectFailureReason(data.failure)
      : null
  if (failure) {
    setState(
      produce((s) => {
        s.failures[id] = failure
      }),
    )
  }
  void reload(api, id).catch(() => undefined)
}

export const secretRequestStore = {
  getById,
  upsert,
  reload,
  ensureLoaded,
  handleEvent,
  failureOf,
  clearFailure,
}
