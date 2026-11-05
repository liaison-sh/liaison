// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The wrapped shells (Capacitor, Tauri) only get a refresh token in the login
// body when their origin is in LIAISON_APP_ORIGINS. The api defaults that
// allowlist when the variable is UNDEFINED, but a compose passthrough of
// `${LIAISON_APP_ORIGINS:-}` would hand it an empty string, which parses to no
// origin at all. So compose must pass the variable through WITH the api's own
// default, and only override it when the host env sets it.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { DEFAULT_APP_ORIGINS } from "../apps/api/src/lib/app-origins"
import {
  DEMO_MODEL_PREFERENCE_ENV,
  demoModelPreference,
  demoModelPreferenceOverride,
} from "../apps/api/src/seed/tiers/demo/model-preference"

const ROOT = path.resolve(import.meta.dir, "..")

describe("compose passes the app origins allowlist to the api", () => {
  it("docker-compose.yml forwards LIAISON_APP_ORIGINS with the api default as fallback", () => {
    const compose = readFileSync(path.join(ROOT, "deploy/docker-compose.yml"), "utf8")
    expect(compose).toContain(
      `LIAISON_APP_ORIGINS: \${LIAISON_APP_ORIGINS:-${DEFAULT_APP_ORIGINS}}`,
    )
  })
})

/**
 * A QA box's model pins were temporary edits: `demo:seed` runs after every
 * deploy there and rewrites `modelPreference` on conflict as well as on
 * insert, so all four demo agents went back to the frontier models
 * DEMO_ROLE_AGENTS names and the box resumed spending on them with nobody
 * having decided to. The pin belongs to the BOX now.
 */
describe("the demo seed's model preference override", () => {
  const seeded = "claude-sonnet-4-6"
  const pin = "gemini-flash-lite-latest"

  it("is what the seed writes when the box names one", () => {
    expect(demoModelPreference(seeded, { [DEMO_MODEL_PREFERENCE_ENV]: pin })).toBe(pin)
    expect(demoModelPreferenceOverride({ [DEMO_MODEL_PREFERENCE_ENV]: pin })).toBe(pin)
  })

  it("leaves the demo world's own model alone on every other box", () => {
    expect(demoModelPreference(seeded, {})).toBe(seeded)
    expect(demoModelPreferenceOverride({})).toBeNull()
  })

  // Compose passes an unset variable through as the empty string, and an empty
  // pin would put every demo agent back on Auto.
  it("reads an empty or blank value as no override at all", () => {
    expect(demoModelPreference(seeded, { [DEMO_MODEL_PREFERENCE_ENV]: "" })).toBe(seeded)
    expect(demoModelPreference(seeded, { [DEMO_MODEL_PREFERENCE_ENV]: "   " })).toBe(seeded)
  })

  it("trims what the env file carries", () => {
    expect(demoModelPreference(seeded, { [DEMO_MODEL_PREFERENCE_ENV]: ` ${pin}\n` })).toBe(pin)
  })

  it("is the value the role agent seed writes, on insert AND on conflict", () => {
    const tierSrc = readFileSync(
      path.join(ROOT, "apps/api/src/seed/tiers/demo/seed-org.ts"),
      "utf8",
    )
    expect(tierSrc).toContain("const modelPreference = demoModelPreference(def.modelPreference)")
    expect(tierSrc).not.toContain("modelPreference: def.modelPreference")
    // The factory writes that one value on both halves of the upsert: rewriting
    // only one of them is how the pin survives a create and dies on the next
    // re-seed, which is the exact shape of the bug.
    const factorySrc = readFileSync(
      path.join(ROOT, "apps/api/src/seed/factories/agent/agents.ts"),
      "utf8",
    )
    expect(factorySrc.match(/^\s+modelPreference,$/gm)?.length).toBe(2)
  })

  it("reaches the owner's own personal agent, not only the role desks", () => {
    const seedSrc = readFileSync(
      path.join(ROOT, "apps/api/src/seed/tiers/demo/seed-org.ts"),
      "utf8",
    )
    expect(seedSrc).toContain("async function applyDemoModelPreference(")
    const owner = seedSrc.slice(seedSrc.indexOf("seedPersonalAgent(orgId, ownerUserId"))
    expect(owner).toContain("await applyDemoModelPreference(agent.agentId)")
  })

  it("is forwarded to the api by compose, empty on every deployment that is not a QA box", () => {
    const compose = readFileSync(path.join(ROOT, "deploy/docker-compose.yml"), "utf8")
    expect(compose).toContain(`${DEMO_MODEL_PREFERENCE_ENV}: \${${DEMO_MODEL_PREFERENCE_ENV}:-}`)
  })
})
