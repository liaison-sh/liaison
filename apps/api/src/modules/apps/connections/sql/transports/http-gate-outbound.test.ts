// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The db-gate URL is org data (a credential field an app admin types). The
// requests HttpGate sends to it must stay on the host that was checked: a
// redirect from the gate is not followed to a second address.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { HttpGate } from "./http-gate"

let gate: ReturnType<typeof Bun.serve> | undefined
let other: ReturnType<typeof Bun.serve> | undefined
const reachedOther: string[] = []

beforeAll(() => {
  other = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      reachedOther.push(new URL(req.url).pathname)
      return Response.json({ ok: true })
    },
  })
  gate = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      return Response.redirect(`http://127.0.0.1:${other?.port}/elsewhere${path}`, 302)
    },
  })
})

afterAll(() => {
  gate?.stop(true)
  other?.stop(true)
})

describe("db-gate outbound requests", () => {
  test("a redirect from the gate is not followed to another address", async () => {
    const transport = new HttpGate({ gateUrl: `http://127.0.0.1:${gate?.port}`, gateToken: "t" })
    await transport.probe().catch(() => undefined)
    expect(reachedOther).toEqual([])
  })

  test("with the operator's private opt-in, a redirect is still not followed", async () => {
    const transport = new HttpGate({
      gateUrl: `http://127.0.0.1:${gate?.port}`,
      gateToken: "t",
      allowPrivate: true,
    })
    const report = await transport.probe()
    expect({ reached: reachedOther, ok: report.ok, warnings: report.warnings }).toEqual({
      reached: [],
      ok: false,
      warnings: ["db-gate answered with a redirect; redirects are not followed"],
    })
  })

  test("a loopback gate without the operator's opt-in is refused before any request", async () => {
    const transport = new HttpGate({ gateUrl: `http://127.0.0.1:${other?.port}`, gateToken: "t" })
    const report = await transport.probe()
    expect(reachedOther).toEqual([])
    expect(report.warnings.join(" ")).toContain("LIAISON_DATABASE_ALLOWED_HOSTS")
  })

  test("an allow-listed loopback host is the opt-in; an unlisted host is refused", async () => {
    const listed = new HttpGate({
      gateUrl: `http://127.0.0.1:${other?.port}`,
      gateToken: "t",
      allowedHosts: ["127.0.0.1"],
    })
    expect((await listed.probe()).ok).toBe(true)
    const unlisted = new HttpGate({
      gateUrl: "https://gate.example.com",
      gateToken: "t",
      allowedHosts: ["db.example.org"],
      resolveDns: async () => ["203.0.113.7"],
    })
    expect((await unlisted.probe()).warnings.join(" ")).toContain("not on the allow-list")
    reachedOther.length = 0
  })

  test("metadata and the instance's own services are never a gate", async () => {
    const metadata = new HttpGate({
      gateUrl: "http://metadata.internal",
      gateToken: "t",
      allowPrivate: true,
      resolveDns: async () => ["169.254.169.254"],
    })
    expect((await metadata.probe()).warnings.join(" ")).toContain("link-local and metadata")
    const own = new HttpGate({
      gateUrl: `http://localhost:${other?.port}`,
      gateToken: "t",
      allowPrivate: true,
      blockedEndpoints: [`127.0.0.1:${other?.port}`],
    })
    expect((await own.probe()).warnings.join(" ")).toContain("service of this Liaison instance")
    expect(reachedOther).toEqual([])
  })
})
