// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, mock } from "bun:test"

// The Workers runtime module, absent outside workerd.
mock.module("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      protected ctx: unknown,
      protected env: unknown,
    ) {}
  },
}))

describe("worker entry", () => {
  it("run(req, bridge) runs the export over the Bridge's reply envelopes", async () => {
    const { createWorkerEntrypoint } = await import("./worker-entry")
    const Entry = createWorkerEntrypoint({
      h: async (p: { k: string }, ctx: any) => ({ v: await ctx.config_get(p.k) }),
    })
    const entry = new Entry({} as never, {} as never)
    const out = await entry.run(
      { exportName: "h", params: { k: "a" }, bridgeMethods: ["config_get"] },
      { call: async (_m, a) => ({ data: `value-of-${a[0]}` }) },
    )
    expect(out).toMatchObject({
      ok: true,
      result: { v: "value-of-a" },
      timings: { bridgeCalls: 1 },
    })
  })
})
