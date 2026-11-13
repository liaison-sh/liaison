// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { DEFAULTS, readProcessUids, readSupervisorConfig } from "../src/config"
import {
  DEFAULT_GATEWAY_PORTS,
  NETWORK_OPEN_CODE,
  NetworkCheck,
  networkCheckMode,
  tcpAccepts,
} from "../src/network-check"
import { createSupervisor, type Supervisor } from "../src/supervisor"

describe("the firewall self-check's mode", () => {
  it("is off for a supervisor run directly, enforced in a container, warned when accepted", () => {
    expect(networkCheckMode({})).toBe("off")
    expect(networkCheckMode({ SANDBOX_RUNTIME: "runsc" })).toBe("enforce")
    expect(networkCheckMode({ SANDBOX_RUNTIME: "runc", SANDBOX_ALLOW_OPEN_NETWORK: "true" })).toBe(
      "enforce",
    )
    expect(networkCheckMode({ SANDBOX_RUNTIME: "runsc", SANDBOX_ALLOW_OPEN_NETWORK: "1" })).toBe(
      "warn",
    )
  })
})

describe("the firewall self-check", () => {
  it("probes every app process's main port, the gateway and the metadata address", async () => {
    const probed: string[] = []
    const check = new NetworkCheck({
      mode: "enforce",
      appPorts: [3000],
      gatewayPorts: [22],
      appHosts: ["app-bridge"],
      gateway: () => "10.73.250.1",
      accepts: async (host, port) => {
        probed.push(`${host}:${port}`)
        return false
      },
    })
    expect(check.verdict.state).toBe("pending")
    expect((await check.check()).state).toBe("closed")
    expect(probed.sort()).toEqual(["10.73.250.1:22", "169.254.169.254:80", "app-bridge:3000"])
    // A new app process (a rolling api) joins the targets.
    expect(check.noteAppHost("10.73.250.3")).toBe(true)
    expect(check.noteAppHost("10.73.250.3")).toBe(false)
    probed.length = 0
    await check.check()
    expect(probed).toContain("10.73.250.3:3000")
    expect(check.refusing).toBe(false)
  })

  it("finds the network open when anything but the bridge accepts, and refuses only when enforced", async () => {
    const open = (host: string, port: number) =>
      Promise.resolve(host === "app-bridge" && port === 3000)
    const enforced = new NetworkCheck({
      mode: "enforce",
      appPorts: [3000],
      gatewayPorts: [],
      appHosts: ["app-bridge"],
      gateway: () => null,
      accepts: open,
    })
    const v = await enforced.check()
    expect(v.state === "open" && v.reachable).toEqual(["app-bridge:3000"])
    expect(enforced.refusing).toBe(true)
    const accepted = new NetworkCheck({
      mode: "warn",
      appPorts: [3000],
      gatewayPorts: [],
      appHosts: ["app-bridge"],
      gateway: () => null,
      accepts: open,
    })
    expect((await accepted.check()).state).toBe("open")
    expect(accepted.refusing).toBe(false)
    const off = new NetworkCheck({
      mode: "off",
      appPorts: [3000],
      gatewayPorts: [],
      appHosts: ["app-bridge"],
      accepts: open,
    })
    expect((await off.check()).state).toBe("off")
  })

  it("a real TCP probe: a listener is open, a closed port is not", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    })
    try {
      expect(await tcpAccepts("127.0.0.1", server.port, 800)).toBe(true)
    } finally {
      server.stop(true)
    }
    expect(await tcpAccepts("127.0.0.1", server.port, 800)).toBe(false)
  })

  it("reads its ports from the environment", () => {
    const cfg = readSupervisorConfig({
      SANDBOX_BRIDGE_ORIGIN: "http://app-bridge:3100",
      SANDBOX_RUNTIME: "runsc",
      SANDBOX_PROBE_APP_PORTS: "3000, 3001",
    })
    expect(cfg.networkCheck).toBe("enforce")
    expect(cfg.probeAppPorts).toEqual([3000, 3001])
    expect(cfg.probeGatewayPorts).toEqual(DEFAULT_GATEWAY_PORTS)
    expect(() =>
      readSupervisorConfig({
        SANDBOX_BRIDGE_ORIGIN: "http://app-bridge:3100",
        SANDBOX_PROBE_GATEWAY_PORTS: "22,x",
      }),
    ).toThrow(/SANDBOX_PROBE_GATEWAY_PORTS/)
  })
})

describe("the service with the network open", () => {
  let sup: Supervisor | undefined
  afterEach(async () => {
    await sup?.stop()
    sup = undefined
  })

  it("refuses every run and answers its bridge health 503 until the network is closed", async () => {
    let firewall = false
    sup = await createSupervisor(
      {
        ...DEFAULTS,
        bridgeOrigin: "http://app-bridge:3100",
        spares: 0,
        networkCheck: "enforce",
      },
      {
        release: "r1",
        network: {
          gateway: () => "10.73.250.1",
          accepts: async (host, port) => !firewall && host === "10.73.250.1" && port === 22,
        },
      },
    )
    const run = await sup.fetch(new Request("http://sandbox/run", { method: "POST", body: "{}" }))
    expect(run.status).toBe(503)
    const body = (await run.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe(NETWORK_OPEN_CODE)
    expect(body.error.message).toContain("10.73.250.1:22")
    expect(body.error.message).toContain("sandbox-firewall.sh")

    const health = await sup.fetch(new Request("http://sandbox/health?bridge=1"))
    expect(health.status).toBe(503)
    expect(((await health.json()) as { code: string }).code).toBe(NETWORK_OPEN_CODE)
    // The container's own health stays up: the stack can start before the firewall step.
    expect((await sup.fetch(new Request("http://sandbox/health"))).status).toBe(200)

    // The firewall step is installed: the next bridge health check looks again at once.
    firewall = true
    await Bun.sleep(2_100)
    const after = await sup.fetch(new Request("http://sandbox/health?bridge=1"))
    expect(after.status).toBe(200)
    expect(((await after.json()) as { network: string }).network).toBe("closed")
    const runAfter = await sup.fetch(
      new Request("http://sandbox/run", { method: "POST", body: "{}" }),
    )
    // Past the check: the body itself is refused now, not the network.
    expect(runAfter.status).toBe(400)
  }, 20_000)
})

describe("one uid per workerd process", () => {
  it("only when the service runs as root, with a range that covers the pool", () => {
    expect(readProcessUids({}, 8, false)).toBeNull()
    expect(readProcessUids({}, 8, true)).toEqual({ base: 40_000, count: 64 })
    expect(readProcessUids({ SANDBOX_PROCESS_UIDS: "off" }, 8, true)).toBeNull()
    expect(
      readProcessUids(
        { SANDBOX_PROCESS_UID_BASE: "50000", SANDBOX_PROCESS_UID_COUNT: "8" },
        8,
        true,
      ),
    ).toEqual({ base: 50_000, count: 8 })
    expect(() => readProcessUids({ SANDBOX_PROCESS_UID_COUNT: "4" }, 8, true)).toThrow(
      /must cover every process/,
    )
  })
})
