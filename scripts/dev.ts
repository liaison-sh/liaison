// SPDX-License-Identifier: FSL-1.1-ALv2
import { setTimeout as sleep } from "node:timers/promises"
import { type Subprocess, spawn, spawnSync } from "bun"
import { bootstrap } from "./bootstrap-env"

interface ManagedProc {
  name: string
  tag: string
  proc: Subprocess
}

interface Service {
  name: string
  color: string
  cmd: string[]
  cwd: string
  /** Extra env merged over devEnv for this service only. */
  env?: Record<string, string>
}

const rootDir = `${import.meta.dir}/..`
const procs: ManagedProc[] = []
const reset = "\x1b[0m"
const dim = "\x1b[2m"
let shuttingDown = false

function prefix(name: string, color: string) {
  return `${dim}${color}[${name}]${reset} `
}

function pipeLogs(stream: ReadableStream<Uint8Array>, tag: string) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  async function read() {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop()!
      for (const line of lines) {
        if (line.length > 0) process.stdout.write(`${tag + line}\n`)
      }
    }
    if (buffer.length > 0) process.stdout.write(`${tag + buffer}\n`)
  }

  read().catch((err) => console.error(`${tag}log pipe failed`, err))
}

function parseEnvValue(raw: string): string {
  const value = raw.trim()
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

async function loadEnvFile(path: string): Promise<Record<string, string>> {
  try {
    const text = await Bun.file(path).text()
    const env: Record<string, string> = {}
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed
      const eq = withoutExport.indexOf("=")
      if (eq === -1) continue
      const key = withoutExport.slice(0, eq).trim()
      if (!key) continue
      env[key] = parseEnvValue(withoutExport.slice(eq + 1))
    }
    return env
  } catch {
    return {}
  }
}

const apiEnv = await loadEnvFile(`${rootDir}/.env`)
const devEnv: Record<string, string | undefined> = { ...apiEnv, ...process.env, FORCE_COLOR: "1" }
const qaMailTransport = (devEnv.QA_MAIL_TRANSPORT ?? "mailpit").toLowerCase()
if (qaMailTransport === "mailpit" && !devEnv.ALLOW_PRIVATE_MAIL_HOSTS) {
  devEnv.ALLOW_PRIVATE_MAIL_HOSTS = "true"
}
// Mount the QA/dev seed-harness routes (/api/_test/*) so the auto-seed and the
// qa/ browser harness can provision a second org + install bundled apps against
// `bun run dev`. Production can never reach this — lib/env.ts refuses to boot
// with the flag on in production. Opt out by exporting ENABLE_QA_SEED_ROUTES=0.
if (devEnv.ENABLE_QA_SEED_ROUTES === undefined) {
  devEnv.ENABLE_QA_SEED_ROUTES = "1"
}
// Runtime app installs (invoicing/shopify/3rd-party `.liaisonapp`, plus the
// `/api/_test/*/install` harness routes) write under getInstallRoot() =
// `LIAISON_APPS_DIR ?? /var/lib/liaison/apps`. The prod default is not writable on
// a dev machine — `mkdir` fails with EACCES, so EVERY runtime install 500s under
// `bun run dev` (breaking the invoicing/shopify/app-install QA scenarios' bootstrap
// and scenario 40 Flow C). Default it to a writable, gitignored repo-local dir in
// dev. Override by exporting LIAISON_APPS_DIR.
if (devEnv.LIAISON_APPS_DIR === undefined) {
  devEnv.LIAISON_APPS_DIR = `${rootDir}/.liaison-apps/apps`
}

async function stopProcess(managed: ManagedProc): Promise<void> {
  const { proc, tag } = managed
  proc.kill("SIGTERM")
  const exited = await Promise.race([proc.exited, sleep(2500).then(() => null)])
  if (exited === null) {
    console.log(`${tag}Still running after SIGTERM; sending SIGKILL`)
    proc.kill("SIGKILL")
    await proc.exited.catch(() => undefined)
  }
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  console.log("\n\x1b[2mShutting down...\x1b[0m")
  for (const proc of [...procs].reverse()) {
    await stopProcess(proc).catch((err) => console.error(`${proc.tag}Failed to stop`, err))
  }
  process.exit(exitCode)
}

process.on("SIGINT", () => {
  void shutdown(0)
})
process.on("SIGTERM", () => {
  void shutdown(0)
})

function commandExists(cmd: string): boolean {
  const result = spawnSync({ cmd: ["/bin/sh", "-lc", `command -v ${cmd}`], stdout: "ignore" })
  return result.exitCode === 0
}

