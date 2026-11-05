// SPDX-License-Identifier: FSL-1.1-ALv2
// What a process runs, by its LIAISON_ROLE (lib/env.ts):
//   all    = HTTP + WebSocket API, job workers, leader-eligible (today's single container)
//   api    = HTTP + WebSocket API only
//   worker = job workers, leader-eligible, health-only HTTP server
import { env } from "./env"

export type LiaisonRole = "all" | "api" | "worker"

export function currentRole(): LiaisonRole {
  return env.LIAISON_ROLE
}

/** The process runs BullMQ job workers. */
export function hostsJobs(role: LiaisonRole): boolean {
  return role === "all" || role === "worker"
}

/** The process may contend for the leader lease and run the singletons. */
export function isLeaderEligible(role: LiaisonRole): boolean {
  return role === "all" || role === "worker"
}

/** The process serves the HTTP + WebSocket API. */
export function servesApi(role: LiaisonRole): boolean {
  return role === "all" || role === "api"
}
