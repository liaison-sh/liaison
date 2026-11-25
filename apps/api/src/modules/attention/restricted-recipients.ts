// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Attention and notifications about a restricted record reach its list only. Every recipient
// list the attention pipeline resolves for an event about an agreement or a Knowledge document
// closed to the organization is narrowed to the people on that record's list, whatever the
// manifest's recipient kind (scope holders, mentions, a field). An open record narrows nothing.
// Fails closed: a list that cannot be read notifies nobody.

import { rootLogger as log } from "~/lib/logger"
import { restrictedListsFor } from "~/modules/agent/scopes/taint-approval-audience"
import { restrictedScopeOfEvent } from "~/modules/permissions/restricted-scope"

export async function keepRestrictedReaders(
  orgId: string,
  event: { app?: string; entity?: string; entityId?: unknown; data?: unknown },
  ids: string[],
): Promise<string[]> {
  const scope = restrictedScopeOfEvent(event)
  if (!scope || ids.length === 0) return ids
  try {
    const lists = await restrictedListsFor(orgId, [scope])
    const list = lists.get(scope)
    if (list === null) return ids
    if (!list) return []
    return ids.filter((id) => list.has(id))
  } catch (err) {
    log.error(
      { err, orgId, app: event.app, entity: event.entity },
      "Could not read a restricted record's list: its attention reaches nobody",
    )
    return []
  }
}
