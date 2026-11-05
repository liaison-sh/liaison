// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Email provider pinning on a demo box, which had no test.
//
// A public demo hands a stranger an admin account, and an admin can invite. The
// invitation, the magic link and the sign-in code all travel on the SYSTEM
// channel, which is selected independently of the default provider precisely so
// it can reach a real inbox when everything else is sinked. That is the one
// channel a visitor could aim at somebody else's address, so on a demo box both
// channels are taken off the wire and SYSTEM_RESEND_API_KEY is overridden rather
// than inherited around.
//
// AND THEY REFUSE RATHER THAN SINK (defect D5). Both channels used to be pinned
// to `ConsoleEmailProvider`, which ACCEPTS a send and records it as delivered.
// "No mail leaves this instance" was true and the product lied about the
// consequence: an admin persona who invited a user saw "invited" and nothing
// happened, which is precisely what demo-egress.ts argues against by name. The
// refusal is the honest version and it is what these tests now pin.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  ConsoleEmailProvider,
  DemoRefusingEmailProvider,
  getEmailProvider,
  getSystemEmailProvider,
  initEmailProvider,
  ResendEmailProvider,
  setEmailProvider,
  setSystemEmailProvider,
} from "~/infra/email"
import { env } from "~/lib/env"

const original = {
  demo: env.LIAISON_DEMO_MODE,
  resend: env.RESEND_API_KEY,
  systemResend: env.SYSTEM_RESEND_API_KEY,
}

/** Forget both cached providers so the next get() re-runs the selection. */
function resetProviders(): void {
  setEmailProvider(null as unknown as ConsoleEmailProvider)
  setSystemEmailProvider(null)
}

describe("demo email pinning", () => {
  beforeEach(() => {
    resetProviders()
    // A deployment that IS configured to deliver real mail, on both channels.
    env.RESEND_API_KEY = "re_test_default_key"
    env.SYSTEM_RESEND_API_KEY = "re_test_system_key"
  })

  afterEach(() => {
    env.LIAISON_DEMO_MODE = original.demo
    env.RESEND_API_KEY = original.resend
    env.SYSTEM_RESEND_API_KEY = original.systemResend
    resetProviders()
  })

  afterAll(() => {
    resetProviders()
  })

  it("takes the default channel off the wire on a demo box", () => {
    env.LIAISON_DEMO_MODE = true
    expect(initEmailProvider()).toBeInstanceOf(DemoRefusingEmailProvider)
    expect(getEmailProvider()).toBeInstanceOf(DemoRefusingEmailProvider)
  })

  // The dangerous half: SYSTEM_RESEND_API_KEY is set, and it must NOT win.
  it("overrides SYSTEM_RESEND_API_KEY rather than inheriting around it", () => {
    env.LIAISON_DEMO_MODE = true
    const system = getSystemEmailProvider()
    expect(system).toBeInstanceOf(DemoRefusingEmailProvider)
    expect(system).toBe(getEmailProvider())
  })

  // The sink is what made "invited" a lie. A send must not resolve.
  it("refuses the send rather than accepting it and dropping it", async () => {
    env.LIAISON_DEMO_MODE = true
    await expect(
      getSystemEmailProvider().send({
        to: "a.real.person@gmail.com",
        subject: "You have been invited",
        html: "<p>Join</p>",
      }),
    ).rejects.toThrow()
    expect(await getSystemEmailProvider().verify()).toBe(false)
  })

  // The regression guard: a real deployment still delivers on both channels.
  it("leaves both channels on Resend when demo mode is off", () => {
    env.LIAISON_DEMO_MODE = false
    expect(initEmailProvider()).toBeInstanceOf(ResendEmailProvider)
    expect(getSystemEmailProvider()).toBeInstanceOf(ResendEmailProvider)
  })

  // And the unconfigured deployment (dev, test, a self-hosted box with no SMTP)
  // keeps the console sink it has always had. Refusing is a DEMO property, never
  // an "email is not configured" one.
  it("leaves an unconfigured deployment on the console with demo mode off", () => {
    env.LIAISON_DEMO_MODE = false
    env.RESEND_API_KEY = ""
    env.SYSTEM_RESEND_API_KEY = ""
    expect(initEmailProvider()).toBeInstanceOf(ConsoleEmailProvider)
    expect(getSystemEmailProvider()).toBeInstanceOf(ConsoleEmailProvider)
  })
})
