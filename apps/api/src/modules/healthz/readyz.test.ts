// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { INSTANCE_ID } from "~/infra/instance-id"
import { currentRole } from "~/lib/process-role"
import { markBootComplete, ReadinessTestAccess, setDraining } from "~/lib/readiness"

interface ReadyzBody {
  status: string
  role: string
  instanceId: string
  leader: boolean
}

async function readyz(): Promise<{ status: number; body: ReadyzBody }> {
  const r = await app.request("/readyz")
  return { status: r.status, body: (await r.json()) as ReadyzBody }
}

describe("GET /readyz", () => {
  afterEach(() => ReadinessTestAccess.reset())

  it("503 starting -> 200 ready -> 503 draining, the body naming role and instance", async () => {
    const starting = await readyz()
    expect(starting.status).toBe(503)
    expect(starting.body.status).toBe("starting")
    expect(starting.body.role).toBe(currentRole())
    expect(starting.body.instanceId).toBe(INSTANCE_ID)
    expect(typeof starting.body.leader).toBe("boolean")

    markBootComplete()
    const ready = await readyz()
    expect(ready.status).toBe(200)
    expect(ready.body.status).toBe("ready")
    expect(ready.body.instanceId).toBe(INSTANCE_ID)

    setDraining(true)
    const draining = await readyz()
    expect(draining.status).toBe(503)
    expect(draining.body.status).toBe("draining")
    expect(draining.body.role).toBe(currentRole())
  })
})
