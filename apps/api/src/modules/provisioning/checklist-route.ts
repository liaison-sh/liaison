// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * GET /api/first-run/checklist: the workspace's setup checklist as it is now,
 * for the first-open setup card. The card's row carries the checklist of the
 * moment it was posted; the card reads this instead, so a step done since
 * (a goal, a knowledge page, an invitation) shows as done without the agent
 * posting a new card. Derived from rows each time (provisioning/setup-state.ts),
 * never stored. Any member may read it, as the agent's `setup_state` tool:
 * keys, booleans and a timestamp, no names and no counts.
 */
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { success } from "~/lib/response"
import { computeSetupState, type SetupItemKey } from "~/modules/provisioning/setup-state"

export interface FirstRunChecklist {
  items: Array<{ key: SetupItemKey; done: boolean; optional: boolean }>
  next: SetupItemKey | null
  asOf: string
}

export const firstRunChecklistRoutes = new Hono<AppEnv>()

firstRunChecklistRoutes.get("/checklist", async (c) => {
  const state = await computeSetupState(c.get("orgId"))
  const body: FirstRunChecklist = {
    items: state.items.map(({ key, done, optional }) => ({ key, done, optional })),
    next: state.next,
    asOf: state.asOf,
  }
  return success(c, body)
})
