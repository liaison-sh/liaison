// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `standard` seed tier on a test server: `liaison seed --tier standard`
// run as a CLI process beside the worker's server, over the same data
// (cliProcessEnv), as an operator seeds a deployment. Then every person signs
// in, so a spec gets the world's ids and a token per person.
import { login } from "./auth"
import { API_DIR, cliProcessEnv, type WorkerEnv } from "./worker-env"

/** The QA teammates' password (`apps/api/src/seed/world/qa.ts`). */
export const STANDARD_PASSWORD = "QaPass1!"

export interface StandardUser {
  id: string
  email: string
  token: string
  name: string
}

export interface StandardThread {
  id: string
  handle: string
  title: string | null
}

export interface StandardContact {
  id: string
  name: string | null
  email: string | null
}

type ThreadKey =
  | "q2Marketing"
  | "bugCheckout"
  | "dmAdminAmina"
  | "dmAminaLucas"
  | "sprintRetro"
  | "securityAudit"
  | "designSystemV2"
  | "vendorEval"
  | "releaseChecklist"
  | "weeklyStandup"
  | "untitledDesignChat"
  | "untitledOpsChat"
  | "untitledAdminLucas"
  | "infraCostReview"

/** The seeded world as a spec reads it: people with tokens, threads and contacts by key. */
export interface StandardWorld {
  orgId: string
  admin: StandardUser
  amina: StandardUser
  lucas: StandardUser
  tobias: StandardUser
  margot: StandardUser
  threads: Record<ThreadKey, StandardThread>
  contacts: Record<
    "hansPrimary" | "hansDuplicate" | "sofiaPrimary" | "sofiaDuplicate",
    StandardContact
  >
}

type Seeded = Omit<StandardWorld, "admin" | "amina" | "lucas" | "tobias" | "margot"> &
  Record<"admin" | "amina" | "lucas" | "tobias" | "margot", Omit<StandardUser, "token">>

type SeedEnv = Pick<
  WorkerEnv,
  "serverUrl" | "schemaPrefix" | "redisPrefix" | "meiliIndexPrefix" | "encryptionKey"
>

/** `liaison seed --tier standard --admin <email> …args` beside the worker's server; its stdout. */
async function runStandardSeed(env: SeedEnv, adminEmail: string, args: string[]): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["bun", "src/cli/index.ts", "seed", "--tier", "standard", "--admin", adminEmail, ...args],
    cwd: API_DIR,
    env: cliProcessEnv(env, env.serverUrl),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) {
    throw new Error(`liaison seed --tier standard exited ${code}:\n${stderr.slice(-4000)}`)
  }
  return stdout
}

/**
 * Seed the standard world into the org of `admin` (the server's first
 * account, already registered) and sign everyone in.
 */
export async function seedStandardWorld(
  env: SeedEnv,
  admin: { email: string; password: string },
  opts: { now?: Date } = {},
): Promise<StandardWorld> {
  const t0 = performance.now()
  const stdout = await runStandardSeed(
    env,
    admin.email,
    opts.now ? ["--now", opts.now.toISOString()] : [],
  )
  process.stderr.write(`[standard-world] cli ${((performance.now() - t0) / 1000).toFixed(1)}s\n`)
  const line = stdout.trim().split("\n").pop() ?? ""
  const seeded = JSON.parse(line) as Seeded
  const signIn = async (
    person: Omit<StandardUser, "token">,
    password: string,
  ): Promise<StandardUser> => ({
    ...person,
    token: (await login(env.serverUrl, person.email, password)).accessToken,
  })
  return {
    orgId: seeded.orgId,
    admin: await signIn(seeded.admin, admin.password),
    amina: await signIn(seeded.amina, STANDARD_PASSWORD),
    lucas: await signIn(seeded.lucas, STANDARD_PASSWORD),
    tobias: await signIn(seeded.tobias, STANDARD_PASSWORD),
    margot: await signIn(seeded.margot, STANDARD_PASSWORD),
    threads: seeded.threads,
    contacts: seeded.contacts,
  }
}

/**
 * Put the standard world's agent-app baseline (skills, routines, agent chats,
 * past runs) back after a test cleared those tables; rows still there are kept.
 */
export async function restoreStandardAgentApp(env: SeedEnv, adminEmail: string): Promise<void> {
  await runStandardSeed(env, adminEmail, ["--only", "agent-app"])
}
