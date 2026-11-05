// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A51: a routine job's claim re-runs the routine pre-checks that still mean
// something on a node (scope drift, the owner agent's ceiling), and NOT the
// cloud model-key / credit pre-check: the node runs the job on its owner's own
// Claude sign-in, so an org with no model key or no credits must not refuse it.
//
// No dependency is overridden here: the test org has no model key, which is
// exactly the state the cloud pre-check refuses.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { createNodeJob } from "./jobs"

describe("claim pre-checks of a routine job (A51)", () => {
  let owner: minimal.Session
  let agentId: string
  let threadId: string

  const call = (path: string, method: string, body?: unknown, nodeCredential?: string) =>
    app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${owner.bearer}`,
        ...(nodeCredential
          ? { "X-Node-Credential": nodeCredential, "X-Liaison-Node-Protocol": "2" }
          : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  async function routineJob(scopes: string) {
    const [routine] = await sql<{ id: string }[]>`INSERT INTO kernel.routines
      (org_id, owner_user_id, owner_agent_id, name, description, kind, cron, timezone,
       prompt, scopes, created_by_actor_type)
      VALUES (${owner.orgId}, ${owner.userId}, ${agentId}, ${`r-${crypto.randomUUID()}`}, 'd',
              'recurring', '0 9 * * *', 'UTC', 'p', ${scopes}, 'user') RETURNING id`
    const job = await createNodeJob({
      orgId: owner.orgId,
      ownerUserId: owner.userId,
      agentId,
      threadId,
      source: "routine",
      routineId: routine.id,
      prompt: "tick",
      sourceRequiredScopes: [],
    })
    return { routineId: routine.id, jobId: job.id }
  }

  async function errorCode(jobId: string) {
    const [row] = await sql<Array<{ status: string; error_code: string | null }>>`
      SELECT status, error_code FROM kernel.node_jobs WHERE id = ${jobId}`
    return row
  }

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    owner = await minimal.session(org.id)
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@a51-${crypto.randomUUID().slice(0, 8)}`}, 'Fixer',
              '["kernel:threads:read","kernel:threads:write"]'::jsonb, ${owner.userId})
      RETURNING id`
    agentId = agent.id
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, created_by)
      VALUES (${owner.orgId}, ${`a51-${crypto.randomUUID().slice(0, 8)}`}, ${owner.userId})
      RETURNING id`
    threadId = t.id
  })

  beforeEach(async () => {
    await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
    await sql`UPDATE kernel.agents
      SET scope_ceiling = '["kernel:threads:read","kernel:threads:write"]'::jsonb WHERE id = ${agentId}`
  })

  afterAll(async () => {
    if (owner) {
      await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.routines WHERE org_id = ${owner.orgId}`
    }
    await releaseTestLock()
  })

  async function enable() {
    const res = await call("/api/nodes", "POST", { deviceId: `d.${crypto.randomUUID()}` })
    return ((await res.json()) as { data: { credential: string } }).data.credential
  }

  it("a routine job is claimed without the cloud model-key / credit pre-check", async () => {
    const credential = await enable()
    const { jobId } = await routineJob("{kernel:threads:read}")
    const res = await call(`/api/nodes/jobs/${jobId}/claim`, "POST", {}, credential)
    expect(res.status).toBe(200)
    expect((await errorCode(jobId)).status).toBe("running")
  })

  it("scope drift still refuses the claim", async () => {
    const credential = await enable()
    const { routineId, jobId } = await routineJob("{kernel:threads:read}")
    await sql`UPDATE kernel.routines SET scopes = '{a51:secret:write}' WHERE id = ${routineId}`
    expect((await call(`/api/nodes/jobs/${jobId}/claim`, "POST", {}, credential)).status).toBe(403)
    expect(await errorCode(jobId)).toEqual({ status: "refused", error_code: "scope_mismatch" })
  })

  it("an owner agent whose ceiling no longer covers the routine still refuses the claim", async () => {
    const credential = await enable()
    const { jobId } = await routineJob("{kernel:threads:write}")
    await sql`UPDATE kernel.agents SET scope_ceiling = '["kernel:threads:read"]'::jsonb WHERE id = ${agentId}`
    expect((await call(`/api/nodes/jobs/${jobId}/claim`, "POST", {}, credential)).status).toBe(403)
    expect(await errorCode(jobId)).toEqual({ status: "refused", error_code: "scope_mismatch" })
  })
})
