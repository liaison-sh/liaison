// SPDX-License-Identifier: FSL-1.1-ALv2
import type { Context } from "hono"
import type { AppEnv } from "~/app"
import type { RlsClient } from "~/db"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"

export function extractRlsContext(c: Context<AppEnv>): UserContext {
  return {
    actorType: "user",
    userId: c.get("userId"),
    orgId: c.get("orgId"),
    scopes: c.get("scopes"),
    dimensionGrants: c.get("dimensionGrants"),
    roles: c.get("roles"),
  }
}

export async function withRequestRls<T>(
  c: Context<AppEnv>,
  fn: (tx: RlsClient) => Promise<T>,
): Promise<T> {
  return withRlsContext(extractRlsContext(c), fn)
}
