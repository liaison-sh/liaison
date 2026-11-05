#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Did a deploy only delay work? Counts, over a time window, the edge's 5xx
// answers, the agent turns that were cut, and the effects the ledger saw twice
// (scripts/lib/deploy-counters.ts). Prints a summary on stderr and the JSON
// report on stdout; exits 1 when any measured counter is not 0.
//
//   [DEPLOY_COUNTERS_DB_URL=<postgres URL>] bun scripts/deploy-counters.ts
//       --since <ISO> [--until <ISO>]
//       [--edge-log <caddy JSON access log>] [--app-log <app JSON log>]
//
// DEPLOY_COUNTERS_DB_URL is a privileged URL (it reads kernel.agent_turns): it
// is read from the environment, never the command line, so it stays out of
// `ps` and the shell history. Each source is optional; a counter whose source
// is not given is reported as not measured. A turn that failed counts as cut
// whatever the cause, a model error included: measure under the load test's
// scripted model, where a turn fails only when a process cut it. A load org's
// turn (the load harness) must also have stored its script's exact reply. `--app-log -` reads the app log from stdin, e.g.
//   docker logs --since 30m <container> 2>&1 | bun scripts/deploy-counters.ts --since ... --app-log -
import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import postgres from "postgres"
import {
  cutTurnsWithLoadReplies,
  edge5xxMeasured,
  effectDuplicatesMeasured,
  readTurns,
  report,
} from "./lib/deploy-counters"

const { values } = parseArgs({
  options: {
    since: { type: "string" },
    until: { type: "string" },
    "edge-log": { type: "string" },
    "app-log": { type: "string" },
  },
})

function fail(msg: string): never {
  process.stderr.write(`deploy-counters: ${msg}\n`)
  process.exit(2)
}

const start = values.since ? Date.parse(values.since) : Number.NaN
if (Number.isNaN(start)) fail("--since <ISO time> is required")
const end = values.until ? Date.parse(values.until) : Date.now()
if (Number.isNaN(end)) fail("--until is not a time")
const window = { start, end }

const lines = (path: string): string[] =>
  (path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8")).split("\n")

const edgeLog = values["edge-log"]
const appLog = values["app-log"]
const dbUrl = process.env.DEPLOY_COUNTERS_DB_URL

let turns: ReturnType<typeof cutTurnsWithLoadReplies> | undefined
if (dbUrl) {
  const sql = postgres(dbUrl, { max: 1 })
  try {
    turns = cutTurnsWithLoadReplies(await readTurns(sql, window), Date.now())
  } finally {
    await sql.end()
  }
}

const edge = edgeLog ? edge5xxMeasured(lines(edgeLog), window) : undefined
const dupes = appLog ? effectDuplicatesMeasured(lines(appLog), window) : undefined
// A log that was asked for and read nothing in the window is not a clean 0.
if (edge === null) fail("--edge-log: no access-log line with a status inside the window")
if (dupes === null) fail("--app-log: no JSON log line with a time inside the window")
const out = report(window, { edge5xx: edge, effectDuplicates: dupes, cutTurns: turns })
process.stderr.write(`${out.summary}\n`)
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
process.exit(out.ok ? 0 : 1)
