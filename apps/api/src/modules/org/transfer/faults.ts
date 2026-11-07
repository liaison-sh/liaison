// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The steps at which a source agent can be told to stop on the spot
// (`agent --role source --fail-at <step>`), to rehearse a crash at that step
// on test servers: no abort, no more heartbeats, as a real crash would leave it.

export const MOVE_FAULT_POINTS = ["precopy", "draining", "frozen", "after-cas"] as const
export type MoveFaultPoint = (typeof MOVE_FAULT_POINTS)[number]
