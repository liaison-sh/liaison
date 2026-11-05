// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { INSTANCE_ID } from "~/infra/instance-id"
import { currentRole } from "~/lib/process-role"
import { markBootComplete, ReadinessTestAccess, readiness, setDraining } from "~/lib/readiness"

describe("process readiness", () => {
  afterEach(() => ReadinessTestAccess.reset())

  it("starts, becomes ready at boot complete, and drains", () => {
    expect(readiness().status).toBe("starting")
    markBootComplete()
    expect(readiness().status).toBe("ready")
    setDraining(true)
    expect(readiness().status).toBe("draining")
    setDraining(false)
    expect(readiness().status).toBe("ready")
  })

  it("draining wins over a boot that has not completed", () => {
    setDraining(true)
    expect(readiness().status).toBe("draining")
  })

  it("names the role, the process instance and its leadership", () => {
    const r = readiness()
    expect(r.role).toBe(currentRole())
    expect(r.instanceId).toBe(INSTANCE_ID)
    expect(typeof r.leader).toBe("boolean")
  })
})
