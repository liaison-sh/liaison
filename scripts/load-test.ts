#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `bun run load-test [--target release|local]`
//
// Boots the release image (or assumes a locally-running dev server when
// --target=local), seeds the canonical workload, runs each k6 script in
// sequence, parses JSON summaries, prints measured-vs-threshold table, and
// exits non-zero on any failing threshold.
//
// `bun run load-test --deploys N --box <url> ...` and `bun run load-test
// --launch --box <url> ...` run a box's load orgs instead: deploys under load
// and the launch scenario (scripts/lib/deploy-under-load.ts, `--help`).

import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { $ } from "bun"
import { loadSeedCommand, parseLoadSeedResult } from "./lib/load-seed"

function loadDeployEnv(envPath: string): void {
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim()
    if (!t || t.startsWith("#")) continue
    const eq = t.indexOf("=")
    if (eq <= 0) continue
    const k = t.slice(0, eq).trim()
    let v = t.slice(eq + 1)
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    process.env[k] = v
  }
}

interface Args {
  target: "release" | "local"
  host: string
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const target = (
    argv.includes("--target") ? argv[argv.indexOf("--target") + 1] : "local"
  ) as Args["target"]
  if (target !== "release" && target !== "local") {
    console.error(`unknown --target: ${target}`)
    process.exit(2)
  }
  const defaultHost = `http://localhost:${process.env.APP_PORT || "3000"}`
  const host = process.env.HOST || defaultHost
  return { target, host }
}

const ROOT = resolve(new URL("..", import.meta.url).pathname)
loadDeployEnv(process.env.LIAISON_ENV_FILE ?? join(ROOT, "deploy/.env"))
const LOAD_DIR = join(ROOT, "qa/load")
const OUT_DIR = join(LOAD_DIR, "out")

const SCRIPTS = [
  { id: "a2", file: "a2-ws-delivery.js" },
  { id: "a3", file: "a3-agent-first-token.js" },
  { id: "a4", file: "a4-attention-feed.js" },
  { id: "a5", file: "a5-search.js" },
  { id: "a6", file: "a6-thread-list.js" },
  { id: "a7", file: "a7-mixed.js" },
  { id: "a8", file: "a8-channel-agent-fanout.js" },
]

/**
 * Scenarios that need a route mounted only by ENABLE_LOAD_TEST_ENDPOINT. The
 * release image runs NODE_ENV=production, where that flag stops the process at
 * boot (apps/api/src/lib/env.ts), so they run against a local dev server only.
 */
const LOCAL_ONLY: Record<string, string> = {
  a2: "needs /api/__loadtest/ws-emit, mounted only by ENABLE_LOAD_TEST_ENDPOINT (refused in production)",
}

async function waitForHealth(host: string, timeoutMs = 180_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const p = Bun.spawnSync(["curl", "-fsS", `${host}/healthz`])
    if (p.exitCode === 0) return
    await Bun.sleep(2000)
  }
  throw new Error(`/healthz did not return 200 within ${timeoutMs}ms`)
}

// Spec V6 + canonical load execution profile require the load test to run
// against the release image, not whatever is pinned in deploy/docker-compose.yml.
// LIAISON_IMAGE is consumed by deploy/docker-compose.yml `image:
// ${LIAISON_IMAGE:-ghcr.io/liaison-sh/liaison:v0.1.0}` so this run targets the
// just-built image instead of the published tag.
const LOAD_IMAGE_TAG = "liaison-load:tmp"

async function bootRelease(): Promise<void> {
  console.log(`→ building release image (${LOAD_IMAGE_TAG})…`)
  await $`docker buildx build -t ${LOAD_IMAGE_TAG} --load -f apps/api/Dockerfile .`.cwd(ROOT)
  console.log("→ starting deploy/docker-compose.yml against the built image…")
  const envFile = process.env.LIAISON_ENV_FILE ?? join(ROOT, "deploy/.env")
  const up = Bun.spawnSync({
    cmd: [
      "docker",
      "compose",
      "--env-file",
      envFile,
      "-f",
      "deploy/docker-compose.yml",
      "-f",
      "deploy/docker-compose.loadtest.yml",
      "up",
      "-d",
    ],
    cwd: ROOT,
    env: { ...process.env, LIAISON_IMAGE: LOAD_IMAGE_TAG },
    stdout: "inherit",
    stderr: "inherit",
  })
  if (up.exitCode !== 0) throw new Error("docker compose up -d failed")
}

