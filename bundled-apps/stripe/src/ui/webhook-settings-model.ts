// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What Settings > Apps > Stripe > Webhook reads and writes, without the component: the kernel's
// app-secret route of the `stripe` connection. The read says whether the signing secret is set
// (never the secret) and the endpoint's address; the write posts the secret once and keeps
// nothing of it. The events to select are the ones the event handler acts on.
import { WEBHOOK_EVENTS } from "../webhook-events"
import { tr } from "./i18n"

export const APP_SECRETS_PATH = "/api/connections/stripe/stripe/app-secrets"
export const SIGNING_SECRET_KEY = "webhookSigningSecret"
/** The manifest's pattern (`connections.stripe.appSecretFields`), checked before sending. */
export const SIGNING_SECRET_SHAPE = /^whsec_[A-Za-z0-9]{16,}$/

export type HostFetchFn = <T = unknown>(path: string, init?: RequestInit) => Promise<T>

export interface WebhookSettings {
  /** The endpoint address to paste in Stripe, or null when the server names none. */
  address: string | null
  secretSet: boolean
  previousUntil: string | null
  events: readonly string[]
}

interface AppSecretsRead {
  secrets?: Array<{ key?: string; set?: boolean; previousUntil?: string | null }>
  webhooks?: Array<{ endpoint?: string; url?: string }>
}

/** The read, unwrapped whether the host hands the `data` envelope or its content. */
function unwrap(raw: unknown): AppSecretsRead {
  const r = raw as { data?: AppSecretsRead } & AppSecretsRead
  return (r && typeof r === "object" && "data" in r ? r.data : r) ?? {}
}

export async function loadWebhookSettings(fetch: HostFetchFn): Promise<WebhookSettings> {
  const read = unwrap(await fetch<unknown>(APP_SECRETS_PATH))
  const secret = (read.secrets ?? []).find((s) => s.key === SIGNING_SECRET_KEY)
  const hook = (read.webhooks ?? []).find((w) => w.endpoint === "events")
  return {
    address: typeof hook?.url === "string" ? hook.url : null,
    secretSet: secret?.set === true,
    previousUntil: typeof secret?.previousUntil === "string" ? secret.previousUntil : null,
    events: WEBHOOK_EVENTS,
  }
}

/** Why a typed value is not sent, in the reader's language, or null. */
export function signingSecretProblem(value: string): string | null {
  const v = value.trim()
  if (v.length === 0) return tr("Paste the signing secret first.")
  if (!SIGNING_SECRET_SHAPE.test(v)) {
    return tr("A webhook signing secret starts with whsec_ followed by letters and digits.")
  }
  return null
}

/** Save the secret. `rolled`: one was set before; it keeps verifying for 24 hours. */
export async function saveSigningSecret(
  fetch: HostFetchFn,
  value: string,
): Promise<{ rolled: boolean }> {
  const out = unwrap(
    await fetch<unknown>(`${APP_SECRETS_PATH}/${SIGNING_SECRET_KEY}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: value.trim() }),
    }),
  ) as { rolled?: unknown }
  return { rolled: out.rolled === true }
}
