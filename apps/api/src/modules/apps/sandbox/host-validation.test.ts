// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { validateExternalHost } from "~/modules/apps/sandbox/host-validation"

// host-validation resolves hostnames via its own `node:dns/promises` import and
// exposes no resolver-injection seam, so these tests exercise the validator
// against direct IP literals and hostnames the real resolver maps to loopback
// (e.g. `localhost`). Controlled DNS-rebinding coverage — a *public* hostname
// that resolves to an RFC-1918 address — would require an injectable resolver in
// host-validation.ts and is intentionally not asserted here.

describe("validateExternalHost", () => {
  let prevAllowPrivate: string | undefined
  beforeAll(() => {
    prevAllowPrivate = process.env.ALLOW_PRIVATE_MAIL_HOSTS
    delete process.env.ALLOW_PRIVATE_MAIL_HOSTS
  })
  afterAll(() => {
    if (prevAllowPrivate === undefined) delete process.env.ALLOW_PRIVATE_MAIL_HOSTS
    else process.env.ALLOW_PRIVATE_MAIL_HOSTS = prevAllowPrivate
  })

  it("rejects private IMAP hosts (direct IP)", async () => {
    await expect(validateExternalHost("127.0.0.1", "IMAP")).rejects.toThrow("private network")
  })

  it("rejects loopback IMAP host", async () => {
    await expect(validateExternalHost("::1", "IMAP")).rejects.toThrow("private network")
  })

  it("rejects RFC-1918 IP for SMTP", async () => {
    await expect(validateExternalHost("10.0.0.1", "SMTP")).rejects.toThrow("private network")
  })

  it("rejects 172.16.x.x range for IMAP", async () => {
    await expect(validateExternalHost("172.16.0.1", "IMAP")).rejects.toThrow("private network")
  })

  it("rejects private SMTP hosts that resolve via DNS (localhost)", async () => {
    // localhost resolves to 127.0.0.1 — DNS-pinning check must catch this.
    await expect(validateExternalHost("localhost", "SMTP")).rejects.toThrow("private network")
  })

  it("accepts public IP hosts", async () => {
    await expect(validateExternalHost("8.8.8.8", "IMAP")).resolves.toMatchObject({
      host: "8.8.8.8",
      address: "8.8.8.8",
      family: 4,
    })
  })

  it("returns the resolved address and family for direct IP hosts", async () => {
    const result = await validateExternalHost("1.1.1.1", "SMTP")
    expect(result.host).toBe("1.1.1.1")
    expect(result.address).toBe("1.1.1.1")
    expect(result.family).toBe(4)
  })

  it("rejects an empty host string", async () => {
    await expect(validateExternalHost("", "IMAP")).rejects.toThrow()
  })

  it("strips brackets from IPv6 literal addresses", async () => {
    // A public IPv6 address wrapped in brackets (as used in URLs/config) is
    // valid; the validator must strip the brackets before checking.
    await expect(validateExternalHost("[2001:4860:4860::8888]", "IMAP")).resolves.toMatchObject({
      host: "2001:4860:4860::8888",
      family: 6,
    })
  })
})

describe("validateExternalHost with ALLOW_PRIVATE_MAIL_HOSTS", () => {
  let prevAllowPrivate: string | undefined
  let prevNodeEnv: string | undefined
  beforeAll(() => {
    prevAllowPrivate = process.env.ALLOW_PRIVATE_MAIL_HOSTS
    prevNodeEnv = process.env.NODE_ENV
    // Simulate non-production so the escape hatch is available.
    process.env.NODE_ENV = "test"
    process.env.ALLOW_PRIVATE_MAIL_HOSTS = "true"
  })
  afterAll(() => {
    if (prevAllowPrivate === undefined) delete process.env.ALLOW_PRIVATE_MAIL_HOSTS
    else process.env.ALLOW_PRIVATE_MAIL_HOSTS = prevAllowPrivate
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prevNodeEnv
  })

  it("allows private IP hosts when ALLOW_PRIVATE_MAIL_HOSTS=true in non-prod", async () => {
    await expect(validateExternalHost("127.0.0.1", "IMAP")).resolves.toMatchObject({
      host: "127.0.0.1",
      address: "127.0.0.1",
      family: 4,
    })
  })
})