async function tearDownRelease(): Promise<void> {
  const envFile = process.env.LIAISON_ENV_FILE ?? join(ROOT, "deploy/.env")
  Bun.spawnSync({
    cmd: [
      "docker",
      "compose",
      "--env-file",
      envFile,
      "-f",
      "deploy/docker-compose.yml",
      "-f",
      "deploy/docker-compose.loadtest.yml",
      "down",
      "-v",
    ],
    cwd: ROOT,
    env: { ...process.env, LIAISON_IMAGE: LOAD_IMAGE_TAG },
    stdout: "inherit",
    stderr: "inherit",
  })
}

async function seedWorkload(target: Args["target"], host: string): Promise<void> {
  // Spec V6 (canonical load execution profile) requires deterministic seed
  // data: A4 needs attention items, A5 10k indexed entities, A6 1k+ threads,
  // A7 stacks them. The load tier writes one demo org with the bulk volume,
  // checks that its founder reads every row back and re-indexes its search;
  // a failed seed fails the run rather than measuring an empty org.
  console.log("→ seeding the load org (liaison seed --tier load --volume)…")
  process.env.LOAD_PASSWORD ||= "QaPass1!"
  const envFile = process.env.LIAISON_ENV_FILE ?? join(ROOT, "deploy/.env")
  const seed = Bun.spawnSync({
    cmd: loadSeedCommand(target, envFile),
    cwd: target === "local" ? join(ROOT, "apps/api") : ROOT,
    env: { ...process.env, LIAISON_IMAGE: LOAD_IMAGE_TAG },
    stdout: "pipe",
    stderr: "inherit",
  })
  const out = seed.stdout.toString()
  process.stdout.write(out)
  if (seed.exitCode !== 0)
    throw new Error(`liaison seed --tier load failed (exit ${seed.exitCode})`)
  const [org] = parseLoadSeedResult(out)
  if (!org) throw new Error("the load seed returned no org")
  process.env.LOAD_EMAIL = org.adminEmail
  console.log(`→ load org ${org.slug}: k6 signs in as ${org.adminEmail}`)

  // The org-settings table defaults `rateLimitPerMinute` to 100 and the public
  // settings route caps it at 10_000 (Zod). Either value makes 50-VU k6
  // measurements impossible — every request after the first few hundred
  // returns 429. Clear the Redis overrides (orgRateLimiter is no-op without
  // them) and flush any stale IP-bucket counters from prior runs. The
  // RATE_LIMIT_DEFAULT=1e9 env in docker-compose.loadtest.yml handles the
  // global limiter, but the per-org override is independent.
  console.log("→ clearing Redis rate-limit overrides + stale buckets…")
  await clearRateLimiterState()

  // The release image runs `runPhase10Boot` BEFORE any org exists in the
  // freshly-migrated DB (the load org is created later by the seed). detectDrift
  // therefore unions an empty set of dimension fields, and the Meili index
  // ends up without `team`/`sensitivity` filterable. Once knowledge ships
  // search filters that reference those attributes, every `/api/search`
  // returns 503 — but only on `--target=release` where seed runs after
  // boot. Re-sync the index settings now that the seed has registered apps.
  console.log("→ resyncing Meili filterable attributes (post-seed drift)…")
  await resyncMeiliFilterableAttributes()

  // A3 (agent first-token) and A7 (mixed writes) need a writable thread that
  // the load-test user actually participates in. The QA seed doesn't expose a
  // canonical "load" thread, so create one here and export its id into the
  // parent env — runK6 forwards the values to each k6 invocation. Cheap
  // enough to do on every run; idempotent because the thread title is
  // deterministic and the API accepts dupes.
  console.log("→ provisioning load-test thread for A3/A7…")
  await provisionLoadTestThread(host)
}

