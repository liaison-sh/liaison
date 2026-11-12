#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Start the sandbox service: `bun run packages/sandbox-supervisor/src/main.ts`
// with SANDBOX_BRIDGE_ORIGIN set (config.ts lists every setting).
import { readSupervisorConfig } from "./config"
import { checkContainerRuntime } from "./runtime-check"
import { createSupervisor } from "./supervisor"
import { pinnedWorkerdVersion } from "./workerd-bin"

const runtime = checkContainerRuntime()
if (runtime.kind === "refuse") {
  console.error(JSON.stringify({ level: "fatal", msg: runtime.message }))
  process.exit(1)
}
if (runtime.kind === "warn") {
  const warn = () => console.error(JSON.stringify({ level: "warn", msg: runtime.message }))
  warn()
  setInterval(warn, 60 * 60 * 1000)
}
const cfg = readSupervisorConfig()
const sup = await createSupervisor(cfg)
const server = Bun.serve({
  hostname: cfg.host,
  port: cfg.port,
  idleTimeout: 0,
  maxRequestBodySize: 16 * 1024 * 1024,
  fetch: (req) => sup.fetch(req),
})
console.log(
  JSON.stringify({
    msg: "sandbox service up",
    workerd: pinnedWorkerdVersion(),
    listen: `${server.hostname}:${server.port}`,
    bridgeOrigin: cfg.bridgeOrigin,
    poolSize: cfg.poolSize,
    reserved: cfg.reserved,
    overflow: cfg.overflow,
    recycleRuns: cfg.recycleRuns,
    idleMs: cfg.idleMs,
    heapMb: cfg.heapMb,
    rssCapMb: cfg.rssCapMb,
  }),
)
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    server.stop(true)
    await sup.stop()
    process.exit(0)
  })
}
