// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pennylane client facade. Reads the org credentials-connection map via the
// dual-shape getCredentials accessor (FLAT sandbox-bridge `getCredentials(name)`
// + RECORD SDK `{pennylane:{getCredentials()}}`), validates apiToken+scope, and
// constructs a PennylaneClient wired to ctx.fetch.
import { readConnectionCredentials } from "@liaison/app-sdk/connection-credentials"
import { PennylaneClient, type PennylaneFetch } from "./pennylane-client"
import type { PennylaneScope } from "../types"

const CONNECTION = "pennylane"
const REQUIRED_KEYS = ["apiToken", "scope"] as const

export interface PennylaneFacade {
  client: PennylaneClient
  scope: PennylaneScope
}

interface PennylaneCtx {
  fetch: PennylaneFetch
  connections: unknown
}

// Exported so callers (reads.ts) can `instanceof`-check it to normalize a
// not-connected state into the structured `{ error: { code, message } }`
// envelope instead of letting the throw propagate (the kernel redacts
// sandboxed handler throws in production, hiding the actionable message).
export class PennylaneConnectionError extends Error {
  /** True only when no Pennylane connection exists; false when one exists but is unusable. */
  readonly notConnected: boolean
  constructor(message: string, opts: { notConnected?: boolean } = {}) {
    super(message)
    this.name = "PennylaneConnectionError"
    this.notConnected = opts.notConnected === true
  }
}

/** Build the Pennylane client facade from the live credentials connection. */
export async function getClient(ctx: PennylaneCtx): Promise<PennylaneFacade> {
  const read = await readConnectionCredentials(ctx.connections, CONNECTION, REQUIRED_KEYS)
  if (!read.ok) {
    if (read.reason === "incomplete")
      throw new PennylaneConnectionError(
        `Pennylane credentials incomplete, missing: ${read.missing.join(", ")}`,
      )
    throw new PennylaneConnectionError("Pennylane not connected", { notConnected: true })
  }
  const map = read.credentials
  const scope = map.scope
  if (scope !== "company" && scope !== "firm") {
    throw new PennylaneConnectionError(
      `Pennylane scope must be 'company' or 'firm', got '${scope}'`,
    )
  }
  // A firm token serves many companies: Pennylane needs `X-Company-Id` on every call.
  const companyId = typeof map.companyId === "string" && map.companyId.trim() !== "" ? map.companyId.trim() : null
  if (scope === "firm" && !companyId) {
    throw new PennylaneConnectionError("Pennylane firm scope needs the company id (Company ID field of the connection)")
  }
  const client = new PennylaneClient({ fetch: ctx.fetch, apiToken: map.apiToken!, companyId: scope === "firm" ? companyId : null })
  return { client, scope }
}
