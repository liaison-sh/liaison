// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A 503 is two different things. Relayed from an outside upstream (a provider, a
// connected service), it is an outcome the caller retries: the access log writes
// it at warn. Produced because one of OUR own dependencies is down (the database,
// Redis, search, a maintenance window), it is a fault here: error. A route that
// answers the second kind marks its response with this helper.
import type { Context } from "hono"
import type { AppEnv } from "~/app"

/** Mark this response's failure as one of our own dependencies being down (logged at error). */
export function markOwnDependencyDown(c: Context<AppEnv>): void {
  c.set("ownDependencyDown", true)
}
