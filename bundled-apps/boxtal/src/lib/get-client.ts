// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Boxtal client facade. Reads the org's credentials-connection map via the
// `getCredentials` accessor (Task K-CREDS), validates the five expected keys,
// and constructs a `BoxtalV1Client` + `BoxtalV3Client` wired to `ctx.fetch`.
//
// `ctx.connections` has two runtime shapes (same as Shopify's
// `resolveShopConnection`):
//   - FLAT  `{ getCredentials(name, id?) }` — the sandbox bridge group.
//   - RECORD `{ boxtal: { getCredentials(id?) } }` — the SDK type / unit-test mock.
// We normalize to one accessor so the facade is correct under both.

import { readConnectionCredentials } from "@liaison/app-sdk/connection-credentials"
import { BoxtalV1Client } from "./boxtal-v1-client"
import {
  type BoxtalEnvironment,
  type BoxtalFetch,
  BoxtalV3Client,
} from "./boxtal-v3-client"

const CONNECTION = "boxtal"
const REQUIRED_KEYS = ["v1Key", "v1Secret", "v3Key", "v3Secret", "environment"] as const

export interface BoxtalFacade {
  v1: BoxtalV1Client
  v3: BoxtalV3Client
  environment: BoxtalEnvironment
}

interface BoxtalCtx {
  fetch: BoxtalFetch
  connections: unknown
}

class BoxtalConnectionError extends Error {
  // Deliberate typed error (mirrors ads' GoogleConfigError): carries a stable
  // `code` so `getClientOrError` can classify "not connected" without string
  // matching, and callers that need the raw throw (getClient, connection
  // event handlers) still get a real Error with a readable message.
  code = "boxtal_not_connected"
  constructor(message: string) {
    super(message)
    this.name = "BoxtalConnectionError"
  }
}

/** Build the Boxtal v1/v3 client facade from the live credentials connection. */
export async function getClient(ctx: BoxtalCtx): Promise<BoxtalFacade> {
  const read = await readConnectionCredentials(ctx.connections, CONNECTION, REQUIRED_KEYS)
  if (!read.ok) {
    if (read.reason === "incomplete") {
      throw new BoxtalConnectionError(
        `Boxtal credentials incomplete, missing: ${read.missing.join(", ")}`,
      )
    }
    throw new BoxtalConnectionError("Boxtal not connected")
  }
  const map = read.credentials
  const environment = map.environment
  if (environment !== "sandbox" && environment !== "production") {
    throw new BoxtalConnectionError(
      `Boxtal environment must be 'sandbox' or 'production', got '${environment}'`,
    )
  }
  const v1 = new BoxtalV1Client({
    fetch: ctx.fetch,
    v1Key: map.v1Key!,
    v1Secret: map.v1Secret!,
    environment,
  })
  const v3 = new BoxtalV3Client({
    fetch: ctx.fetch,
    v3Key: map.v3Key!,
    v3Secret: map.v3Secret!,
    environment,
  })
  return { v1, v3, environment }
}

/**
 * Whether the org has an ACTIVE Boxtal connection row, independent of whether its
 * credentials can be read. The kernel's credentials read throws the same way for
 * "no connection" and "connection present but undecryptable", so a caller that
 * must tell the two apart (the webhook probe: null vs "could not look") asks the
 * account list instead. Null when the runtime exposes no account accessor.
 */
export async function hasBoxtalConnection(ctx: { connections: unknown }): Promise<boolean | null> {
  const conns = ctx.connections as {
    getAccounts?: (name: string) => Promise<unknown>
    [name: string]: unknown
  }
  let raw: unknown
  if (typeof conns?.getAccounts === "function") {
    raw = await conns.getAccounts(CONNECTION)
  } else {
    const entry = conns?.[CONNECTION] as { getAccounts?: () => Promise<unknown> } | undefined
    if (!entry || typeof entry.getAccounts !== "function") return null
    raw = await entry.getAccounts()
  }
  const list = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw
  return Array.isArray(list) && list.length > 0
}

/** Structured "tool couldn't run" envelope — see getClientOrError below. */
export interface BoxtalClientError {
  error: { code: string; message: string }
}

/**
 * Tool-facing variant of getClient: not-connected is an EXPECTED state, not a
 * crash. The kernel redacts sandboxed handler throws in production ("Tool
 * execution failed"), which hides the actionable "connect Boxtal in app
 * settings" message from the agent/UI. Callers that back an agent-facing tool
 * should use this instead of a raw getClient(ctx) + try/catch, and return the
 * envelope as-is when `"error" in result` — any OTHER thrown error (a real
 * bug, a downstream Boxtal API failure) still propagates as a throw.
 *
 * getClient itself keeps throwing: onConnectionEstablished legitimately wants
 * a hard failure (it IS the connection-validation step), and get-client.test.ts
 * pins the throwing contract.
 */
export async function getClientOrError(ctx: BoxtalCtx): Promise<BoxtalFacade | BoxtalClientError> {
  try {
    return await getClient(ctx)
  } catch (err) {
    if (err instanceof BoxtalConnectionError) {
      return { error: { code: err.code, message: err.message } }
    }
    throw err
  }
}
