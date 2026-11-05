// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P8-FX22 F2. A take-over that drives a child process over a schema it owns hands its
// ownership lock down through an env var, and the child skips the acquire. The env var was
// believed bare: a child told it had inherited a schema its parent never took over skipped the
// acquire and held NOTHING, so the schema read as unowned and another run could reclaim and
// drop the live fixture underneath it. That is the same class of claim as the pid notes this
// helper deleted, and it is checked the same way: against pg_locks.

import { afterEach, describe, expect, it } from "bun:test"
import { releaseAppSchema, takeOverAppSchema } from "~/tests/helpers/app-schema-fixture"
import { appSchemaFixtureLockHolderPids } from "~/tests/helpers/app-schema-lock"

const INHERITED_LOCK_ENV = "LIAISON_FIXTURE_LOCK_INHERITED"
const SCHEMA = "app_fx22_inherit_probe"

afterEach(async () => {
  await releaseAppSchema(SCHEMA)
  delete process.env[INHERITED_LOCK_ENV]
})

describe("fixture ownership: an inheritance claim is verified, not believed", () => {
  it("acquires the lock anyway when the env names a schema nobody holds", async () => {
    process.env[INHERITED_LOCK_ENV] = SCHEMA
    expect(await appSchemaFixtureLockHolderPids(SCHEMA)).toEqual([])

    await takeOverAppSchema(SCHEMA)

    // Read back from an ordinary pooled connection, not the reserved one the lock
    // sits on: the schema must be owned by a live session, whatever the env claimed.
    expect((await appSchemaFixtureLockHolderPids(SCHEMA)).length).toBe(1)
  })

  it("releases it again, so the next run finds the schema unowned", async () => {
    process.env[INHERITED_LOCK_ENV] = SCHEMA
    await takeOverAppSchema(SCHEMA)
    await releaseAppSchema(SCHEMA)

    expect(await appSchemaFixtureLockHolderPids(SCHEMA)).toEqual([])
  })

  it("acquires the lock when no inheritance is claimed at all", async () => {
    await takeOverAppSchema(SCHEMA)

    expect((await appSchemaFixtureLockHolderPids(SCHEMA)).length).toBe(1)
  })
})