function listeningPids(port: number): number[] {
  const result = spawnSync({
    cmd: ["lsof", `-tiTCP:${String(port)}`, "-sTCP:LISTEN"],
    stdout: "pipe",
    stderr: "ignore",
  })
  if (result.exitCode !== 0) return []
  return new TextDecoder()
    .decode(result.stdout)
    .split(/\s+/)
    .map((pid) => Number(pid))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

function commandForPid(pid: number): string {
  const result = spawnSync({
    cmd: ["ps", "-p", String(pid), "-o", "comm="],
    stdout: "pipe",
    stderr: "ignore",
  })
  if (result.exitCode !== 0) return ""
  return new TextDecoder().decode(result.stdout).trim()
}

async function recycleMailpitPorts(smtpPort: number, httpPort: number): Promise<void> {
  const pids = new Set([...listeningPids(smtpPort), ...listeningPids(httpPort)])
  for (const pid of pids) {
    const command = commandForPid(pid)
    if (!command.endsWith("mailpit")) {
      throw new Error(
        `Port ${smtpPort} or ${httpPort} is already used by pid ${pid} (${command || "unknown"})`,
      )
    }
    console.log(`${prefix("mailpit", "\x1b[32m")}Recycling existing Mailpit pid ${pid}`)
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
  }
  if (pids.size === 0) return
  for (let i = 0; i < 20; i++) {
    if (listeningPids(smtpPort).length === 0 && listeningPids(httpPort).length === 0) return
    await sleep(100)
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
}

async function autoSeed() {
  const serverUrl = "http://localhost:3000"
  // Wait for API server to be ready
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${serverUrl}/api/health`)
      if (res.ok) break
    } catch {}
    await sleep(500)
  }

  // Check if threads exist
  try {
    const { createDbClient } = await import("@liaison/test-helpers")
    const db = createDbClient("postgres://postgres:postgres@localhost:5432/liaison_dev")
    const [row] = await db.sql.unsafe(`SELECT count(*)::int AS c FROM kernel.threads`)
    await db.close()
    if (row.c > 0) {
      console.log(`\x1b[2m[seed]\x1b[0m ${row.c} threads exist, skipping auto-seed`)
      return
    }
  } catch {
    return // table doesn't exist or DB issue — skip silently
  }

  console.log(`\x1b[2m[seed]\x1b[0m No threads found, auto-seeding with default profile...`)
  const seed = spawn({
    cmd: ["bun", "run", "seed", "--yes"],
    cwd: rootDir,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...devEnv, SEED_SERVER_URL: serverUrl },
  })
  const managedSeed = { name: "seed", tag: prefix("seed", "\x1b[2m"), proc: seed }
  procs.push(managedSeed)
  await seed.exited
  const idx = procs.indexOf(managedSeed)
  if (idx !== -1) procs.splice(idx, 1)
}

// The setup step the image entrypoint runs before every server start: catalog
// reconcile, then the instance-wide derivations of the catalog (the files
// SELECT policy, the search settings). The server itself never writes them.
// Fail-soft, like the entrypoint's: a failure is logged and the server starts.
{
  const setup = spawn({
    cmd: ["bun", "src/db/reconcile-catalog-boot.ts"],
    cwd: "apps/api",
    stdout: "inherit",
    stderr: "inherit",
    env: devEnv,
  })
  await setup.exited
}

const services: Service[] = []
if (qaMailTransport === "mailpit") {
  if (!commandExists("mailpit")) {
    console.error("mailpit is required for QA mail. Install it with: brew install mailpit")
    process.exit(1)
  }
  const smtpPort = Number(devEnv.QA_MAIL_SMTP_PORT ?? 1025)
  const httpPort = Number(devEnv.QA_MAILPIT_HTTP_PORT ?? 8025)
  await recycleMailpitPorts(smtpPort, httpPort)
  services.push({
    name: "mailpit",
    color: "\x1b[32m",
    cmd: [
      "mailpit",
      "--smtp",
      `[::]:${smtpPort}`,
      "--listen",
      `[::]:${httpPort}`,
      "--smtp-auth-accept-any",
      "--smtp-auth-allow-insecure",
      "--quiet",
    ],
    cwd: ".",
  })
}

services.push(
  {
    name: "api",
    color: "\x1b[36m",
    cmd: ["bun", "--watch", "src/index.ts"],
    cwd: "apps/api",
    // The API runs QuickJS WASM in process: JSC's optimizing WASM tier off
    // (QUICKJS_HOST_JSC_ENV in apps/api/src/modules/apps/sandbox/pool.ts).
    env: { BUN_JSC_useOMGJIT: "0" },
  },
  { name: "web", color: "\x1b[35m", cmd: ["bun", "run", "dev"], cwd: "apps/web" },
  {
    name: "stripe",
    color: "\x1b[33m",
    cmd: ["stripe", "listen", "--forward-to", "localhost:3000/billing/stripe"],
    cwd: ".",
  },
)

// Bootstrap infra (Postgres, Redis, migrations) then start services
await bootstrap({ dbName: "liaison_dev" })

console.log()

for (const svc of services) {
  const tag = prefix(svc.name, svc.color)
  console.log(`${tag}Starting: ${svc.cmd.join(" ")}`)

  const proc = spawn({
    cmd: svc.cmd,
    cwd: svc.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...devEnv, ...svc.env },
  })

  procs.push({ name: svc.name, tag, proc })
  pipeLogs(proc.stdout, tag)
  pipeLogs(proc.stderr, tag)

  proc.exited.then((code) => {
    console.log(`${tag}Exited with code ${code}`)
    if (!shuttingDown && code !== 0 && code !== null) void shutdown(1)
  })
}

// Auto-seed if the database is empty (no threads)
autoSeed().catch((err) => {
  console.error(`\x1b[2m[seed]\x1b[0m Auto-seed failed`, err)
  void shutdown(1)
})
