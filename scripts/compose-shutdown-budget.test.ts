// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Docker SIGKILLs a container stop_grace_period after its SIGTERM. The app's
// shutdown sequence (apps/api/src/lib/shutdown.ts) must end before that: its
// hard deadline sits at least 5 s under the grace period, and the hard deadline
// itself leaves room for the edge grace, the longest drain and the closing
// phases, or a drain is cut short and its approvals or jobs are lost.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  requiredHardDeadlineMs,
  SHUTDOWN_BUDGET_DEFAULTS,
} from "../apps/api/src/lib/shutdown-budget"

const ROOT = path.resolve(import.meta.dir, "..")
const KILL_MARGIN_MS = 5_000

interface ComposeService {
  stop_grace_period?: string
  profiles?: string[]
  environment?: Record<string, string | number>
}

/** The services of a compose file, YAML merge keys (`<<: *liaison-app`) resolved. */
function services(file: string): Record<string, ComposeService> {
  const doc = Bun.YAML.parse(readFileSync(path.join(ROOT, file), "utf8")) as {
    services?: Record<string, ComposeService>
  }
  return doc.services ?? {}
}

function durationMs(value: string): number {
  const m = /^(\d+)(ms|s|m)$/.exec(value.trim())
  if (!m) throw new Error(`unparsed duration ${value}`)
  const n = Number(m[1])
  return m[2] === "ms" ? n : m[2] === "s" ? n * 1_000 : n * 60_000
}

function envMs(service: ComposeService, key: string): number | undefined {
  const v = service.environment?.[key]
  if (v === undefined) return undefined
  if (!/^\d+$/.test(String(v))) throw new Error(`${key} is not a number of ms: ${v}`)
  return Number(v)
}

function assertBudget(name: string, service: ComposeService | undefined): number {
  expect(service, `service ${name}`).toBeDefined()
  const s = service ?? {}
  const grace = s.stop_grace_period
  expect(grace, `${name} stop_grace_period`).toBeDefined()
  const budgets = {
    edgeGraceMs: envMs(s, "SHUTDOWN_EDGE_GRACE_MS") ?? SHUTDOWN_BUDGET_DEFAULTS.edgeGraceMs,
    httpDrainMs: envMs(s, "SHUTDOWN_HTTP_DRAIN_MS") ?? SHUTDOWN_BUDGET_DEFAULTS.httpDrainMs,
    turnDrainMs: envMs(s, "SHUTDOWN_TURN_DRAIN_MS") ?? SHUTDOWN_BUDGET_DEFAULTS.turnDrainMs,
    jobDrainMs: envMs(s, "SHUTDOWN_JOB_DRAIN_MS") ?? SHUTDOWN_BUDGET_DEFAULTS.jobDrainMs,
    turnSettleMs: envMs(s, "SHUTDOWN_TURN_SETTLE_MS") ?? SHUTDOWN_BUDGET_DEFAULTS.turnSettleMs,
  }
  const needed = requiredHardDeadlineMs(budgets)
  const hard = envMs(s, "SHUTDOWN_HARD_DEADLINE_MS") ?? needed
  expect(hard, `${name} hard deadline`).toBeGreaterThanOrEqual(needed)
  expect(durationMs(grace ?? ""), `${name} stop_grace_period`).toBeGreaterThanOrEqual(
    hard + KILL_MARGIN_MS,
  )
  return hard
}

describe("compose shutdown budget", () => {
  const svc = services("deploy/docker-compose.yml")

  it("stop_grace_period ≥ hard deadline + 5 s ≥ what the drains and closing phases need", () => {
    assertBudget("app", svc.app)
  })

  it("the defaults need 58 s, so a 65 s grace period covers an install that sets no SHUTDOWN_*", () => {
    // docs/self-hosting/docker.md and docs/reference/env cite these numbers.
    expect(SHUTDOWN_BUDGET_DEFAULTS).toMatchObject({
      httpDrainMs: 20_000,
      turnDrainMs: 20_000,
      jobDrainMs: 20_000,
    })
    expect(requiredHardDeadlineMs(SHUTDOWN_BUDGET_DEFAULTS)).toBe(58_000)
    expect(svc.app ? envMs(svc.app, "SHUTDOWN_HARD_DEADLINE_MS") : undefined).toBe(
      requiredHardDeadlineMs(SHUTDOWN_BUDGET_DEFAULTS),
    )
  })

  it("the rolling api and worker drain turns and jobs for 10 min, inside an 11 min grace period", () => {
    for (const name of ["api", "worker"]) {
      const s = svc[name]
      expect(s?.profiles, name).toEqual(["rolling"])
      expect(s && envMs(s, "SHUTDOWN_TURN_DRAIN_MS"), name).toBe(600_000)
      expect(s && envMs(s, "SHUTDOWN_JOB_DRAIN_MS"), name).toBe(600_000)
      // 605 s drain group (turn 600 s + 5 s handoff) + 28 s closing phases + 5 s slack.
      expect(assertBudget(name, s), name).toBe(638_000)
      expect(durationMs(s?.stop_grace_period ?? ""), name).toBe(660_000)
    }
  })

  it("a rolling process keeps its listener (and idle keep-alive connections) open well past the edge's probes", () => {
    // Bun's listener stop closes idle keep-alive connections at once; the edge
    // probes /readyz every second (deploy/Caddyfile.rolling.example) and a
    // POST sent on a pooled connection that closes under it is not retried.
    const caddy = readFileSync(path.join(ROOT, "deploy/Caddyfile.rolling.example"), "utf8")
    const probe = /health_interval (\d+)s/.exec(caddy)
    expect(probe).not.toBeNull()
    for (const name of ["api", "worker"]) {
      const s = svc[name]
      expect(s && envMs(s, "SHUTDOWN_EDGE_GRACE_MS"), name).toBeGreaterThanOrEqual(
        4 * Number(probe?.[1]) * 1_000,
      )
    }
  })

  it("the edges retry only a request that never reached a process (no GET is sent twice)", () => {
    // Caddy resends a GET whose connection broke after it was sent by default
    // (lb_retry_match); a one-time link would then be consumed twice. A
    // matcher that matches nothing leaves only dial failures retried, which
    // hold every method (measured against caddy:2, docs/self-hosting/docker.md).
    for (const file of ["deploy/Caddyfile.rolling.example", "deploy/Caddyfile.loadtest"]) {
      const caddy = readFileSync(path.join(ROOT, file), "utf8")
      expect(caddy, file).toMatch(/lb_retry_match \{\s*expression `false`\s*\}/)
      expect(caddy, file).toContain("lb_try_duration 60s")
    }
  })

  it("rolling-deploy.sh stops an old process with a timeout that covers its grace period", () => {
    const script = readFileSync(path.join(ROOT, "deploy/rolling-deploy.sh"), "utf8")
    const m = /^DRAIN_TIMEOUT_S="\$\{DRAIN_TIMEOUT_S:-(\d+)\}"$/m.exec(script)
    expect(m).not.toBeNull()
    for (const name of ["api", "worker"]) {
      expect(Number(m?.[1]) * 1_000).toBeGreaterThanOrEqual(
        durationMs(svc[name]?.stop_grace_period ?? ""),
      )
    }
  })
})
