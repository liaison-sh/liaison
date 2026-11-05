// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one caller record a provider may store a file onto during a provider-contract op.
//
// A provider downloads a file host-side (`files_importFromUrl`) for its caller, so the file has to
// land under the CALLER's app, not the provider's. That cross-app write is granted per dispatch,
// never per app: only an op whose contract spec names a `fileTarget` param, and only onto the exact
// `{app, entity_type, entity_id}` the caller passed in that param, with `app` the caller itself.
// Every other op of the contract (send, book, …) stores nothing on the caller's side, whatever
// record the provider names.

import { KNOWN_CONTRACTS } from "@liaison/app-sdk/contracts"
import { UUID_RE } from "~/lib/uuid"

export interface ContractFileTarget {
  app: string
  entityType: string
  entityId: string
}

const IDENT_RE = /^[a-z][a-z0-9_-]*$/

/** The record bound to this dispatch, or null (no file may be stored on the caller's side). */
export function contractFileTarget(
  callerApp: string,
  call: { contract: string; op: string },
  params: unknown,
): ContractFileTarget | null {
  const param = KNOWN_CONTRACTS[call.contract]?.ops[call.op]?.fileTarget
  if (!param || !params || typeof params !== "object") return null
  const t = (params as Record<string, unknown>)[param]
  if (!t || typeof t !== "object") return null
  const { app, entity_type, entity_id } = t as Record<string, unknown>
  if (app !== callerApp || typeof entity_type !== "string" || typeof entity_id !== "string")
    return null
  if (!IDENT_RE.test(app) || !IDENT_RE.test(entity_type) || !UUID_RE.test(entity_id)) return null
  return { app, entityType: entity_type, entityId: entity_id }
}

/** The bridge options a verified contract dispatch carries: the bound record, when there is one. */
export function contractFileTargetOptions(
  callerApp: string,
  call: { contract: string; op: string },
  params: unknown,
): { contractCallerApp?: string; contractFileTarget?: ContractFileTarget } {
  const target = contractFileTarget(callerApp, call, params)
  return target ? { contractCallerApp: callerApp, contractFileTarget: target } : {}
}
