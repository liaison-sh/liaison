// SPDX-License-Identifier: FSL-1.1-ALv2
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

export interface ViteServer {
  kill(): Promise<void>
}

/**
 * The supervisor shell script that owns a spawned dev server.
 *
 * `bunx vite` is a WRAPPER: it execs `node .../vite` as a child. Killing the
 * wrapper leaves that node process alive and reparented to pid 1, so a
 * Playwright worker that is SIGKILLed (a worker-fixture timeout, the memory
 * guard, a crashed runner) never runs `kill()` and leaks a dev server per
 * worker generation. Two guarantees fix that, mirroring the API server's
 * orphan guard:
 *   * `set -m` puts the server in its own process GROUP, and every kill
 *     targets the group (`kill -- -$pid`), so the node child dies too.
 *   * the death pipe on fd 0: the spawning process holds the only write end,
 *     so the shell sees EOF the instant the harness dies by any means and tears
 *     the group down. Nothing is ever written to it.
 *
 * The pipe is read by a BACKGROUND `cat` that the script `wait`s on, not a
 * foreground one. bash defers a trap until the running FOREGROUND command
 * returns, and a `cat` blocked on a still-open pipe never returns when only
 * bash is signalled, so `trap cleanup TERM` never ran: `kill()` SIGTERMed the
 * supervisor, waited 2 s, SIGKILLed it, and the server group was orphaned to
 * pid 1. A 4-worker Playwright lane leaked one ~600 MB `node vite` per worker
 * GENERATION and tripped the memory guard at 20 GB of tree RSS after 44 tests.
 * `wait` is a builtin, so a trapped signal interrupts it immediately and
 * cleanup runs on SIGTERM as well as on pipe EOF.
 *
 * Exported for `vite.test.ts`, which drives it with a cheap marker child
 * instead of a real dev server.
 */
export function viteSupervisorScript(command: string): string {
  return `
set -m
${command} &
child=$!
cleanup() {
  kill -TERM -$child 2>/dev/null
  sleep 0.5
  kill -KILL -$child 2>/dev/null
  exit 0
}
trap cleanup TERM INT EXIT
cat > /dev/null &
catpid=$!
wait $catpid
cleanup
`
}

/**
 * Where a spawned Vite server's output goes when it stops: the run's log
 * directory, beside the API server's `worker-<id>-*.log` (worker-env.ts), as
 * `vite-<port>-stdout.log` / `vite-<port>-stderr.log`. Vite's proxy answers a
 * request it could not forward with a bare 502 and prints why (`http proxy
 * error: <path>` and the socket error) only on its own output, so without
 * this file a 502 in a test names nothing.
 */
export function writeViteLogs(
  logDir: string,
  port: number,
  out: { stdout: string; stderr: string },
): void {
  try {
    mkdirSync(logDir, { recursive: true })
    if (out.stdout) writeFileSync(path.join(logDir, `vite-${port}-stdout.log`), out.stdout)
    if (out.stderr) writeFileSync(path.join(logDir, `vite-${port}-stderr.log`), out.stderr)
  } catch {
    /* best effort, like the API server's logs */
  }
}

/**
 * Spawn a Vite dev server on the given port, poll until ready, and return
 * a handle for teardown. Throws if Vite fails to respond within `timeoutMs`.
 */
export async function spawnViteServer(opts: {
  port: number
  cwd: string
  env?: Record<string, string>
  timeoutMs?: number
  /**
   * "dev" (default) runs the dev server. "preview" serves an existing
   * production BUILD, which some scenarios require rather than prefer: the
   * mailbox crypto worker is booted from a blob URL and only the built bundle
   * is the single self-contained file that a blob module worker can run.
   * The caller is responsible for having built `dist/` first.
   */
  mode?: "dev" | "preview"
  /** The build `preview` serves, when it is not the config's own `dist/`. */
  outDir?: string
}): Promise<ViteServer> {
  const { port, cwd, env: extraEnv, timeoutMs = 30_000, mode = "dev", outDir } = opts
  // --host 127.0.0.1 forces IPv4 binding. Without it, Vite v8 binds only to
  // IPv6 [::1] on macOS, which Bun's fetch to 127.0.0.1 cannot reach (and
  // "localhost" DNS resolution under heavy parallel load is flaky too).
  // Orphan handling (process group + death pipe) lives in viteSupervisorScript.
  const viteArgs =
    mode === "preview"
      ? `preview --port ${port} --strictPort --host 127.0.0.1${outDir ? ` --outDir ${outDir}` : ""}`
      : `--port ${port} --strictPort --host 127.0.0.1`
  const supervisor = viteSupervisorScript(`bunx vite ${viteArgs}`)
  const proc = Bun.spawn({
    cmd: ["/bin/bash", "-c", supervisor],
    cwd,
    env: { ...process.env, ...extraEnv },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })

  let stdoutBuf = ""
  let stderrBuf = ""
  const drain = async (stream: ReadableStream<Uint8Array>, target: "out" | "err") => {
    const reader = stream.getReader()
    const dec = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = dec.decode(value, { stream: true })
        if (target === "out") stdoutBuf += text
        else stderrBuf += text
      }
    } catch {}
  }
  const drained = Promise.all([drain(proc.stdout, "out"), drain(proc.stderr, "err")])

  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + timeoutMs
  let ready = false

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (res.ok) {
        ready = true
        break
      }
    } catch {
      // Not ready yet
    }
    await Bun.sleep(100)
  }

  // The same directory worker-env.ts writes the API server's logs to.
  const logDir = process.env.LOG_DIR ?? `${process.cwd()}/../../logs`
  if (!ready) {
    writeViteLogs(logDir, port, { stdout: stdoutBuf, stderr: stderrBuf })
    proc.kill("SIGTERM")
    throw new Error(
      `Vite dev server failed to start on port ${port} within ${timeoutMs}ms.\nstdout: ${stdoutBuf.slice(-2000)}\nstderr: ${stderrBuf.slice(-2000)}`,
    )
  }

  return {
    async kill() {
      try {
        proc.kill("SIGTERM")
      } catch {}
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL")
        } catch {}
      }, 2000)
      try {
        await proc.exited
      } finally {
        clearTimeout(timer)
      }
      // The streams close with the process; bounded in case a grandchild holds them open.
      await Promise.race([drained, Bun.sleep(1_000)])
      writeViteLogs(logDir, port, { stdout: stdoutBuf, stderr: stderrBuf })
    },
  }
}
