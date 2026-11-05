// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The actors factory: a seeded person as the product sees them on a request,
// and an RLS transaction run as that person.
//
// Privileged read only: a person's effective permissions (role scopes and
// dimension grants) are loaded the way the auth middleware loads them, over
// the privileged connection, because the RLS role cannot read another
// person's role grants. Nothing is widened: a write the person could not make
// in the product is refused here too, which is the point of seeding through
// the real services.
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import type { SeedContext } from "~/seed/context"

/** The drizzle transaction type the kernel services take. Structural on purpose. */
export type RlsTx = Parameters<Parameters<typeof withRlsContext>[1]>[0]

/** A real `UserContext` for `userId`, with exactly the scopes and grants their roles carry. */
export async function actorFor(ctx: SeedContext, userId: string): Promise<UserContext> {
  const perms = await withPrivilegedDb(ctx.orgId, "seed-actor:load-permissions", (tx) =>
    loadEffectivePermissions(tx, userId, ctx.orgId),
  )
  return {
    actorType: "user",
    userId,
    orgId: ctx.orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
    roles: perms.roles,
  }
}

/** Run `fn` inside a real RLS transaction as `actor`. */
export function asUser<T>(actor: UserContext, fn: (tx: RlsTx) => Promise<T>): Promise<T> {
  return withRlsContext(actor, fn as (tx: unknown) => Promise<T>)
}

/** `SELECT`, unwrapped: drizzle returns either an array or `{ rows }`. */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  return ((result as { rows?: unknown[] }).rows ?? []) as T[]
}

/** A seeded person as the factories address them. */
export interface SeedPerson {
  userId: string
  email: string
  name: string
}
