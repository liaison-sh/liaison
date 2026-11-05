// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison team identity mint|install`: the managed edition's identity is
// minted on the server and its key installed from a 0600 file, never obtained
// by registering. Nothing is queued for the control plane by either step.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runTeamIdentityCli } from "~/cli/team-identity"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { _setEdition } from "~/lib/edition"
import { decryptInstanceKey, readIdentity } from "~/modules/liaison-team/identity"
import { instanceKeyFingerprint } from "~/modules/liaison-team/provisioned-identity"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const KEY = "0123456789abcdef".repeat(4)
let dir: string

const identity = () => withSystemDb("test", (tx) => readIdentity(tx))
function keyFile(content: string, mode = 0o600): string {
  const p = join(dir, `key-${Math.random().toString(36).slice(2)}`)
  writeFileSync(p, content)
  chmodSync(p, mode)
  return p
}

beforeAll(async () => {
  await acquireTestLock()
  dir = mkdtempSync(join(tmpdir(), "team-identity-"))
})
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true })
  _setEdition(null)
  await releaseTestLock()
})
beforeEach(async () => {
  _setEdition("managed")
  await sql`DELETE FROM kernel.control_plane_outbox`
  await sql`DELETE FROM kernel.instance_settings WHERE key LIKE 'liaison_team.%'`
})
afterEach(async () => {
  await sql`DELETE FROM kernel.control_plane_outbox`
  await sql`DELETE FROM kernel.instance_settings WHERE key LIKE 'liaison_team.%'`
})

describe("liaison team identity", () => {
  it("mint prints a pending instance id and queues nothing", async () => {
    const res = await runTeamIdentityCli(["mint"])
    expect(res.exitCode).toBe(0)
    const id = await identity()
    expect(res.report).toEqual({ instanceId: id?.instanceId, state: "pending" })
    expect(id?.state).toBe("pending")
    expect((await sql`SELECT 1 FROM kernel.control_plane_outbox`).length).toBe(0)
  })

  it("mint refuses to replace an identity without --force, and replaces it with it", async () => {
    await runTeamIdentityCli(["mint"])
    const first = await identity()
    const again = await runTeamIdentityCli(["mint"])
    expect(again.exitCode).toBe(1)
    expect(again.message).toContain("--force")
    expect((await identity())?.instanceId).toBe(first?.instanceId as string)
    const forced = await runTeamIdentityCli(["mint", "--force"])
    expect(forced.exitCode).toBe(0)
    expect((await identity())?.instanceId).not.toBe(first?.instanceId as string)
  })

  it("install stores the key encrypted, registered, and prints its fingerprint", async () => {
    await runTeamIdentityCli(["mint"])
    const res = await runTeamIdentityCli(["install", "--key-file", keyFile(`${KEY}\n`)])
    expect(res.exitCode).toBe(0)
    const id = await identity()
    expect(id?.state).toBe("registered")
    expect(id?.keyCiphertext).not.toContain(KEY)
    expect(id ? decryptInstanceKey(id) : null).toBe(KEY)
    expect(res.report).toEqual({
      instanceId: id?.instanceId,
      state: "registered",
      keyFingerprint: instanceKeyFingerprint(KEY),
    })
    expect((await sql`SELECT 1 FROM kernel.control_plane_outbox`).length).toBe(0)
  })

  it("install refuses a key file readable by others, a malformed key, or no minted identity", async () => {
    expect((await runTeamIdentityCli(["install", "--key-file", keyFile(KEY)])).message).toContain(
      "mint",
    )
    await runTeamIdentityCli(["mint"])
    const open = await runTeamIdentityCli(["install", "--key-file", keyFile(KEY, 0o644)])
    expect(open.exitCode).toBe(2)
    expect(open.message).toContain("0600")
    const bad = await runTeamIdentityCli(["install", "--key-file", keyFile("not-a-key")])
    expect(bad.exitCode).toBe(1)
    expect((await identity())?.state).toBe("pending")
  })

  it("refuses outside the managed edition", async () => {
    _setEdition("self_hosted")
    const res = await runTeamIdentityCli(["mint"])
    expect(res.exitCode).toBe(2)
    expect(res.message).toContain("LIAISON_EDITION=managed")
    expect(await identity()).toBeNull()
  })

  it("answers usage for an unknown subcommand or a missing flag", async () => {
    expect((await runTeamIdentityCli(["rotate"])).exitCode).toBe(2)
    expect((await runTeamIdentityCli(["install"])).exitCode).toBe(2)
  })
})
