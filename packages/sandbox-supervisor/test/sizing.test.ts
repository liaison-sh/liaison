// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The pool sizes itself from what the service may use (its memory over the
// RSS cap, its CPUs), and the reserves follow; explicit settings win.
import { describe, expect, test } from "bun:test"
import {
  autoPoolSize,
  autoReserves,
  detectServiceLimits,
  laneCaps,
  parseMemoryMb,
  readSupervisorConfig,
  type ServiceLimits,
} from "../src/config"

const GiB = 1024 ** 3
const ORIGIN = { SANDBOX_BRIDGE_ORIGIN: "http://127.0.0.1:9" }
const box = (memoryMb: number, cpus: number) => (): ServiceLimits => ({
  memoryMb,
  memorySource: "cgroup",
  cpus,
  cpuSource: "cgroup",
})
const sized = (memoryMb: number, cpus: number, env: Record<string, string> = {}) => {
  const cfg = readSupervisorConfig({ ...ORIGIN, ...env }, box(memoryMb, cpus))
  return {
    poolSize: cfg.poolSize,
    reserved: cfg.reserved,
    reservedInteractive: cfg.reservedInteractive,
    overflow: cfg.overflow,
    caps: laneCaps(cfg),
  }
}

describe("pool sizing", () => {
  test("2 GiB, 2 CPUs (the compose defaults) is today's pool: 6 + 2, 2 nested, 2 interactive", () => {
    expect(sized(2048, 2)).toEqual({
      poolSize: 6,
      reserved: 2,
      reservedInteractive: 2,
      overflow: 2,
      caps: { interactive: 4, background: 2 },
    })
  })

  test("a small and a large service get a sane pool, with an interactive reserve", () => {
    // 1 GiB: 4 processes at the 256 MiB cap, 2 of them overflow.
    expect(sized(1024, 1)).toMatchObject({
      poolSize: 2,
      reserved: 0,
      caps: { interactive: 2, background: 1 },
    })
    expect(sized(3072, 3)).toMatchObject({
      poolSize: 10,
      reserved: 3,
      reservedInteractive: 3,
      caps: { interactive: 7, background: 4 },
    })
    // 8 GiB, 4 CPUs: the CPUs bound it (4 a CPU).
    expect(sized(8192, 4)).toMatchObject({
      poolSize: 16,
      reserved: 4,
      reservedInteractive: 5,
      caps: { interactive: 12, background: 7 },
    })
    // A huge host: capped.
    expect(sized(256 * 1024, 64).poolSize).toBe(32)
    // A smaller RSS cap fits more processes in the same memory.
    expect(sized(2048, 4, { SANDBOX_RSS_CAP_MB: "128" }).poolSize).toBe(14)
  })

  test("explicit settings win, each on its own", () => {
    expect(sized(2048, 2, { SANDBOX_POOL_SIZE: "9" })).toMatchObject({
      poolSize: 9,
      reserved: 3,
      reservedInteractive: 3,
    })
    expect(
      sized(2048, 2, {
        SANDBOX_POOL_SIZE: "6",
        SANDBOX_POOL_RESERVED: "1",
        SANDBOX_POOL_RESERVED_INTERACTIVE: "1",
      }),
    ).toMatchObject({ poolSize: 6, reserved: 1, reservedInteractive: 1 })
    const cfg = readSupervisorConfig({ ...ORIGIN, SANDBOX_POOL_SIZE: "6" }, box(2048, 2))
    expect(cfg.sizing).toMatchObject({ memoryMb: 2048, cpus: 2, fromEnv: ["poolSize"] })
  })

  test("the stated limits (compose's) come first, then the cgroup's, then the host's", () => {
    const cfg = readSupervisorConfig({
      ...ORIGIN,
      SANDBOX_SERVICE_MEM_LIMIT: "3g",
      SANDBOX_SERVICE_CPUS: "3.0",
    })
    expect(cfg.poolSize).toBe(10)
    expect(cfg.sizing).toMatchObject({
      memoryMb: 3072,
      memorySource: "env",
      cpus: 3,
      cpuSource: "env",
    })
    expect(parseMemoryMb("1536m")).toBe(1536)
    expect(parseMemoryMb(String(2 * GiB))).toBe(2048)
    expect(parseMemoryMb("2GiB")).toBe(2048)
    expect(() => readSupervisorConfig({ ...ORIGIN, SANDBOX_SERVICE_MEM_LIMIT: "lots" })).toThrow(
      /SANDBOX_SERVICE_MEM_LIMIT/,
    )
    expect(() => readSupervisorConfig({ ...ORIGIN, SANDBOX_SERVICE_CPUS: "0" })).toThrow(
      /SANDBOX_SERVICE_CPUS/,
    )
  })

  test("cgroup v2, cgroup v1 and the host fallback", () => {
    const host = { memoryBytes: 16 * GiB, cpus: 8 }
    const files = (f: Record<string, string>) => (p: string) => f[p] ?? null
    expect(
      detectServiceLimits(
        files({
          "/sys/fs/cgroup/memory.max": String(2 * GiB),
          "/sys/fs/cgroup/cpu.max": "150000 100000",
        }),
        host,
      ),
    ).toEqual({ memoryMb: 2048, memorySource: "cgroup", cpus: 1.5, cpuSource: "cgroup" })
    expect(
      detectServiceLimits(
        files({
          "/sys/fs/cgroup/memory/memory.limit_in_bytes": String(GiB),
          "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "200000",
          "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000",
        }),
        host,
      ),
    ).toEqual({ memoryMb: 1024, memorySource: "cgroup", cpus: 2, cpuSource: "cgroup" })
    // No limit (`max`, v1's huge number, a limit above the host's): the host's.
    expect(
      detectServiceLimits(
        files({
          "/sys/fs/cgroup/memory.max": "max",
          "/sys/fs/cgroup/cpu.max": "max 100000",
          "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712",
        }),
        host,
      ),
    ).toEqual({ memoryMb: 16384, memorySource: "host", cpus: 8, cpuSource: "host" })
  })

  test("the derivations", () => {
    expect(autoPoolSize(box(2048, 2)(), 256, 2)).toBe(6)
    expect(autoPoolSize(box(512, 1)(), 256, 2)).toBe(2) // never under 2
    expect(autoReserves(6)).toEqual({ reserved: 2, reservedInteractive: 2 })
    expect(autoReserves(2)).toEqual({ reserved: 0, reservedInteractive: 1 })
    expect(autoReserves(30)).toEqual({ reserved: 4, reservedInteractive: 10 })
  })
})
