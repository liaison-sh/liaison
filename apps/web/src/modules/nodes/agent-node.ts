// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE NODE A CLOUD AGENT IS ATTACHED TO, for the viewer (L26 UI): an agent
// whose requests the viewer's node takes (an attachment, A17) runs on
// Liaison and on that node. Read only while the viewer has an enabled node
// (live, L27), so a viewer without one makes no request.

import { type Accessor, createResource, onMount } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { nodeAttachments } from "./node-api"
import { hasEnabledNode, loadNodes, nodeById, nodes } from "./nodes-store"

/**
 * The name of the viewer's node `agentId` is attached to, or null (not
 * attached, no node, or not known yet).
 */
export function createAttachedNodeName(
  api: Pick<ApiClient, "get"> | undefined,
  agentId: Accessor<string | null | undefined>,
): Accessor<string | null> {
  onMount(() => {
    if (api) void loadNodes(api)
  })
  const [attachment] = createResource(
    () => {
      const id = agentId()
      return api && id && hasEnabledNode() ? id : null
    },
    async (id) => {
      if (!api) return null
      try {
        return (await nodeAttachments(api)).find((a) => a.agentId === id) ?? null
      } catch {
        return null
      }
    },
  )
  return () => {
    const a = attachment.latest
    if (!a) return null
    if (a.nodeId) return nodeById(a.nodeId)?.name ?? null
    return nodes().find((n) => n.enabled)?.name ?? null
  }
}
