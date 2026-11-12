// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The apps' stored attention lists, recomputed in place for a test.
//
// The feed reads `kernel.app_attention_items` and runs no app code
// (attention-store.ts). A row a test writes straight into an app's table wakes
// no refresh, and the attention minute tick only QUEUES one: its job is
// deduplicated per (org, app) and minute (a second tick in the same minute is
// a no-op, the first job is kept as completed) and counted against the org's
// minute budget (past it, it moves to the next minute). A test that reads the
// feed right after seeding therefore cannot rely on the tick: it asks for the
// lists to be recomputed here, and gets them stored before the call returns.
import { attentionItemsRegistry } from "~/modules/apps/app-registries"
import { listEveryActiveUser, refreshAppAttention } from "~/modules/apps/attention-store"
import { awaitOrgApps } from "~/modules/apps/init"

export interface RefreshedAttention {
  /** Per app provider of the org: the people its list was computed for, and how many changed. */
  apps: Record<string, { people: number; changed: number }>
}

/** Run every app provider of the org (or only `only`) for each of its people, and store the lists. */
export async function refreshStoredAppAttention(
  orgId: string,
  only?: readonly string[],
): Promise<RefreshedAttention> {
  await awaitOrgApps(orgId)
  const apps = new Set<string>()
  for (const [[entryOrg, appName]] of attentionItemsRegistry.entriesOf(orgId)) {
    if (entryOrg === orgId && (!only || only.includes(appName))) apps.add(appName)
  }
  // Every active person, not only those around: a test reads the feed of someone who has not
  // read it yet, and a refresh left alone runs for the people around only.
  const userIds = await listEveryActiveUser(orgId)
  const out: RefreshedAttention["apps"] = {}
  for (const app of [...apps].sort()) out[app] = await refreshAppAttention(orgId, app, { userIds })
  return { apps: out }
}
