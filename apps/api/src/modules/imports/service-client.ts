// SPDX-License-Identifier: FSL-1.1-ALv2
import type { PrivilegedDb, RlsClient } from "~/db"

/**
 * Services of the built-in apps take the branded RlsClient. An import writes
 * through the run's privileged transaction pinned to the run's org, AFTER the
 * runner checked the person's write scopes and dimension grants (A42): that
 * legitimately bypasses RLS, and this is the one place the brand is crossed
 * for it.
 */
export function importServiceClient(tx: PrivilegedDb): RlsClient {
  return tx as unknown as RlsClient
}
