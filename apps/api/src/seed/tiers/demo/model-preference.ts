// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE MODEL A QA BOX PINS ITS DEMO AGENTS TO.
//
// `seedRoleAgents` writes `modelPreference` on conflict as well as on insert,
// on purpose: "re-run the seed to reset the world" has to be true for what an
// agent IS, not only for how many rows exist. The cost of that is that a QA
// box's own pin is a temporary edit: `bun run demo:seed` runs after every
// deploy there, and every time it did, the four demo agents went back to the
// models `DEMO_ROLE_AGENTS` names and the box started spending on frontier
// models again with nobody having decided to.
//
// So the pin becomes part of the box rather than part of the world: set
// LIAISON_DEMO_MODEL_PREFERENCE in the deployment's env and the seed writes
// THAT for every demo agent it creates or adopts, every run. Unset (which is
// every other deployment, the public demo included) it changes nothing and
// each agent keeps the model the demo world names for it.
export const DEMO_MODEL_PREFERENCE_ENV = "LIAISON_DEMO_MODEL_PREFERENCE"

/** The box's pin, or null when the box does not name one. */
export function demoModelPreferenceOverride(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env[DEMO_MODEL_PREFERENCE_ENV]
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  // An empty value is how compose passes "not set" through, so it has to read
  // as no override rather than as a pin to the empty string, which would put
  // every demo agent back on Auto.
  return trimmed.length > 0 ? trimmed : null
}

/** What the seed writes for an agent the demo world pins to `seeded`. */
export function demoModelPreference(
  seeded: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return demoModelPreferenceOverride(env) ?? seeded
}
