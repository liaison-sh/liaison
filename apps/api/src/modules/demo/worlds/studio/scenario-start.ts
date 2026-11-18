// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What starting a services-world scenario writes into the visitor's
// workspace, once and idempotently. The client scenario brings nothing in: its
// one card (the reply and the change request) is seeded with the workspace and
// waits on Home from the start, and its world beat answers on the change
// request that card sends. The scenarios that have no tour yet write nothing.
import type { DemoNeed } from "@liaison/shared"

/** Write what the scenario of `need` brings in. Returns the approval ids written: none. */
export async function studioScenarioStart(
  _orgId: string,
  _need: DemoNeed,
  _ownerUserId: string,
): Promise<string[]> {
  return []
}
