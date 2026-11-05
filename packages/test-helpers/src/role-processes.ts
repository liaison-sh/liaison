// SPDX-License-Identifier: FSL-1.1-ALv2
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Subprocess } from "bun"
import { createDbClient, type DbClient } from "./db"
import { ensureTestInfra } from "./ensure-infra"
import { deterministicPorts } from "./port-allocator"
import { createRedisClient, type RedisClient } from "./redis"
import { resolveTestCoordinates, WORKER_PORT_STRIDE } from "./test-namespace"
import {
  API_DIR,
  buildServerSpawnEnv,
  DATABASE_URL,
  killPortHolders,
  REDIS_URL,
  serverBunFlags,
} from "./worker-env"

/** The process roles `LIAISON_ROLE` selects (apps/api/src/lib/process-role.ts). */
export type ProcessRole = "all" | "api" | "worker"

export interface RoleProcess {
  role: ProcessRole
  url: string
  port: number
  proc: Subprocess<"pipe", "pipe", "pipe">
  /** The env the process was spawned with (a copy). */
  env: Record<string, string>
  stdout(): string
  stderr(): string
  /** Resolve once `marker` appears in this process's stdout or stderr. */
  waitFor(marker: string | RegExp, timeoutMs?: number): Promise<void>
  kill(signal?: NodeJS.Signals | number): Promise<void>
}

