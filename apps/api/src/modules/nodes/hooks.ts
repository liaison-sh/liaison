// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What the realtime server does for a node connection (P4). Kept out of
 * `lib/server.ts` so the WS handler stays a thin dispatcher.
 */
import { rootLogger } from "~/lib/logger"
import { offerWaitingJobsToConnection } from "./jobs"
import { notifyNodePresence } from "./node-broadcast"
import { openNodeSessionForHello } from "./presence"

const log = rootLogger.child({ module: "node-hooks" })

/**
 * A desktop connection said hello. When it presented a node credential of
 * this user for the deviceId it announced (A25, F11): open the node's
 * connected interval, bind the connection to the node in the presence
 * registry (`bindConnection`, which is what makes the node online), tell
 * the owner's clients it is online (node-broadcast.ts), then offer it the waiting jobs that are not backlog (A23: backlog jobs wait for
 * the node's own prompt).
 */
export async function onNodeConnectionHello(input: {
  orgId: string
  userId: string
  deviceId: string
  connId: string
  nodeCredential: string | undefined
  bindConnection: (nodeId: string) => Promise<unknown>
}): Promise<{ nodeId: string; sessionId: string } | null> {
  const opened = await openNodeSessionForHello(input)
  if (!opened) return null
  await input.bindConnection(opened.nodeId)
  // Published once the connection is bound, so a client that refetches on
  // this frame already reads the node online (S18).
  await notifyNodePresence({
    orgId: input.orgId,
    ownerUserId: input.userId,
    nodeId: opened.nodeId,
    online: true,
  })
  try {
    await offerWaitingJobsToConnection({ ...input, nodeId: opened.nodeId })
  } catch (err) {
    log.warn({ err, nodeId: opened.nodeId }, "offering waiting jobs on connect failed")
  }
  return opened
}
