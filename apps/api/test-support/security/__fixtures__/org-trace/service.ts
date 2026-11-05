// SPDX-License-Identifier: FSL-1.1-ALv2
// Fixture for the org-id caller trace (enumerate.test.ts).
import { withPrivilegedDb } from "./db"

const handlers: Array<(orgId: string) => Promise<number>> = []

/** Called by a route with the auth context: traced. */
export async function loadThing(orgId: string, id: string) {
  return withPrivilegedDb(orgId, "thing", async () => id)
}

/** Reached through a default dependency, `(deps.load ?? loadOther)(orgId)`: traced. */
export async function loadOther(orgId: string) {
  return withPrivilegedDb(orgId, "other", async () => 1)
}

export async function viaDeps(orgId: string, deps: { load?: typeof loadOther } = {}) {
  return (deps.load ?? loadOther)(orgId)
}

/** Called with a query parameter: untraced. */
export async function fromQuery(orgId: string) {
  return withPrivilegedDb(orgId, "query", async () => 2)
}

/** Kept in a registry and called later: untraced unless the registry is reviewed. */
export async function registered(orgId: string) {
  return withPrivilegedDb(orgId, "registered", async () => 3)
}

export function register(fn: (orgId: string) => Promise<number>) {
  handlers.push(fn)
}

register(registered)
