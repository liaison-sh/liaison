// SPDX-License-Identifier: FSL-1.1-ALv2
//
// On a demo box no mail leaves, so nobody can be invited to a client portal: they
// could never sign in. The refusal comes before anything is read or written.

import { afterEach, describe, expect, it } from "bun:test"
import type { RlsClient } from "~/db"
import { env } from "~/lib/env"
import { invitePortalPerson, PortalAccessError } from "~/modules/portal/access"

const was = env.LIAISON_DEMO_MODE
const setDemo = (on: boolean) => {
  ;(env as { LIAISON_DEMO_MODE: boolean }).LIAISON_DEMO_MODE = on
}

afterEach(() => setDemo(was))

/** A transaction that fails the test if anything runs on it. */
const untouched = {
  execute: () => {
    throw new Error("the demo refusal ran a statement")
  },
} as Partial<RlsClient> as RlsClient

describe("a portal invitation on a demo box", () => {
  it("is refused with NO_MAIL_ON_DEMO before anything is read or written", async () => {
    setDemo(true)
    const err = await invitePortalPerson({
      orgId: crypto.randomUUID(),
      actorId: crypto.randomUUID(),
      db: untouched,
      companyId: crypto.randomUUID(),
      email: "someone@example.com",
      name: "Someone",
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PortalAccessError)
    expect((err as PortalAccessError).code).toBe("NO_MAIL_ON_DEMO")
    expect((err as PortalAccessError).status).toBe(403)
  })
})
