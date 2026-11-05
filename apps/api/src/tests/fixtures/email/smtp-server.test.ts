// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import nodemailer from "nodemailer"
import { startSmtpFixture } from "./smtp-server"

describe("smtp fixture", () => {
  it("captures parsed MIME from a real client", async () => {
    const fx = await startSmtpFixture({})
    const t = nodemailer.createTransport({
      host: fx.host,
      port: fx.port,
      secure: false,
      ignoreTLS: true,
    })
    await t.sendMail({
      from: "a@x.test",
      to: "b@y.test",
      subject: "Hi",
      text: "body",
      headers: { "Message-ID": "<m1@x.test>" },
    })
    expect(fx.captured).toHaveLength(1)
    expect(fx.captured[0].subject).toBe("Hi")
    expect(fx.captured[0].headers["message-id"]).toContain("m1@x.test")
    await fx.close()
  })

  it("setRejectNext rejects N connections with given code", async () => {
    const fx = await startSmtpFixture({})
    fx.inject.setRejectNext(1, 421)
    const t = nodemailer.createTransport({
      host: fx.host,
      port: fx.port,
      secure: false,
      ignoreTLS: true,
    })
    await expect(
      t.sendMail({ from: "a@x.test", to: "b@y.test", subject: "x", text: "y" }),
    ).rejects.toThrow()
    await t.sendMail({ from: "a@x.test", to: "b@y.test", subject: "ok", text: "y" })
    expect(fx.captured.map((m) => m.subject)).toEqual(["ok"])
    await fx.close()
  })

  it("setAmbiguousNext disconnects after DATA acceptance", async () => {
    const fx = await startSmtpFixture({})
    fx.inject.setAmbiguousNext(1)
    const t = nodemailer.createTransport({
      host: fx.host,
      port: fx.port,
      secure: false,
      ignoreTLS: true,
      socketTimeout: 2000,
    })
    await expect(
      t.sendMail({ from: "a@x.test", to: "b@y.test", subject: "amb", text: "y" }),
    ).rejects.toThrow()
    await fx.close()
  })

  it("setAuthFailure rejects matching auths", async () => {
    const fx = await startSmtpFixture({ authRequired: true })
    fx.inject.setAuthFailure((email) => email === "bad@x.test")
    const tBad = nodemailer.createTransport({
      host: fx.host,
      port: fx.port,
      secure: false,
      ignoreTLS: true,
      auth: { user: "bad@x.test", pass: "pw" },
    })
    await expect(
      tBad.sendMail({ from: "bad@x.test", to: "b@y.test", subject: "no", text: "x" }),
    ).rejects.toThrow()
    const tGood = nodemailer.createTransport({
      host: fx.host,
      port: fx.port,
      secure: false,
      ignoreTLS: true,
      auth: { user: "good@x.test", pass: "pw" },
    })
    await tGood.sendMail({
      from: "good@x.test",
      to: "b@y.test",
      subject: "yes",
      text: "x",
    })
    expect(fx.captured.map((m) => m.subject)).toEqual(["yes"])
    await fx.close()
  })

  it("close is idempotent", async () => {
    const fx = await startSmtpFixture({})
    await fx.close()
    await fx.close()
  })
})
