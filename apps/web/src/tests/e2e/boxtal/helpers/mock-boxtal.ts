// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 18 E2E harness — Boxtal mock control + recorder client.
//
// The Boxtal sandbox-fetch mock runs SERVER-SIDE (in the spawned API process),
// so the Playwright worker drives it over HTTP via the `/api/_test/boxtal/mock`
// control routes. `setMockMode` selects the per-server-process response variant
// (422-phone, 5xx, CONFIRMED-flip, tracking status, cotation fixture);
// `getRequests` reads the recorder; `resetMock` clears both.
//
// SERIAL-WITHIN-WORKER: the mock mode is a per-server-process global. Boxtal
// scenarios run serially within a worker (the default for `.scenario.test.ts`).
// For S9's mid-test flip (422-then-success, 5xx-then-duplicate), call
// `setMockMode` BETWEEN the two create calls, never concurrently.
import { api } from "@liaison/test-helpers"

export interface BoxtalMockRequest {
  url: string
  method: string
  headers: Record<string, string>
  actor: string | null
  body: string | null
  receivedAt: number
}

export interface SetMockModeOptions {
  serverUrl: string
  token: string
  cotationFixture?: "multi" | "empty" | "error" | "dev"
  createMode?: "pending" | "phone_422" | "server_5xx"
  confirmOrderId?: string
  dispatchOrderId?: string
  cancelOrderId?: string
  trackingStatus?: { orderId: string; status: string }
  /** A slow carrier: the create is recorded, then answers after this many ms. */
  createLatencyMs?: number
}

export async function setMockMode(opts: SetMockModeOptions): Promise<void> {
  const { serverUrl, token, ...patch } = opts
  const resp = await api(serverUrl, "/api/_test/boxtal/mock/mode", {
    method: "POST",
    token,
    body: patch,
  })
  if (resp.status !== 200) {
    throw new Error(`setMockMode: ${resp.status} ${JSON.stringify(resp.body)}`)
  }
}

export async function resetMock(serverUrl: string, token: string): Promise<void> {
  const resp = await api(serverUrl, "/api/_test/boxtal/mock/reset", { method: "POST", token })
  if (resp.status !== 200) {
    throw new Error(`resetMock: ${resp.status} ${JSON.stringify(resp.body)}`)
  }
}

export async function getRequests(serverUrl: string, token: string): Promise<BoxtalMockRequest[]> {
  const resp = await api(serverUrl, "/api/_test/boxtal/mock/requests", { method: "GET", token })
  if (resp.status !== 200) {
    throw new Error(`getRequests: ${resp.status} ${JSON.stringify(resp.body)}`)
  }
  return (resp.body as { requests: BoxtalMockRequest[] }).requests
}

/** v3 shipping-order create POSTs (the gate assertion: zero before approval). */
export function v3CreatePosts(requests: BoxtalMockRequest[]): BoxtalMockRequest[] {
  return requests.filter(
    (r) =>
      r.method === "POST" && /\/shipping\/v3\.1\/shipping-order$/.test(new URL(r.url).pathname),
  )
}

/** v3 shipping-order DELETEs (the cancel assertion). */
export function v3CancelDeletes(requests: BoxtalMockRequest[]): BoxtalMockRequest[] {
  return requests.filter(
    (r) =>
      r.method === "DELETE" &&
      /\/shipping\/v3\.1\/shipping-order\/[^/]+$/.test(new URL(r.url).pathname),
  )
}

/** v1 cotation GETs (the quote assertion). */
export function v1CotationGets(requests: BoxtalMockRequest[]): BoxtalMockRequest[] {
  return requests.filter(
    (r) => r.method === "GET" && /\/api\/v1\/cotation$/.test(new URL(r.url).pathname),
  )
}
