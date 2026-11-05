// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A rolling deploy (profile `rolling`) runs the old and the new `api` and
// `worker` processes at once, and runs `migrate` while the old ones still hold
// their connections. Each process plans its pools from one budget
// (apps/api/src/db/pool-plan.ts) and the compose values it is given; this
// guard runs the same planner on the compose file's defaults, so the bundled
// stack fits its own Postgres max_connections, and a hard-coded pool size in
// the compose file (which the planner cannot shrink) fails here, not at boot.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  DEFAULT_CELL_RESERVED,
  DEFAULT_KERNEL_NEED,
  MIGRATE_FOOTPRINT,
  type PlanRole,
  type PoolEnv,
  type PoolPlan,
  planInputFromEnv,
  planPools,
} from "../apps/api/src/db/pool-plan"

const ROOT = path.resolve(import.meta.dir, "..")

interface ComposeService {
  command?: string[] | string
  environment?: Record<string, string | number>
}
interface ComposeDoc {
  services: Record<string, ComposeService>
}

const COMPOSE = Bun.YAML.parse(
  readFileSync(path.join(ROOT, "deploy/docker-compose.yml"), "utf8"),
) as ComposeDoc
const POOL_KEYS = [
  "DB_POOL_MAX",
  "DB_PRIVILEGED_POOL_MAX",
  "DB_JOBS_POOL_MAX",
  "DB_PRIVILEGED_JOBS_POOL_MAX",
] as const

/** Interpolates `${VAR:-default}` (nested defaults too) the way compose does, from `vars`. */
function interpolate(value: string | number | undefined, vars: Record<string, string>): string {
  let text = String(value ?? "")
  for (let i = 0; i < 10 && text.includes("${"); i++) {
    text = text.replace(/\$\{([A-Z0-9_]+)(?::-([^${}]*))?\}/g, (_, name: string, dflt?: string) =>
      vars[name] !== undefined && vars[name] !== "" ? (vars[name] ?? "") : (dflt ?? ""),
    )
  }
  return text
}

function num(text: string): number | undefined {
  if (text === "") return undefined
  if (!/^\d+$/.test(text)) throw new Error(`not a number: ${text}`)
  return Number(text)
}

/** The pool env a service's process sees, with `vars` as the project's .env. */
function poolEnv(doc: ComposeDoc, service: string, vars: Record<string, string>): PoolEnv {
  const env = doc.services[service]?.environment ?? {}
  const n = (key: string) => num(interpolate(env[key], vars))
  return {
    DB_POOL_MAX: n("DB_POOL_MAX"),
    DB_PRIVILEGED_POOL_MAX: n("DB_PRIVILEGED_POOL_MAX"),
    DB_JOBS_POOL_MAX: n("DB_JOBS_POOL_MAX"),
    DB_PRIVILEGED_JOBS_POOL_MAX: n("DB_PRIVILEGED_JOBS_POOL_MAX"),
    DB_CELL_MAX_CONNECTIONS: n("DB_CELL_MAX_CONNECTIONS"),
    LIAISON_API_REPLICAS: n("LIAISON_API_REPLICAS"),
    LIAISON_WORKER_REPLICAS: n("LIAISON_WORKER_REPLICAS"),
  }
}

function maxConnections(doc: ComposeDoc, vars: Record<string, string>): number {
  const cmd = doc.services.postgres?.command
  const text = interpolate(Array.isArray(cmd) ? cmd.join(" ") : String(cmd ?? ""), vars)
  const m = /max_connections=(\d+)/.exec(text)
  return m ? Number(m[1]) : 100 // the Postgres default
}

function plan(doc: ComposeDoc, role: PlanRole, split: boolean, vars: Record<string, string>) {
  return planPools(planInputFromEnv(poolEnv(doc, role, vars), role, split, DEFAULT_KERNEL_NEED))
}

/** What keeps the rolling topology from fitting, one line each; empty = it fits. */
function budgetProblems(doc: ComposeDoc, vars: Record<string, string> = {}): string[] {
  const problems: string[] = []
  for (const service of ["api", "worker"]) {
    const env = doc.services[service]?.environment ?? {}
    if (env.DB_CELL_MAX_CONNECTIONS === undefined) {
      problems.push(`${service}: no DB_CELL_MAX_CONNECTIONS, so its pools are not planned`)
    }
    for (const key of POOL_KEYS) {
      if (interpolate(env[key], {}) !== "") {
        problems.push(`${service}: ${key} defaults to ${interpolate(env[key], {})}, over the plan`)
      }
    }
  }
  const limit = maxConnections(doc, vars)
  for (const split of [true, false]) {
    for (const role of ["api", "worker"] as const) {
      const p: PoolPlan = plan(doc, role, split, vars)
      if (p.verdict !== "ok") {
        problems.push(
          `${role} (${split ? "split" : "one"} login): ${p.verdict}, steady ${p.steady}, ` +
            `overlap ${p.overlap}, available ${p.available}`,
        )
      }
      if (p.overlap + MIGRATE_FOOTPRINT + DEFAULT_CELL_RESERVED > limit) {
        problems.push(
          `${role}: overlap ${p.overlap} + migrate + reserved over max_connections ${limit}`,
        )
      }
    }
  }
  return problems
}

describe("rolling deploy DB connection budget", () => {
  it("plans api and worker to fit old + new releases, migrate and the reserve in max_connections", () => {
    expect(budgetProblems(COMPOSE)).toEqual([])
    const api = plan(COMPOSE, "api", true, {})
    const worker = plan(COMPOSE, "worker", true, {})
    // One topology: both roles see the same numbers.
    expect(api.steady).toBe(worker.steady)
    expect(api.overlap).toBeLessThanOrEqual(api.available)
    expect(api.available).toBe(
      maxConnections(COMPOSE, {}) - DEFAULT_CELL_RESERVED - MIGRATE_FOOTPRINT,
    )
  })

  it("keeps migrate a fixed one-shot inside its footprint", () => {
    const env = COMPOSE.services.migrate?.environment ?? {}
    expect(String(env.LIAISON_ONESHOT)).toBe("1")
    const p = planPools(
      planInputFromEnv(poolEnv(COMPOSE, "migrate", {}), "oneshot", true, DEFAULT_KERNEL_NEED),
    )
    expect(p.perProcess).toBeLessThan(MIGRATE_FOOTPRINT)
  })

  it("API_REPLICAS=4 in .env: one release fits, two side by side only warn", () => {
    const vars = { API_REPLICAS: "4" }
    const p = plan(COMPOSE, "api", true, vars)
    expect(p.verdict).toBe("warn")
    expect(p.steady).toBeLessThanOrEqual(p.available)
    expect(p.overlap).toBeGreaterThan(p.available)
    expect(budgetProblems(COMPOSE, vars).join("\n")).toContain(
      `api (split login): warn, steady ${p.steady}, overlap ${p.overlap}, available ${p.available}`,
    )
  })

  it("fails a service whose compose entry hard-codes a pool size", () => {
    const doc = structuredClone(COMPOSE)
    const api = doc.services.api
    if (!api?.environment) throw new Error("no api service")
    api.environment.DB_PRIVILEGED_POOL_MAX = ["$", "{API_DB_PRIVILEGED_POOL_MAX:-60}"].join("")
    expect(budgetProblems(doc)).toContain(
      "api: DB_PRIVILEGED_POOL_MAX defaults to 60, over the plan",
    )
  })
})
