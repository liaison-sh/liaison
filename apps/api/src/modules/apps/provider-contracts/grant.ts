// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Dispatch grants for outbound contract ops (a deposit, a transmission, a booking: ops the
// contract marks `outbound`). The kernel dispatches such an op only when the call carries a grant
// it minted itself, and it mints one only inside a person's decision: the approved re-entry of a
// gated, `noAutoApprove` tool of the calling app, or that tool's direct run on the click of a
// person holding its approve scope. No job, event handler, agent or other app can obtain one.
//
// A grant names the org, the calling app, the contract, the ops it allows, and a `subject`: param
// values every call must carry unchanged (the document, its legal original's fingerprint, ...).
// It is an HMAC-signed token (key derived from ENCRYPTION_KEY), stored by the caller next to the
// work it authorizes (a transmission row) and handed back with each call, so a two-phase send
// executed later by a job still proves that a person approved exactly that work.

import { createHmac, timingSafeEqual } from "node:crypto"
import { isOutboundOp } from "@liaison/app-sdk/contracts"
import { env } from "~/lib/env"

export interface ContractGrantPayload {
  v: 1
  org: string
  caller: string
  contract: string
  ops: string[]
  subject: Record<string, string>
  /** Expiry (epoch ms). A send may wait on the provider for a while (emission not activated). */
  exp: number
  /** The approval request the grant came from, or "direct_click". Audit only. */
  via: string
  /** The provider bound when the person decided: the work goes through it or not at all. */
  provider?: string
}

export const GRANT_TTL_MS = 90 * 24 * 3600 * 1000
const MAX_SUBJECT_KEYS = 8

function key(): Buffer {
  return createHmac("sha256", Buffer.from(env.ENCRYPTION_KEY, "hex"))
    .update("liaison:contract-dispatch-grant:v1")
    .digest()
}

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url")
}

export function mintContractGrant(
  p: Omit<ContractGrantPayload, "v" | "exp"> & { exp?: number },
): string {
  const payload: ContractGrantPayload = {
    v: 1,
    org: p.org,
    caller: p.caller,
    contract: p.contract,
    ops: [...p.ops],
    subject: { ...p.subject },
    exp: p.exp ?? Date.now() + GRANT_TTL_MS,
    via: p.via,
    ...(p.provider ? { provider: p.provider } : {}),
  }
  const body = b64url(JSON.stringify(payload))
  const mac = createHmac("sha256", key()).update(body).digest("base64url")
  return `${body}.${mac}`
}

/** Shape checks for a grant request (before minting). */
export function grantRequestProblem(
  contract: string,
  ops: unknown,
  subject: unknown,
): string | null {
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > 8)
    return "ops must be a non-empty list of outbound ops"
  for (const op of ops) {
    if (typeof op !== "string" || !isOutboundOp(contract, op))
      return `"${String(op)}" is not an outbound op of ${contract}`
  }
  if (!subject || typeof subject !== "object" || Array.isArray(subject))
    return "subject must be an object"
  const entries = Object.entries(subject as Record<string, unknown>)
  if (entries.length === 0 || entries.length > MAX_SUBJECT_KEYS)
    return `subject must bind 1 to ${MAX_SUBJECT_KEYS} params`
  for (const [k, v] of entries) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(k) || typeof v !== "string" || v === "" || v.length > 512) {
      return `subject.${k} must be a non-empty string`
    }
  }
  return null
}

export type GrantCheck =
  | { ok: true; payload: ContractGrantPayload }
  | { ok: false; code: string; message: string }

/**
 * Verify `token` authorizes `op` of `contract` from `callerApp` in `orgId` with these `params`:
 * signature, expiry, org, caller, contract, the op among its ops, and every subject value equal
 * to the call's param of the same name.
 */
export function verifyContractGrant(
  token: unknown,
  want: {
    orgId: string
    callerApp: string
    contract: string
    op: string
    params: unknown
    provider?: string
  },
): GrantCheck {
  if (typeof token !== "string" || token === "") {
    return {
      ok: false,
      code: "contract_grant_required",
      message: `${want.op} is an outbound op: it needs the dispatch grant of a person's approval`,
    }
  }
  const dot = token.indexOf(".")
  const body = dot > 0 ? token.slice(0, dot) : ""
  const mac = dot > 0 ? token.slice(dot + 1) : ""
  const expected = createHmac("sha256", key()).update(body).digest()
  let given: Buffer
  try {
    given = Buffer.from(mac, "base64url")
  } catch {
    given = Buffer.alloc(0)
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return {
      ok: false,
      code: "contract_grant_invalid",
      message: "the dispatch grant is not one the kernel minted",
    }
  }
  let p: ContractGrantPayload
  try {
    p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ContractGrantPayload
  } catch {
    return { ok: false, code: "contract_grant_invalid", message: "the dispatch grant is malformed" }
  }
  const params = (want.params && typeof want.params === "object" ? want.params : {}) as Record<
    string,
    unknown
  >
  const problems: string[] = []
  if (p.v !== 1) problems.push("version")
  if (!(typeof p.exp === "number" && p.exp > Date.now())) problems.push("expired")
  if (p.org !== want.orgId) problems.push("org")
  if (p.caller !== want.callerApp) problems.push("caller")
  if (p.contract !== want.contract) problems.push("contract")
  if (!Array.isArray(p.ops) || !p.ops.includes(want.op)) problems.push(`op ${want.op}`)
  if (want.provider !== undefined && p.provider !== undefined && p.provider !== want.provider) {
    return {
      ok: false,
      code: "contract_provider_changed",
      message: `this was approved for ${p.provider}; the organisation now binds ${want.provider}: ask for it again`,
    }
  }
  for (const [k, v] of Object.entries(p.subject ?? {})) {
    if (params[k] !== v) problems.push(`param ${k}`)
  }
  if (!p.subject || Object.keys(p.subject).length === 0) problems.push("subject")
  if (problems.length > 0) {
    return {
      ok: false,
      code: "contract_grant_mismatch",
      message: `the dispatch grant does not cover this call (${problems.join(", ")})`,
    }
  }
  return { ok: true, payload: p }
}