async function provisionLoadTestThread(host: string): Promise<void> {
  const email = process.env.LOAD_EMAIL ?? ""
  const password = process.env.LOAD_PASSWORD || "QaPass1!"
  const loginRes = await fetch(`${host}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  })
  if (!loginRes.ok) {
    console.warn(`! load-test thread: login failed (${loginRes.status}) — A3/A7 will skip`)
    return
  }
  const loginBody = (await loginRes.json()) as { data?: { accessToken?: string } }
  const token = loginBody.data?.accessToken
  if (!token) {
    console.warn("! load-test thread: no access token in login response — A3/A7 will skip")
    return
  }
  // createThreadSchema requires participantIds[≥1]. Easiest: reuse any
  // existing thread the load-test user already participates in. seed-qa
  // creates 10 named threads with QA users as participants, so /api/threads
  // returns plenty before A3/A7 ever run.
  const list = await fetch(`${host}/api/threads?limit=1`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!list.ok) {
    console.warn(`! load-test thread: list returned ${list.status} — A3/A7 will skip`)
    return
  }
  const body = (await list.json()) as { data?: Array<{ id: string }> }
  const threadId = body.data?.[0]?.id
  if (!threadId) {
    console.warn("! load-test thread: no existing threads to reuse — A3/A7 will skip")
    return
  }
  process.env.LOAD_AGENT_THREAD_ID = threadId
  process.env.LOAD_WRITE_THREAD_ID = threadId
  console.log(`→ load-test thread ready: ${threadId}`)
}

async function resyncMeiliFilterableAttributes(): Promise<void> {
  const key = process.env.MEILISEARCH_MASTER_KEY
  if (!key) {
    console.warn("! MEILISEARCH_MASTER_KEY missing — skipping Meili resync")
    return
  }
  // Static set from apps/api/src/modules/search/drift.ts + dimension fields
  // contributed by registered apps. Knowledge is the only manifest that adds
  // dimensions (team/sensitivity) in the current build; if more land, extend
  // this list to match. Mismatch surfaces as a 400 "Attribute X is not
  // filterable" — easy to catch in the next load run.
  const filterable = [
    "org_id",
    "app",
    "entity_type",
    "entity_id",
    "read_scope",
    "participant_ids",
    "is_mentionable",
    "team",
    "sensitivity",
  ]
  const body = JSON.stringify({ filterableAttributes: filterable })
  const r = Bun.spawnSync({
    cmd: [
      "docker",
      "exec",
      "liaison-meilisearch-1",
      "curl",
      "-sS",
      "-X",
      "PATCH",
      "-H",
      `Authorization: Bearer ${key}`,
      "-H",
      "Content-Type: application/json",
      "--data-raw",
      body,
      "http://localhost:7700/indexes/liaison_search/settings",
    ],
    stdout: "pipe",
    stderr: "inherit",
  })
  if (r.exitCode !== 0) {
    console.warn("! meili resync curl failed — search may return 503")
  }
}

async function clearRateLimiterState(): Promise<void> {
  // Use redis-cli inside the compose redis container — avoids adding ioredis
  // to the script's own deps and bypasses host-side connectivity questions.
  // SCAN avoids KEYS' blocking behavior on large keyspaces.
  const cmd = `for p in 'ratelimit:config:limit:*' 'ratelimit:*:60'; do redis-cli --scan --pattern "$p" | xargs -r redis-cli DEL >/dev/null; done`
  const r = Bun.spawnSync({
    cmd: ["docker", "exec", "liaison-redis-1", "sh", "-c", cmd],
    stdout: "inherit",
    stderr: "inherit",
  })
  if (r.exitCode !== 0) {
    console.warn("! rate-limit clear returned non-zero — k6 may hit 429 if overrides persist")
  }
}

interface SummaryRow {
  id: string
  passed: boolean
  thresholds: { metric: string; ok: boolean; measured: string; threshold: string }[]
}

async function runK6(scriptId: string, file: string, host: string): Promise<SummaryRow> {
  const summaryPath = join(OUT_DIR, `${scriptId}.json`)
  console.log(`→ running k6 ${scriptId} (${file})`)

  // A7 only: sample app-container CPU% over the measured window. The spec
  // requires "app CPU < 80% sustained" with sustained = no three consecutive
  // 10-second windows averaging > 80%. We sample every 5s and bucket into
  // 10s windows in the summary check below.
  const cpuSamples: number[] = []
  let stopCpu: (() => void) | undefined
  if (scriptId === "a7") {
    stopCpu = startCpuSampler(cpuSamples)
  }

  const k6Env: string[] = [
    "-e",
    `HOST=${host}`,
    "-e",
    `LOAD_EMAIL=${process.env.LOAD_EMAIL ?? ""}`,
    "-e",
    `LOAD_PASSWORD=${process.env.LOAD_PASSWORD || "QaPass1!"}`,
  ]
  if (process.env.LOAD_AGENT_THREAD_ID) {
    k6Env.push("-e", `LOAD_AGENT_THREAD_ID=${process.env.LOAD_AGENT_THREAD_ID}`)
  }
  if (process.env.LOAD_WRITE_THREAD_ID) {
    k6Env.push("-e", `LOAD_WRITE_THREAD_ID=${process.env.LOAD_WRITE_THREAD_ID}`)
  }
  // A8 fans out on a seeded Home channel whose members are mostly agents; its
  // setup() fails loudly without the thread id rather than measuring nothing.
  if (process.env.LOAD_CHANNEL_THREAD_ID) {
    k6Env.push("-e", `LOAD_CHANNEL_THREAD_ID=${process.env.LOAD_CHANNEL_THREAD_ID}`)
  }
  const proc = Bun.spawn(
    ["k6", "run", "--quiet", `--summary-export=${summaryPath}`, ...k6Env, join(LOAD_DIR, file)],
    { stdout: "inherit", stderr: "inherit" },
  )
  const code = await proc.exited
  if (stopCpu) stopCpu()
  const summary = parseSummary(summaryPath)
  let cpuOk = true
  if (scriptId === "a7" && cpuSamples.length > 0) {
    cpuOk = cpuPassesSustainedThreshold(cpuSamples, 80)
    summary.push({
      metric: "app_cpu_percent",
      threshold: "no_3x10s_window_avg>80",
      ok: cpuOk,
      measured: `samples=${cpuSamples.length}, max=${Math.max(...cpuSamples).toFixed(1)}%`,
    })
  }
  return {
    id: scriptId,
    passed: code === 0 && summary.every((t) => t.ok) && cpuOk,
    thresholds: summary,
  }
}

function startCpuSampler(out: number[]): () => void {
  let stopped = false
  const tick = async () => {
    while (!stopped) {
      try {
        const p = Bun.spawn(
          ["docker", "stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}"],
          { stdout: "pipe", stderr: "ignore" },
        )
        await p.exited
        const txt = await new Response(p.stdout).text()
        for (const line of txt.split("\n")) {
          const [name, cpu] = line.split("\t")
          if (name && /liaison.*app|app.*liaison/i.test(name) && cpu) {
            const n = Number.parseFloat(cpu.replace("%", ""))
            if (Number.isFinite(n)) out.push(n)
          }
        }
      } catch {}
      if (!stopped) await Bun.sleep(5000)
    }
  }
  void tick()
  return () => {
    stopped = true
  }
}

// Sustained = no three consecutive 10s windows averaging above threshold.
// Samples arrive ~every 5s, so two samples per window.
function cpuPassesSustainedThreshold(samples: number[], threshold: number): boolean {
  const windows: number[] = []
  for (let i = 0; i < samples.length; i += 2) {
    const slice = samples.slice(i, i + 2)
    if (slice.length === 0) continue
    windows.push(slice.reduce((a, b) => a + b, 0) / slice.length)
  }
  for (let i = 0; i + 3 <= windows.length; i++) {
    const avg = (windows[i] + windows[i + 1] + windows[i + 2]) / 3
    if (avg > threshold) return false
  }
  return true
}

function parseSummary(path: string): SummaryRow["thresholds"] {
  if (!existsSync(path)) return []
  const json = JSON.parse(readFileSync(path, "utf8"))
  // k6's summary-export thresholds field is one of two shapes:
  //   - old (k6 < 0.50): `{ "p(95)<100": false }` where the bool means
  //     "the threshold was crossed during the run" (so `false` = passed)
  //   - new: `{ "p(95)<100": { ok: true, ... } }`
  // The runner used to assume the new shape and treat the bare bool as
  // truthy on `.ok` → every threshold reported false (k6 v2.0.0 uses the
  // bare-bool shape and the load-test always marked passing thresholds as
  // failed). Normalize to a single "passed" boolean per threshold.
  const metrics = json.metrics as Record<
    string,
    { thresholds?: Record<string, boolean | { ok?: boolean }> }
  >
  const rows: SummaryRow["thresholds"] = []
  for (const [metricName, m] of Object.entries(metrics)) {
    if (!m.thresholds) continue
    for (const [tName, t] of Object.entries(m.thresholds)) {
      const passed = typeof t === "boolean" ? !t : t.ok === true
      rows.push({ metric: metricName, ok: passed, measured: "see report", threshold: tName })
    }
  }
  return rows
}

async function main() {
  const { target, host } = parseArgs()
  mkdirSync(OUT_DIR, { recursive: true })

  try {
    if (target === "release") {
      await bootRelease()
      await waitForHealth(host)
    } else {
      await waitForHealth(host, 5_000).catch(() => {
        console.warn(
          `! ${host}/healthz unreachable — make sure dev server is up before --target=local`,
        )
      })
    }
    await seedWorkload(target, host)

    const results: SummaryRow[] = []
    const scripts = SCRIPTS.filter((s) => {
      const reason = target === "release" ? LOCAL_ONLY[s.id] : undefined
      if (reason) console.log(`→ skipping ${s.id} on --target release: ${reason}`)
      return !reason
    })
    for (let i = 0; i < scripts.length; i++) {
      const s = scripts[i]
      results.push(await runK6(s.id, s.file, host))
      // macOS' TIME_WAIT is 15s and load tests open thousands of short-lived
      // sockets; back-to-back scripts otherwise fail with EADDRNOTAVAIL on
      // ephemeral port exhaustion. 20s drain is safe on every platform and
      // adds 2 minutes to the total 30+ minute run.
      if (i < scripts.length - 1) {
        console.log("→ cooling down 20s for TCP TIME_WAIT…")
        await Bun.sleep(20_000)
        // Flush IP-bucket entries again so the next script doesn't inherit
        // the previous script's request count (60s sliding window means a
        // packed bucket from the prior run still rejects the next one).
        await clearRateLimiterState()
      }
    }

    console.log("\n=== Load-test results ===")
    for (const r of results) {
      console.log(`${r.passed ? "✓" : "✗"} ${r.id}`)
      for (const t of r.thresholds) {
        console.log(`    ${t.ok ? "  ok" : "FAIL"}  ${t.metric}  ${t.threshold}`)
      }
    }
    const allOk = results.every((r) => r.passed)
    if (!allOk) process.exit(1)
  } finally {
    if (target === "release") await tearDownRelease()
  }
}

const argv = process.argv.slice(2)
if (
  argv.includes("--deploys") ||
  argv.includes("--launch") ||
  argv.some((a) => a.startsWith("--deploys="))
) {
  const { runDeployUnderLoad } = await import("./lib/deploy-under-load")
  process.exit(await runDeployUnderLoad(argv))
} else {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
