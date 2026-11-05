// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { env } from "./env"
import {
  currentRole,
  hostsJobs,
  isLeaderEligible,
  type LiaisonRole,
  servesApi,
} from "./process-role"

describe("process role", () => {
  it("role matrix", () => {
    const matrix: Array<[LiaisonRole, { jobs: boolean; leader: boolean; api: boolean }]> = [
      ["all", { jobs: true, leader: true, api: true }],
      ["api", { jobs: false, leader: false, api: true }],
      ["worker", { jobs: true, leader: true, api: false }],
    ]
    for (const [role, want] of matrix) {
      expect({
        jobs: hostsJobs(role),
        leader: isLeaderEligible(role),
        api: servesApi(role),
      }).toEqual(want)
    }
  })

  it("currentRole reads LIAISON_ROLE", () => {
    expect(currentRole()).toBe(env.LIAISON_ROLE)
  })
})
