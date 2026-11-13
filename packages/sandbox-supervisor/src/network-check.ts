// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The service's own proof that the host firewall step holds
// (deploy/sandbox-firewall.sh, docs/self-hosting/sandbox.md). The workerd
// processes share this service's network, so what the service can reach, a
// run that escaped workerd could reach too. From here only the app's
// bridge-only port may answer: never an app process's main port (the whole
// API), the host on its gateway address (SSH, a database bound to 0.0.0.0, the
// Docker API), or the cloud metadata address. One of them accepting a TCP
// connection means the firewall step is missing or broken: the service then
// refuses every run (`sandbox_network_open`) and the app's /healthz says
// `sandbox: network_open`, until a check finds the network closed again.
//
// Mode, from the environment:
//   SANDBOX_RUNTIME unset            off: the supervisor run directly
//                                    (development, CI), on loopback beside
//                                    the app; nothing to check
//   SANDBOX_ALLOW_OPEN_NETWORK=1     warn: an explicitly accepted setup with no
//                                    firewall step (a development stack on a
//                                    laptop); runs go on, a warning at every
//                                    check
//   otherwise                        enforce
//
// Targets: every app process's main port (SANDBOX_PROBE_APP_PORTS, 3000) at
// the bridge origin's host and at every address a run came from; the host's
// gateway (the default route, else the .1 of this service's own /24) on
// SANDBOX_PROBE_GATEWAY_PORTS (22, 80, 443, 2375, 3000, 5432, 6379); and
// 169.254.169.254:80. A refused, dropped or unroutable connection is closed.

import { readFileSync } from "node:fs"
import { networkInterfaces } from "node:os"

export type NetworkCheckMode = "enforce" | "warn" | "off"

export const NETWORK_OPEN_CODE = "sandbox_network_open"
export const DEFAULT_APP_PORTS = [3000]
export const DEFAULT_GATEWAY_PORTS = [22, 80, 443, 2375, 3000, 5432, 6379]
export const METADATA_TARGET = { host: "169.254.169.254", port: 80 }
/** How long one probe waits for a connection (a dropped one never answers). */
export const PROBE_TIMEOUT_MS = 800

export type NetworkVerdict =
  | { state: "off" }
  | { state: "pending" }
  | { state: "closed"; checkedAt: number }
  | { state: "open"; reachable: string[]; checkedAt: number }

export function networkCheckMode(env: NodeJS.ProcessEnv = process.env): NetworkCheckMode {
  if ((env.SANDBOX_RUNTIME ?? "").trim() === "") return "off"
  return env.SANDBOX_ALLOW_OPEN_NETWORK === "1" ? "warn" : "enforce"
}

export function networkOpenMessage(reachable: string[]): string {
  return (
    `The sandbox service can reach ${reachable.join(", ")}: the host firewall step is ` +
    "missing or broken, so app runs are refused. Run `sudo deploy/sandbox-firewall.sh install` " +
    "(with the -p/--env-file the stack runs with), then `deploy/sandbox-firewall.sh check` " +
    "(docs/self-hosting/sandbox.md). A development stack with no firewall may accept the risk " +
    "with LIAISON_SANDBOX_ALLOW_OPEN_NETWORK=1."
  )
}

/** True when something accepted a TCP connection at host:port within timeoutMs. */
export function tcpAccepts(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((done) => {
    let settled = false
    const finish = (open: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(open)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(s) {
          finish(true)
          s.end()
        },
        data() {},
        error() {
          finish(false)
        },
        connectError() {
          finish(false)
        },
      },
    }).catch(() => finish(false))
  })
}

/** The default route's gateway from /proc/net/route, else the .1 of this host's own IPv4 /24. */
export function defaultGateway(): string | null {
  try {
    for (const line of readFileSync("/proc/net/route", "utf8").split("\n").slice(1)) {
      const f = line.trim().split(/\s+/)
      if (f[1] === "00000000" && f[2] && f[2] !== "00000000") {
        const hex = f[2]
        const bytes = [6, 4, 2, 0].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
        return bytes.join(".")
      }
    }
  } catch {}
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address.replace(/\.\d+$/, ".1")
    }
  }
  return null
}

export function parsePorts(raw: string | undefined, fallback: number[], key: string): number[] {
  if (raw === undefined || raw.trim() === "") return fallback
  const ports = raw.split(",").map((s) => Number(s.trim()))
  if (ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
    throw new Error(`${key} must be a comma-separated list of ports`)
  }
  return ports
}

export interface NetworkCheckOptions {
  mode: NetworkCheckMode
  appPorts: number[]
  gatewayPorts: number[]
  /** Host names of the app processes always probed (the bridge origin's host). */
  appHosts: string[]
  timeoutMs?: number
  /** Tests: the connect probe and the gateway. */
  accepts?: (host: string, port: number, timeoutMs: number) => Promise<boolean>
  gateway?: () => string | null
  log?: (level: "error" | "warn" | "info", msg: string, extra: Record<string, unknown>) => void
}

export class NetworkCheck {
  verdict: NetworkVerdict
  private readonly hosts = new Set<string>()
  private inflight: Promise<NetworkVerdict> | null = null

  constructor(private readonly opts: NetworkCheckOptions) {
    this.verdict = opts.mode === "off" ? { state: "off" } : { state: "pending" }
    for (const h of opts.appHosts) this.hosts.add(h)
  }

  get mode(): NetworkCheckMode {
    return this.opts.mode
  }

  /** Runs are refused: the network is open and the setup did not accept that. */
  get refusing(): boolean {
    return this.opts.mode === "enforce" && this.verdict.state === "open"
  }

  /** An app process seen for the first time (a run's or a health check's caller): probe it too. */
  noteAppHost(host: string): boolean {
    if (this.opts.mode === "off" || this.hosts.has(host)) return false
    this.hosts.add(host)
    return true
  }

  /** One check of every target; concurrent callers share it. */
  check(): Promise<NetworkVerdict> {
    if (this.opts.mode === "off") return Promise.resolve(this.verdict)
    this.inflight ??= this.probeAll().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async probeAll(): Promise<NetworkVerdict> {
    const accepts = this.opts.accepts ?? tcpAccepts
    const timeout = this.opts.timeoutMs ?? PROBE_TIMEOUT_MS
    const targets: Array<{ host: string; port: number }> = []
    for (const host of this.hosts) {
      for (const port of this.opts.appPorts) targets.push({ host, port })
    }
    const gateway = (this.opts.gateway ?? defaultGateway)()
    if (gateway) for (const port of this.opts.gatewayPorts) targets.push({ host: gateway, port })
    targets.push(METADATA_TARGET)
    const seen = new Set<string>()
    const unique = targets.filter((t) => {
      const k = `${t.host}:${t.port}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    const results = await Promise.all(
      unique.map(async (t) => ((await accepts(t.host, t.port, timeout)) ? t : null)),
    )
    const reachable = results
      .filter((t): t is { host: string; port: number } => t !== null)
      .map((t) => (t.host.includes(":") ? `[${t.host}]:${t.port}` : `${t.host}:${t.port}`))
    const before = this.verdict.state
    this.verdict =
      reachable.length > 0
        ? { state: "open", reachable, checkedAt: Date.now() }
        : { state: "closed", checkedAt: Date.now() }
    const log = this.opts.log
    if (log && this.verdict.state === "open") {
      log(this.opts.mode === "enforce" ? "error" : "warn", networkOpenMessage(reachable), {
        reachable,
        mode: this.opts.mode,
      })
    } else if (log && before === "open") {
      log("info", "sandbox network closed again: only the bridge port answers", {})
    }
    return this.verdict
  }
}
