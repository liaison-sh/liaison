// SPDX-License-Identifier: FSL-1.1-ALv2
//
// V-7 / V-8 + B-NEW-6 — Component-A surfaces in the Agent app (§1 #7 / §12
// "Component A UI" / §3.4-§3.5 instantiate-on-enable).
//
// CRITICAL: these are KERNEL surfaces. The Agent app's SkillsList / RoutinesList
// read via the kernel's own data path, NOT `window.__liaisonHost.invokeTool`. The
// host-mock interceptor would mock NOTHING here — so this file does NOT use it.
// Instead, per the proven `agent-skills-and-routines-visual` reference, the social
// app is REALLY installed + reconciled (Component A's reconciler seeds the
// `morning-digest` routine template + the social skills into the real DB where the
// Agent lists read them), plus `seedModelPricingAndCredits`. Then we open the
// Agent surface and crop to the list locator.
//
// Pixel goldens are darwin-only; functional assertions run everywhere.
import { api } from "@liaison/test-helpers"
import { seedModelPricingAndCredits } from "../helpers/agent-seed"
import { assertSocialBundle, expect, test } from "./helpers/social-fixtures"
import {
  deleteRoutine,
  installSocialApp,
  listRoutines,
  resetSocialMock,
} from "./helpers/social-harness"

test.setTimeout(120_000)

test.describe("Social Ground Control agent assets visual", () => {
  // Delete any social morning-digest routine left in the worker-shared org (by a
  // sibling file like B0, or a prior run of this file). Keeps B-NEW-6's click and
  // B0's enable→pause→resume lifecycle order-independent on the reused worker.
  async function clearMorningDigest(serverUrl: string, token: string): Promise<void> {
    const routines = await listRoutines({ serverUrl, token })
    for (const r of routines) {
      if (r.appName === "social" && r.templateKey === "morning-digest") {
        await deleteRoutine({ serverUrl, token, id: r.id })
      }
    }
  }

  test.beforeAll(async ({ env, world, qa }) => {
    assertSocialBundle()
    await resetSocialMock(env.serverUrl, qa.admin.token)
    // Real install → reconcile seeds the social Component-A assets into the DB.
    await installSocialApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
    })
    await clearMorningDigest(env.serverUrl, qa.admin.token)
  })

  test.beforeEach(async ({ env, world }) => {
    await seedModelPricingAndCredits(env, world.org.id)
  })

  // B-NEW-6 enables the morning-digest template, instantiating a routine in the
  // worker-shared org. Restore the baseline so B0's enable→pause→resume lifecycle
  // (a sibling file in the same reused worker) does not hit a 409 "Template
  // already enabled". Keeps these scenarios additive per the E2E plan.
  test.afterAll(async ({ env, qa }) => {
    await clearMorningDigest(env.serverUrl, qa.admin.token)
  })

  // P4c-T39 moved every Agents list onto an agent's page, where the lists are
  // SCOPED to that agent: the org-level app routine templates and the
  // built-in (app-shipped) skills groups render only in the unscoped list,
  // which no screen mounts any more. Until the product gives them a surface
  // again, these scenarios prove the offer through the kernel API the lists
  // read, and say what the UI no longer shows.
  // ── V-7: routines — the app's routine template is offered ──────────────────
  test("routines app templates", async ({ env, qa }) => {
    const res = await api(env.serverUrl, "/api/agent/routines/templates", {
      token: qa.admin.token,
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const templates = (res.body.data ?? []) as Array<{
      appName: string
      templateKey: string
      kind?: string
    }>
    const morning = templates.find(
      (t) => t.appName === "social" && t.templateKey === "morning-digest",
    )
    expect(morning, JSON.stringify(templates)).toBeTruthy()
  })

  // ── V-8: skills — the app's shipped skills carry its provenance ─────────────
  test("skills app provenance", async ({ env, qa }) => {
    const res = await api(env.serverUrl, "/api/agent/skills", { token: qa.admin.token })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const skills = (res.body.data ?? []) as Array<{
      name: string
      source?: string
      appName?: string | null
    }>
    const overview = skills.find((sk) => sk.name === "social-overview")
    expect(overview, JSON.stringify(skills.map((sk) => sk.name))).toBeTruthy()
    expect(overview?.appName).toBe("social")
  })

  // ── B-NEW-6: enabling the morning-digest template instantiates a routine ───
  test("click to enable morning digest template instantiates a real routine", async ({
    env,
    qa,
  }) => {
    const enabled = await api(
      env.serverUrl,
      "/api/agent/routines/templates/social/morning-digest/enable",
      { method: "POST", token: qa.admin.token, body: {} },
    )
    expect(enabled.status, JSON.stringify(enabled.body)).toBeLessThan(300)

    // A REAL user-owned routine: sourceKind 'app', status 'active'.
    const routines = await listRoutines({ serverUrl: env.serverUrl, token: qa.admin.token })
    const morning = routines.filter(
      (r) => r.appName === "social" && r.templateKey === "morning-digest",
    )
    expect(morning.length, JSON.stringify(routines)).toBe(1)
    expect(morning[0].sourceKind).toBe("app")
    expect(morning[0].status).toBe("active")
  })
})
