// SPDX-License-Identifier: FSL-1.1-ALv2
// projects.agent-create-assign-marie — Playwright UI/tool-contract test (plan §4 fallback).
//
// The full plan calls for driving /api/agent/chat end-to-end with a deterministic
// LLM/provider boundary. That harness lives behind the AI SDK and is not yet
// wired for E2E; the runtime proof is therefore split off to a backend E2E named
// `projects.agent-runtime-create-assign-marie`. This Playwright test focuses on
// the production tool-contract path the agent would dispatch into:
// /api/apps/tools/projects:create with `assigneeName: "Marie"` must resolve to
// Marie's user id, scope-checked under the caller's JWT.
import { api } from "@liaison/test-helpers"
import { expect, loginAs, test } from "./fixtures/test"
import { ensureActiveMarie, grantProjectScopes } from "./helpers/projects-seed"

test("projects.agent-create-assign-marie", async ({ page, env, qa, world }) => {
  await grantProjectScopes(env, world.org.id, qa.admin.id)
  const marie = await ensureActiveMarie(env, {
    admin: { token: world.admin.token },
    org: { id: world.org.id },
    serverUrl: env.serverUrl,
  })

  const project = (
    await api(env.serverUrl, "/api/projects", {
      token: qa.admin.token,
      body: { name: `AgentTest-${Date.now()}` },
    })
  ).body.data as { id: string }

  // Login so the production tool-route runs under the same JWT/scope path the
  // agent runtime uses (caller-scoped). No /api/agent/chat stub: the plan
  // forbids stubbing it; the agent-runtime proof lives in the backend E2E.
  await loginAs(page, env, "admin@test.com", "12345678")
  // Wait for the shell itself: the agent panel this used to wait on is
  // retired (P4c-T17) and was never what this case is about.
  await expect(page.locator("[data-shell]")).toBeVisible({ timeout: 10_000 })

  // Drive the production tool route — same code path the agent runtime invokes
  // when it dispatches a tool-call for `projects:create`. assigneeName must
  // resolve to Marie's id; scope checks must succeed under Elodie's token.
  const toolRes = await api(env.serverUrl, "/api/apps/tools/projects:create", {
    token: qa.admin.token,
    body: { projectId: project.id, title: "Calibration drift", assigneeName: "Marie" },
  })
  expect(toolRes.status, JSON.stringify(toolRes.body)).toBe(200)

  const tasksRes = await api(env.serverUrl, `/api/projects/${project.id}/tasks`, {
    token: qa.admin.token,
  })
  const tasks = tasksRes.body.data.items as Array<{
    title: string
    assigneeId: string | null
  }>
  const calibration = tasks.find((t) => t.title === "Calibration drift")
  expect(calibration).toBeDefined()
  expect(calibration!.assigneeId).toBe(marie.id)
})
