// SPDX-License-Identifier: FSL-1.1-ALv2
declare const SCOPE_BRAND: unique symbol

/** A validated scope string. Guaranteed to not contain commas. */
export type Scope = string & { readonly [SCOPE_BRAND]: true }

/** Create a validated Scope. Throws if the string contains commas or is empty. */
export function createScope(raw: string): Scope {
  if (raw.length === 0) throw new Error("Scope cannot be empty")
  if (raw.includes(",")) throw new Error(`Scope cannot contain commas: "${raw}"`)
  return raw as Scope
}

/**
 * Context required by every permission mutation (grant/revoke/assign/unassign).
 * Enforces symmetric authorization: every mutation receives the actor's full context.
 */
export interface PermissionMutationContext {
  readonly actorId: string
  readonly actorScopes: Scope[]
  readonly actorDimensionGrants: Readonly<Record<string, readonly string[]>>
  readonly orgId: string
  /** Who asked for the change when that is not the actor (an approved agent
   *  request): recorded on the change's event as `metadata.requestedBy`. */
  readonly requestedBy?: string
}
