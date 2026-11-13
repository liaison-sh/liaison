// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test-only: register the api-connector catalog app for a test org, from its
// source, as an org that installed it has it (its tools, its approvals).
import { apiConnectorSourceDescriptor } from "~/db/apply-app-schemas"
import { registerApps } from "~/modules/apps/runtime"

/** The app the tests' API connections belong to, and its API connection. */
export const TEST_API_APP = "api-connector"
export const TEST_API_CONNECTION = "api"

/** The test org's API connection key (store, caches, limiter). */
export function testApiConn(orgId: string): { orgId: string; app: string; connection: string } {
  return { orgId, app: TEST_API_APP, connection: TEST_API_CONNECTION }
}

export async function registerApiConnectorApp(orgId: string): Promise<void> {
  const { failedApps } = await registerApps([apiConnectorSourceDescriptor()], orgId)
  if (failedApps.length > 0) throw new Error("api-connector did not register")
}

/**
 * Save an adapter the way an admin's settings screen does (validated, the
 * platform's own write), for a test that needs a connection to exist.
 * Answers `{ status }` like the old settings route did.
 */
export async function seedAdapter(
  orgId: string,
  identifier: string,
  document: unknown,
): Promise<{ status: number }> {
  const { validateAdapterDocument } = await import("./adapter-policy")
  const { upsertAdapterRow } = await import("./store")
  const parsed = validateAdapterDocument(document)
  if (!parsed.ok) return { status: 422 }
  await upsertAdapterRow(testApiConn(orgId), identifier, parsed.adapter, null)
  return { status: 200 }
}
