// SPDX-License-Identifier: FSL-1.1-ALv2
// The managed edition never creates its first account through the web: the
// operator org and its admin are provisioned from the CLI, so the bootstrap
// registration answers 404 there, while a self-hosted server keeps it.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const saved = env.LIAISON_EDITION
const setEditionEnv = (v: "managed" | "self_hosted" | undefined) => {
  ;(env as { LIAISON_EDITION?: string }).LIAISON_EDITION = v
}
const register = () =>
  app.request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "first@managed.test", name: "First" }),
  })

describe("POST /api/auth/register bootstrap", () => {
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)
  afterEach(() => {
    setEditionEnv(saved)
    _setEdition(null)
  })

  test("is closed (404) in the managed edition, and creates nothing", async () => {
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM kernel.organizations`
    expect(n).toBe(0)
    _setEdition(null)
    setEditionEnv("managed")
    const res = await register()
    expect(res.status).toBe(404)
    const [{ n: after }] = await sql`SELECT count(*)::int AS n FROM kernel.organizations`
    expect(after).toBe(0)
  })

  test("stays open on a self-hosted server", async () => {
    _setEdition(null)
    setEditionEnv(undefined)
    const res = await register()
    expect(res.status).toBe(200)
  })
})
