#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `bun run validate-compose [--tag vX.Y.Z]`
//
// Drives deploy/docker-compose.yml with a specified release tag, waits for
// /healthz, asserts version matches the tag and all dependencies are "ok".
// Tears the stack down on success or failure.

import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

// ---------------------------------------------------------------------------
// Static deploy-invariant assertions (run before Docker, also unit-tested).
// ---------------------------------------------------------------------------

/** The privileged bootstrap roles that BYPASS row-level security. The runtime
 * app connection must NEVER authenticate as one of these. */
const SUPERUSER_ROLES = new Set(["postgres", "liaison"])

interface ComposeShape {
  services?: Record<
    string,
    {
      environment?: Record<string, unknown> | string[]
      volumes?: string[]
    }
  >
}

/** Pull a `KEY: value` map out of a compose service `environment:`, accepting
 * both the mapping form and the `- KEY=value` list form. */
function readEnv(env: Record<string, unknown> | string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!env) return out
  if (Array.isArray(env)) {
    for (const entry of env) {
      const eq = entry.indexOf("=")
      if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1)
    }
  } else {
    for (const [k, v] of Object.entries(env)) out[k] = String(v)
  }
  return out
}

/** Extract the login role from a `postgres://role:secret@host/db` URL. Returns
 * null when the value is not a parseable postgres connection string. */
export function roleFromPgUrl(url: string | undefined): string | null {
  if (!url) return null
  const m = /^postgres(?:ql)?:\/\/([^:/@]+)(?::[^@]*)?@/.exec(url.trim())
  return m ? m[1] : null
}

/**
 * Assert the compose file keeps the runtime app role separate from the
 * privileged migration role, so row-level security is actually enforced for
 * request traffic:
 *
 *   - the app's runtime `DATABASE_URL` does NOT connect as a superuser/owner
 *     role (those bypass RLS); it must use the dedicated `liaison_app` role.
 *   - a separate privileged `MIGRATION_DATABASE_URL` exists for DDL.
 *   - the Postgres service mounts the role-bootstrap init hook so `liaison_app`
 *     is created with a login password before the app connects.
 */
export function assertComposeRoleSeparation(composeText: string): void {
  const doc = Bun.YAML.parse(composeText) as ComposeShape
  const app = doc.services?.app
  if (!app) throw new Error("compose: no `app` service found")

  const appEnv = readEnv(app.environment)
  const runtimeRole = roleFromPgUrl(appEnv.DATABASE_URL)
  if (!runtimeRole) {
    throw new Error("compose: app service has no parseable DATABASE_URL")
  }
  if (SUPERUSER_ROLES.has(runtimeRole)) {
    throw new Error(
      `compose: app DATABASE_URL connects as privileged role "${runtimeRole}" — ` +
        "the runtime connection must use the non-superuser, RLS-subject liaison_app role",
    )
  }
  if (runtimeRole !== "liaison_app") {
    throw new Error(`compose: app DATABASE_URL connects as "${runtimeRole}", expected liaison_app`)
  }

  const migrationRole = roleFromPgUrl(appEnv.MIGRATION_DATABASE_URL)
  if (!migrationRole) {
    throw new Error(
      "compose: app service must set a separate MIGRATION_DATABASE_URL for privileged DDL",
    )
  }
  if (migrationRole === runtimeRole) {
    throw new Error(
      "compose: MIGRATION_DATABASE_URL must use a privileged role distinct from the runtime app role",
    )
  }

  const pg = doc.services?.postgres
  const mountsInit = (pg?.volumes ?? []).some((v) => v.includes(":/docker-entrypoint-initdb.d"))
  if (!mountsInit) {
    throw new Error(
      "compose: postgres service must mount ./postgres-init into /docker-entrypoint-initdb.d " +
        "so the liaison_app login role is provisioned at cluster init",
    )
  }
}

// Load deploy/.env into process.env, overriding any prior values. Bun
// auto-loads the repo's root .env at startup, but that file holds dev
// defaults (BASE_URL=http://localhost:3000) — the production env validator
// rejects exactly that string in NODE_ENV=production. Loading deploy/.env
// last guarantees the container env compose substitutes is the deploy one.
function loadDeployEnv(envPath: string): void {
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim()
    if (!t || t.startsWith("#")) continue
    const eq = t.indexOf("=")
    if (eq <= 0) continue
    const k = t.slice(0, eq).trim()
    let v = t.slice(eq + 1)
    // Strip surrounding quotes
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    process.env[k] = v
  }
}

