// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A db-gate that takes the connection and never answers (a gate whose own database
// pool hangs) is a timeout, not an unreachable host: the agent and the operator are
// sent to the gate, not to the network. A port nobody listens on stays "unreachable".
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { ReadCatalog } from "@liaison/db-core"
import { DbTransportError } from "../transport"
import { HttpGate } from "./http-gate"

const EMPTY: ReadCatalog = { adapter: "timeout-test", reads: {} }

let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  // Accepts every request and never responds.
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Promise<Response>(() => {}),
  })
})

afterAll(() => {
  server.stop(true)
})

async function probeError(gate: HttpGate): Promise<unknown> {
  try {
    await gate.diffCatalog(EMPTY)
  } catch (err) {
    return err
  } finally {
    await gate.close()
  }
  return null
}

describe("HttpGate: a gate that never answers", () => {
  test("is reported as a timeout naming the wait, not as unreachable", async () => {
    const gate = new HttpGate({
      gateUrl: `http://127.0.0.1:${server.port}`,
      gateToken: "t".repeat(40),
      timeoutMs: 300,
      allowPrivate: true,
    })
    const err = await probeError(gate)
    expect(err).toBeInstanceOf(DbTransportError)
    expect((err as DbTransportError).kind).toBe("timeout")
    expect((err as Error).message).toMatch(/did not answer within/)
  })

  test("a port nobody listens on stays unreachable", async () => {
    const gate = new HttpGate({
      gateUrl: "http://127.0.0.1:1",
      gateToken: "t".repeat(40),
      timeoutMs: 2000,
      allowPrivate: true,
    })
    const err = await probeError(gate)
    expect((err as DbTransportError).kind).toBe("unreachable")
  })
})
