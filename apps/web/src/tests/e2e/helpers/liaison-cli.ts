// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Runs the `liaison` CLI (apps/api/src/cli/index.ts) as an operator would beside
// a deployment, against this worker's server data (cliProcessEnv): the CLI
// writes the database, the running server delivers what it queued.
import path from "node:path"
import { cliProcessEnv, type WorkerEnv } from "@liaison/test-helpers"

const API_DIR = path.resolve(import.meta.dir, "../../../../../api")

export interface CliRun {
  /** Everything the CLI printed on stdout so far. */
  stdout(): string
  stderr(): string
  /** Resolves when the CLI exits. */
  exited: Promise<{ code: number; stdout: string; stderr: string }>
  kill(): void
}

async function drain(stream: ReadableStream<Uint8Array>, sink: (text: string) => void) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    sink(decoder.decode(value, { stream: true }))
  }
}

/** Start `liaison <args…>`; `baseUrl` is the web origin the CLI prints links for. */
export function startLiaisonCli(env: WorkerEnv, baseUrl: string, args: string[]): CliRun {
  let out = ""
  let err = ""
  const proc = Bun.spawn({
    cmd: ["bun", "src/cli/index.ts", ...args],
    cwd: API_DIR,
    env: cliProcessEnv(env, baseUrl),
    stdout: "pipe",
    stderr: "pipe",
  })
  const streams = Promise.all([
    drain(proc.stdout, (t) => {
      out += t
    }),
    drain(proc.stderr, (t) => {
      err += t
    }),
  ])
  const exited = (async () => {
    const code = await proc.exited
    await streams
    return { code, stdout: out, stderr: err }
  })()
  return {
    stdout: () => out,
    stderr: () => err,
    exited,
    kill: () => proc.kill(),
  }
}