interface Args {
  tag: string
  port: number
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const tagIdx = argv.indexOf("--tag")
  let tag = tagIdx >= 0 ? argv[tagIdx + 1] : ""
  if (!tag) {
    const proc = Bun.spawnSync(["git", "describe", "--tags", "--abbrev=0"], { stdout: "pipe" })
    tag = proc.stdout.toString().trim()
    if (!tag) {
      console.error("no git tag found; pass --tag vX.Y.Z explicitly")
      process.exit(2)
    }
  }
  const port = Number(process.env.APP_PORT || "3000")
  return { tag, port }
}

const ROOT = resolve(new URL("..", import.meta.url).pathname)

loadDeployEnv(process.env.LIAISON_ENV_FILE ?? join(ROOT, "deploy/.env"))

async function waitForHealth(host: string, timeoutMs = 240_000): Promise<unknown> {
  const start = Date.now()
  let lastErr = "timeout"
  let attempts = 0
  while (Date.now() - start < timeoutMs) {
    attempts++
    // Use curl instead of Bun's fetch — Bun's fetch caches resolution state for
    // localhost in ways that don't notice the port becoming available mid-poll
    // (the same probe via curl works immediately when the port is bound).
    const proc = Bun.spawnSync(["curl", "-fsS", `${host}/healthz`])
    if (proc.exitCode === 0) {
      const body = proc.stdout.toString()
      console.log(
        `  /healthz green after ${Math.round((Date.now() - start) / 1000)}s (${attempts} attempts)`,
      )
      return JSON.parse(body)
    }
    lastErr = proc.stderr.toString().split("\n")[0] || `curl exit ${proc.exitCode}`
    if (attempts % 10 === 0) {
      console.log(
        `  …still waiting (${Math.round((Date.now() - start) / 1000)}s, last: ${lastErr})`,
      )
    }
    await Bun.sleep(2_000)
  }
  throw new Error(`/healthz did not return 200 within ${timeoutMs}ms (last error: ${lastErr})`)
}

async function main() {
  const { tag, port } = parseArgs()
  // The compose `image:` line is `${LIAISON_IMAGE:-…:v0.1.0}`, so the tag is
  // selected by the LIAISON_IMAGE env var — not by rewriting the file (the old
  // regex never matched the `${…}` form and silently booted v0.1.0). Drive the
  // tag through env, exactly like load-test.ts / lighthouse-ci.ts already do.
  const image = `ghcr.io/liaison-sh/liaison:${tag}`
  const composePath = join(ROOT, "deploy/docker-compose.yml")

  // Static deploy invariant: fail fast (before touching Docker) if the runtime
  // app role has been pointed at a superuser, which would silently disable RLS.
  assertComposeRoleSeparation(readFileSync(composePath, "utf8"))
  console.log(
    "✓ app DATABASE_URL uses the non-superuser liaison_app role; migrations stay privileged",
  )

  const envFile = process.env.LIAISON_ENV_FILE ?? join(ROOT, "deploy/.env")
  console.log(`→ validating compose with image ${image} on port ${port} (env=${envFile})`)
  console.log(`  process.env BASE_URL=${process.env.BASE_URL} APP_PORT=${process.env.APP_PORT}`)
  const upProc = Bun.spawnSync({
    cmd: ["docker", "compose", "--env-file", envFile, "-f", composePath, "up", "-d"],
    cwd: ROOT,
    env: { ...process.env, LIAISON_IMAGE: image },
    stdout: "inherit",
    stderr: "inherit",
  })
  if (upProc.exitCode !== 0) {
    console.error("docker compose up -d failed")
    process.exit(1)
  }
  try {
    const body = (await waitForHealth(`http://127.0.0.1:${port}`)) as {
      version: string
      dependencies: Record<string, string>
    }
    console.log(`  /healthz responded; version=${body.version}`)
    const failures: string[] = []
    if (body.version !== tag) failures.push(`version mismatch: ${body.version} != ${tag}`)
    for (const [name, status] of Object.entries(body.dependencies ?? {})) {
      if (status !== "ok") failures.push(`dependency ${name} = ${status}`)
    }
    if (failures.length) {
      console.error("FAIL:")
      for (const f of failures) console.error(`  - ${f}`)
      process.exit(1)
    }
    console.log("✓ validate-compose: all checks passed")
  } finally {
    Bun.spawnSync({
      cmd: ["docker", "compose", "--env-file", envFile, "-f", composePath, "down", "-v"],
      cwd: ROOT,
      env: { ...process.env, LIAISON_IMAGE: image },
      stdout: "inherit",
      stderr: "inherit",
    })
  }
}

// Only drive the stack when run directly (`bun run validate-compose`). Importing
// this module — e.g. from validate-compose.test.ts to exercise the static
// assertions — must not boot Docker.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
