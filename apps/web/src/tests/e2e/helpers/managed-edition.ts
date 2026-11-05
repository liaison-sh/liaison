// SPDX-License-Identifier: FSL-1.1-ALv2
// A profiled worker restarted as the managed edition (LIAISON_EDITION=managed).
//
// Only that variable switches managed on, and a managed server boots only
// under the managed checks (apps/api/src/lib/managed-boot.ts): an operator org,
// org hosts, a team endpoint, a pay frame origin, default models, a mail
// transport, OpenRouter as the only provider key, and a registered liaison
// team identity. The managed edition has no web bootstrap, so the profile
// creates its world on a self-hosted boot, then this prepares that server and
// returns the env of the managed restart:
//
//   envAfterWorld: managedEditionAfterWorld
//
// Org hosts: the template binds every session to its org's host. In
// production one origin serves the app and the API; here the worker's Vite
// server is that origin: its proxy forwards the page's own host
// (MANAGED_VITE_ENV), the template is `http://{slug}:<vite port>`, the world's
// org takes the slug `localhost`, and after the restart the test process talks
// to the API through Vite as well (`serverUrlAfterRestart`).
//
//   before: async () => ({ env: {}, teardowns: [], viteEnv: MANAGED_VITE_ENV,
//                          envAfterWorld: managedEditionAfterWorld })
import { randomUUID } from "node:crypto"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import type { ProfiledWorkerEnv } from "../fixtures/profiled-test"
import { seedFactory } from "./seed"

/** The worker's Vite proxy forwards the page's host (apps/web/src/lib/dev-proxy.ts). */
export const MANAGED_VITE_ENV = { VITE_PROXY_PRESERVE_HOST: "1" }

/** The slug the world's org is served under on a managed worker. */
export const MANAGED_TEST_ORG_SLUG = "localhost"

export async function managedEditionAfterWorld({
  env,
  world,
}: {
  env: WorkerEnv
  world: TestWorld
}): Promise<Record<string, string | undefined>> {
  await seedFactory(env, undefined, "liaisonTeam.identity", {})
  const kernel = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
  await env.db.sql.unsafe(`UPDATE ${kernel}.organizations SET slug = $1 WHERE id = $2`, [
    MANAGED_TEST_ORG_SLUG,
    world.org.id,
  ])
  const vitePort = env.ports[1]
  ;(env as ProfiledWorkerEnv).serverUrlAfterRestart = `http://localhost:${vitePort}`
  return {
    LIAISON_EDITION: "managed",
    // Another org holds the instance powers: the world's org is a customer's.
    LIAISON_OPERATOR_ORG_ID: randomUUID(),
    LIAISON_ORG_HOST_TEMPLATE: `http://{slug}:${vitePort}`,
    // Nothing listens there: no push or delivery leaves the machine.
    LIAISON_TEAM_ENDPOINT: "http://127.0.0.1:9",
    LIAISON_PAY_FRAME_ORIGIN: "https://pay.example.test",
    LIAISON_MANAGED_DEFAULT_MODELS: "deepseek/deepseek-v4.1-flash",
    SMTP_HOST: "127.0.0.1",
    OPENROUTER_API_KEY: "test-placeholder-openrouter-api-key",
    // Only OpenRouter's key may be set on a managed cell.
    LIAISON_ANTHROPIC_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    GOOGLE_API_KEY: undefined,
    MISTRAL_API_KEY: undefined,
    EXA_API_KEY: undefined,
  }
}