export interface RoleCell {
  schemaPrefix: string
  redisPrefix: string
  /** The cell's Meilisearch index prefix (`MEILI_INDEX_PREFIX` of its processes). */
  meiliIndexPrefix: string
  db: DbClient
  redis: RedisClient
  processes: RoleProcess[]
  spawn(role: ProcessRole, env?: Record<string, string>): Promise<RoleProcess>
  /**
   * Run a one-shot `bun <script>` from the api dir over the cell's data (the
   * env a process gets, no role, no port), e.g. the setup step
   * `src/db/reconcile-catalog-boot.ts`. Resolves when it exits.
   */
  runOneShot(
    args: string[],
    env?: Record<string, string>,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>
  teardown(): Promise<void>
}

/** Logged by `createServer` (apps/api/src/lib/server.ts) for src/index.ts. */
const LISTENING_MARKER = " listening"
const READY_TIMEOUT_MS = 60_000
const KILL_GRACE_MS = 5_000

/**
 * One worker's data (schemas, Redis and Meili prefixes) with N real
 * `src/index.ts` processes over it, each with its own `LIAISON_ROLE` and port:
 * the shape of a multi-process deployment, for the role and failover scenarios.
 *
 * Worker ids and ports follow the own-server convention (`setupScenario`,
 * scripts/test-e2e-parallel.ts): the caller passes its private worker id and
 * the cell takes that worker's 10-port block, never a shared lane's. Every
 * process the cell ever spawns must fit in that block.
 */
export async function createRoleCell(
  workerId: number,
  roles: ProcessRole[],
  opts?: { serverEnv?: Record<string, string> },
): Promise<RoleCell> {
  if (roles.length > WORKER_PORT_STRIDE) {
    throw new Error(
      `createRoleCell: ${roles.length} processes do not fit the worker port stride (${WORKER_PORT_STRIDE})`,
    )
  }
  await ensureTestInfra()

  const coords = resolveTestCoordinates()
  const schemaPrefix = `w${workerId}_`
  const redisPrefix = coords.workerRedisPrefix(workerId)
  const meiliIndexPrefix = coords.workerMeiliPrefix(workerId)

  const db = createDbClient(DATABASE_URL)
  await db.cloneSchemas(workerId)
  await db.grantWorkerSchemas(workerId)
  const redis = createRedisClient(REDIS_URL)

  // The worker's whole block: the initial roles plus spares for `spawn()`.
  const ports = deterministicPorts(workerId, WORKER_PORT_STRIDE)
  await killPortHolders(ports)
  const appsInstallDir = mkdtempSync(path.join(tmpdir(), `liaison-w${workerId}-cell-apps-`))

  const processes: RoleProcess[] = []
  let nextPort = 0

  const spawn = async (role: ProcessRole, env?: Record<string, string>): Promise<RoleProcess> => {
    if (nextPort >= ports.length) {
      throw new Error(
        `createRoleCell: worker ${workerId} has used its port stride (${WORKER_PORT_STRIDE} processes)`,
      )
    }
    const port = ports[nextPort++]
    const spawnEnv: Record<string, string> = {
      ...buildServerSpawnEnv({ port, schemaPrefix, redisPrefix, meiliIndexPrefix, appsInstallDir }),
      ...opts?.serverEnv,
      ...env,
      LIAISON_ROLE: role,
      PORT: String(port),
    }
    const p = startProcess(role, port, spawnEnv)
    processes.push(p)
    try {
      await waitUntilReady(p)
    } catch (err) {
      await p.kill()
      throw err
    }
    return p
  }

  const teardown = async (): Promise<void> => {
    await Promise.all(processes.map((p) => p.kill()))
    await killPortHolders(ports)
    await db.dropWorkerSchemas(workerId)
    await db.close()
    await redis.flushKeys(redisPrefix)
    redis.close()
    rmSync(appsInstallDir, { recursive: true, force: true })
  }

  try {
    for (const role of roles) await spawn(role)
  } catch (err) {
    await teardown()
    throw err
  }

  const runOneShot = async (
    args: string[],
    env?: Record<string, string>,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    const base = buildServerSpawnEnv({
      port: ports[0] ?? 0,
      schemaPrefix,
      redisPrefix,
      meiliIndexPrefix,
      appsInstallDir,
    })
    delete base.PORT
    const proc = Bun.spawn({
      cmd: ["bun", ...serverBunFlags(process.env), ...args],
      cwd: API_DIR,
      env: { ...base, ...opts?.serverEnv, ...env },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { exitCode, stdout, stderr }
  }

  return {
    schemaPrefix,
    redisPrefix,
    meiliIndexPrefix,
    db,
    redis,
    processes,
    spawn,
    runOneShot,
    teardown,
  }
}

function startProcess(role: ProcessRole, port: number, env: Record<string, string>): RoleProcess {
  let stdout = ""
  let stderr = ""
  let waiters: Array<() => void> = []
  const wake = () => {
    const ws = waiters
    waiters = []
    for (const w of ws) w()
  }

  const proc = Bun.spawn({
    cmd: ["bun", ...serverBunFlags(process.env), "src/index.ts"],
    cwd: API_DIR,
    env: { ...env, LIAISON_EXIT_WHEN_ORPHANED: "1" },
    // The death pipe (see worker-env.ts spawnServer): the server exits when
    // this harness dies by any means, teardown or not.
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const read = async (stream: ReadableStream<Uint8Array>, target: "out" | "err") => {
    const decoder = new TextDecoder()
    try {
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true })
        if (target === "out") stdout += text
        else stderr += text
        wake()
      }
    } catch {
      /* stream closed */
    }
  }
  void read(proc.stdout, "out")
  void read(proc.stderr, "err")
  void proc.exited.then(wake)

  const seen = (marker: string | RegExp) =>
    typeof marker === "string"
      ? stdout.includes(marker) || stderr.includes(marker)
      : marker.test(stdout) || marker.test(stderr)

  const waitFor = async (marker: string | RegExp, timeoutMs = READY_TIMEOUT_MS): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (!seen(marker)) {
      if (proc.exitCode !== null) {
        throw new Error(
          `${role} process on :${port} exited with code ${proc.exitCode} before ${String(marker)}. stderr: ${stderr.slice(-4000)}`,
        )
      }
      const left = deadline - Date.now()
      if (left <= 0) {
        throw new Error(
          `${role} process on :${port} did not print ${String(marker)} within ${timeoutMs}ms. stderr: ${stderr.slice(-1000)}`,
        )
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 1_000))
        waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  const kill = async (signal: NodeJS.Signals | number = "SIGTERM"): Promise<void> => {
    if (proc.exitCode !== null || proc.signalCode !== null) return
    try {
      proc.kill(signal)
    } catch {
      /* already dead */
    }
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL")
      } catch {
        /* already dead */
      }
    }, KILL_GRACE_MS)
    try {
      await proc.exited
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    role,
    url: `http://localhost:${port}`,
    port,
    proc,
    env: { ...env },
    stdout: () => stdout,
    stderr: () => stderr,
    waitFor,
    kill,
  }
}

/**
 * Ready = `GET /readyz` answers 200. A server without `/readyz` (404) counts as
 * ready once it has printed its listening line and `/healthz` answers 200.
 */
async function waitUntilReady(p: RoleProcess): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (true) {
    if (p.proc.exitCode !== null) {
      throw new Error(
        `${p.role} process on :${p.port} exited with code ${p.proc.exitCode} before ready. stderr: ${p.stderr().slice(-4000)}`,
      )
    }
    const status = await probe(`${p.url}/readyz`)
    if (status === 200) return
    if (status === 404 && (await probe(`${p.url}/healthz`)) === 200) {
      await p.waitFor(LISTENING_MARKER, Math.max(1, deadline - Date.now()))
      return
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${p.role} process on :${p.port} not ready within ${READY_TIMEOUT_MS}ms. stderr: ${p.stderr().slice(-1000)}`,
      )
    }
    await Bun.sleep(250)
  }
}

async function probe(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) })
    await res.body?.cancel()
    return res.status
  } catch {
    return null
  }
}
