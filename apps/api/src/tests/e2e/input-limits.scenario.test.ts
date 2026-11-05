// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Length limits on the thread tools, over the running e2e server: the REST tool
// route (POST /api/apps/tools/kernel:<tool>) and the thread route agree on the
// title cap, and a refused call says which field and what limit.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { THREAD_TITLE_MAX_CHARS } from "@liaison/shared"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api } from "@liaison/test-helpers"
import { setupScenario, teardownScenario } from "./setup"

describe("Thread tool length limits", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string

  beforeAll(async () => {
    const result = await setupScenario({ seed: 78, org: { name: "Input limits E2E Org" } })
    env = result.env
    world = result.world
    url = env.serverUrl
  })

  afterAll(async () => {
    await teardownScenario(env, world)
  })

  const createViaTool = (title: string) =>
    api(url, "/api/apps/tools/kernel:threads_create", {
      method: "POST",
      token: world.admin.token,
      body: { params: { participantIds: [], title } },
    })

  it("creates a channel with a title at the limit", async () => {
    const res = await createViaTool("a".repeat(THREAD_TITLE_MAX_CHARS))
    expect(res.status).toBe(200)
  })

  it("refuses a longer title on the tool route, naming the field", async () => {
    const res = await createViaTool("a".repeat(THREAD_TITLE_MAX_CHARS + 1))
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toContain('\\"title\\"')
    expect(JSON.stringify(res.body)).toContain(String(THREAD_TITLE_MAX_CHARS))
  })
})
