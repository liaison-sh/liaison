// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The contract harness's Workers-shaped executor: the app's ES module is
// imported once in this process (one import = one isolate, module globals
// kept across runs, as the loader's `LOADER.get(id)` cache keeps them) and
// each run goes through worker-core's `runHandler`, the code a Workers or
// workerd isolate runs. The run's `sleepMs` is worker-core's own sleep
// counter (real timers). It is the seam a remote loader or a workerd
// supervisor replaces: same interface, different `open`.
//
// What this one cannot do: cap a heap or stop a synchronous loop (it runs in
// the test process). A run past its wall clock is reported as an overrun and
// abandoned.

import { runHandler } from "~/modules/apps/workers/worker-core"
import type {
  ContractExecutor,
  ContractIsolate,
  ContractRunOutcome,
  ContractRunRequest,
  ContractSource,
} from "./isolate"

class WorkerCoreContractIsolate implements ContractIsolate {
  constructor(private readonly mod: Record<string, unknown>) {}

  async run(req: ContractRunRequest): Promise<ContractRunOutcome> {
    const started = Date.now()
    const bridgeMethods = Object.keys(req.bridge)
    const dispatch = async (method: string, args: unknown[]): Promise<unknown> => {
      const fn = req.bridge[method]
      if (typeof fn !== "function") throw { message: "Unknown bridge method" }
      return await fn(...args)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), req.limits.wallMs)
    })
    try {
      const answer = await Promise.race([
        runHandler(
          this.mod,
          {
            exportName: req.exportName,
            params: req.params,
            ...(req.extraArgs ? { extraArgs: req.extraArgs } : {}),
            bridgeMethods,
          },
          dispatch,
        ),
        deadline,
      ])
      if (answer === "timeout") {
        return {
          ok: false,
          error: "App execution timed out",
          overrun: "wall",
          wallMs: Date.now() - started,
          sleepMs: Date.now() - started,
        }
      }
      const base = { wallMs: Date.now() - started, sleepMs: answer.timings.sleepMs }
      return answer.ok
        ? { ok: true, result: answer.result, ...base }
        : { ok: false, error: answer.error.message, ...base }
    } finally {
      clearTimeout(timer)
    }
  }

  dispose(): void {}
}

let importSerial = 0

export const workerCoreContractExecutor: ContractExecutor = {
  name: "worker-core",
  async open(source: ContractSource): Promise<ContractIsolate> {
    if (!source.modulePath) throw new Error("the worker-core executor needs an ES module path")
    // A fresh module instance per isolate (query string), never a shared one.
    const mod = (await import(`${source.modulePath}?isolate=${++importSerial}`)) as Record<
      string,
      unknown
    >
    return new WorkerCoreContractIsolate(mod)
  },
}
