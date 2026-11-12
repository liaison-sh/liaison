// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A run sent to the loader calls back on the instance's public address, and
// whichever process receives the call forwards it to the run's owner through
// the owner's internal listener, found by its heartbeat record
// (bridge-forward.ts). The server starts both at boot (index.ts). A CLI process
// (`liaison config apply`, `liaison app run-job`, a one-off container) starts
// neither, so the bridge calls of every run it dispatched were refused as
// `run_owner_gone` and the run failed. Such a process starts them on its first
// Workers run: the listener on its own host (a one-off container's hostname
// resolves on the deployment's network), the record with no job slots, so it
// is never counted as a job host. Both end with the process.

import {
  isInstanceHeartbeatRunning,
  setInstanceJobSlots,
  startInstanceHeartbeat,
} from "~/infra/instance-registry"
import { currentRole } from "~/lib/process-role"
import { startInternalListener } from "~/modules/agent/mailbox-plaintext/mailbox-forward"
import { internalAppBridgeRoute } from "./bridge-forward"

export interface RunOwnerDeps {
  isCli(): boolean
  heartbeatRunning(): boolean
  start(): Promise<void>
}

const defaultDeps: RunOwnerDeps = {
  isCli: () => process.env.LIAISON_CLI === "1",
  heartbeatRunning: isInstanceHeartbeatRunning,
  start: async () => {
    const listener = await startInternalListener({ extraRoutes: [internalAppBridgeRoute()] })
    setInstanceJobSlots({})
    await startInstanceHeartbeat({
      role: currentRole(),
      pid: process.pid,
      internalUrl: listener.url,
    })
  },
}

let starting: Promise<void> | null = null

/** Makes this process reachable as a run owner before it dispatches a Workers run (once per process). */
export function ensureRunOwnerReachable(deps: RunOwnerDeps = defaultDeps): Promise<void> {
  if (!deps.isCli() || deps.heartbeatRunning()) return Promise.resolve()
  starting ??= deps.start().catch((err) => {
    starting = null
    throw err
  })
  return starting
}

export const RunOwnerTestAccess = {
  reset(): void {
    starting = null
  },
}
