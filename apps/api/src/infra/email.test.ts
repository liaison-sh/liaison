// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { simpleParser } from "mailparser"
import { SMTPServer } from "smtp-server"
import {
  CapturedDemoMailProvider,
  CONSOLE_SENT_LIMIT,
  ConsoleEmailProvider,
  consoleEmailBody,
  DemoRefusingEmailProvider,
  escapeHtml,
  getEmailProvider,
  getSystemEmailProvider,
  initEmailProvider,
  ResendEmailProvider,
  recipientDomain,
  SmtpEmailProvider,
  setEmailProvider,
  setSystemEmailProvider,
  systemEmailFrom,
} from "~/infra/email"
import { env } from "~/lib/env"

describe("consoleEmailBody", () => {
  it("logs the plain-text part, so a sign-in code reaches an operator without SMTP", () => {
    expect(
      consoleEmailBody({
        to: "a@test.com",
        subject: "Your Liaison sign-in code",
        html: "<p>ignored</p>",
        text: "Enter this code to sign in:  123456",
      }),
    ).toBe("Enter this code to sign in:  123456")
  })

  it("falls back to the HTML stripped of tags, styles and scripts", () => {
    expect(
      consoleEmailBody({
        to: "a@test.com",
        subject: "S",
        html: "<style>p{color:red}</style><p>Code: <b>654321</b></p><p>Bye</p>",
      }),
    ).toBe("Code: 654321\nBye")
  })
})

describe("ConsoleEmailProvider body logging and memory", () => {
  it("never logs the body unless LIAISON_CONSOLE_EMAIL_BODIES opted in", async () => {
    const lines: Array<{ level: string; obj: unknown }> = []
    const { rootLogger } = await import("~/lib/logger")
    const child = rootLogger.child({ service: "email" })
    const infoSpy = spyOn(Object.getPrototypeOf(child), "info")
    const warnSpy = spyOn(Object.getPrototypeOf(child), "warn")
    infoSpy.mockImplementation(function (this: unknown, obj: unknown) {
      lines.push({ level: "info", obj })
    })
    warnSpy.mockImplementation(function (this: unknown, obj: unknown) {
      lines.push({ level: "warn", obj })
    })
    try {
      const message = { to: "a@test.com", subject: "Code", html: "x", text: "code 123456" }
      await new ConsoleEmailProvider(false).send(message)
      await new ConsoleEmailProvider(true).send(message)
    } finally {
      infoSpy.mockRestore()
      warnSpy.mockRestore()
    }
    expect(lines).toEqual([
      { level: "info", obj: { template: "unlabelled", toDomain: "test.com" } },
      {
        level: "warn",
        obj: {
          template: "unlabelled",
          toDomain: "test.com",
          to: "a@test.com",
          subject: "Code",
          body: "code 123456",
        },
      },
    ])
  })

  it("keeps only the most recent messages in memory", async () => {
    const provider = new ConsoleEmailProvider(false)
    for (let i = 0; i < CONSOLE_SENT_LIMIT + 5; i++) {
      await provider.send({ to: `u${i}@test.com`, subject: "s", html: "h" })
    }
    expect(provider.sent).toHaveLength(CONSOLE_SENT_LIMIT)
    expect(provider.sent[0]?.to).toBe("u5@test.com")
  })
})

describe("ConsoleEmailProvider", () => {
  it("stores sent messages and resolves", async () => {
    const provider = new ConsoleEmailProvider()

    await provider.send({
      to: "alice@test.com",
      subject: "Hello",
      html: "<p>Hi Alice</p>",
    })

    expect(provider.sent).toHaveLength(1)
    expect(provider.sent[0].to).toBe("alice@test.com")
    expect(provider.sent[0].subject).toBe("Hello")
    expect(provider.sent[0].html).toBe("<p>Hi Alice</p>")
  })

  it("accumulates multiple messages", async () => {
    const provider = new ConsoleEmailProvider()

    await provider.send({ to: "a@test.com", subject: "1", html: "1" })
    await provider.send({ to: "b@test.com", subject: "2", html: "2" })
    await provider.send({ to: "c@test.com", subject: "3", html: "3" })

    expect(provider.sent).toHaveLength(3)
    expect(provider.sent.map((m) => m.to)).toEqual(["a@test.com", "b@test.com", "c@test.com"])
  })

  it("preserves optional fields", async () => {
    const provider = new ConsoleEmailProvider()

    await provider.send({
      to: "alice@test.com",
      subject: "Test",
      html: "<p>Hi</p>",
      text: "Hi",
      replyTo: "support@test.com",
    })

    expect(provider.sent[0].text).toBe("Hi")
    expect(provider.sent[0].replyTo).toBe("support@test.com")
  })

  it("verify always returns true", async () => {
    const provider = new ConsoleEmailProvider()
    expect(await provider.verify()).toBe(true)
  })
})

describe("SmtpEmailProvider", () => {
  it("constructs with correct config", () => {
    const provider = new SmtpEmailProvider({
      host: "smtp.test.com",
      port: 587,
      user: "user",
      pass: "pass",
      from: "noreply@test.com",
    })
    expect(provider).toBeDefined()
  })

  it("defaults secure to true for port 465", () => {
    // Just verify construction doesn't throw — actual SMTP connection not tested here
    const provider = new SmtpEmailProvider({
      host: "smtp.test.com",
      port: 465,
      user: "user",
      pass: "pass",
      from: "noreply@test.com",
    })
    expect(provider).toBeDefined()
  })

  it("verify returns false when SMTP unreachable", async () => {
    const provider = new SmtpEmailProvider({
      host: "localhost",
      port: 19999, // nothing listening
      user: "",
      pass: "",
      from: "test@test.com",
    })

    const result = await provider.verify()
    expect(result).toBe(false)
  })
})

describe("getEmailProvider / setEmailProvider", () => {
  const original = getEmailProvider()

  afterAll(() => {
    setEmailProvider(original)
  })

  it("returns the same instance on multiple calls", () => {
    const a = getEmailProvider()
    const b = getEmailProvider()
    expect(a).toBe(b)
  })

  it("setEmailProvider overrides the singleton", () => {
    const custom = new ConsoleEmailProvider()
    setEmailProvider(custom)
    expect(getEmailProvider()).toBe(custom)
  })

  it("console provider is used when no SMTP is configured", () => {
    // In test env SMTP_HOST is not set, so initEmailProvider returns ConsoleEmailProvider
    setEmailProvider(null as any)
    const provider = initEmailProvider()
    expect(provider).toBeInstanceOf(ConsoleEmailProvider)
  })
})

// --- Real SMTP integration tests using an in-process SMTP server ---

describe("SmtpEmailProvider — real SMTP", () => {
  const TEST_SMTP_PORT = 2525
  let smtpServer: SMTPServer
  let received: Array<{ from: string; to: string[]; subject: string; text: string; html: string }>

  beforeAll(async () => {
    received = []
    smtpServer = new SMTPServer({
      authOptional: true,
      disabledCommands: ["STARTTLS"],
      onData(stream, session, callback) {
        simpleParser(stream).then((mail) => {
          received.push({
            from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
            to: session.envelope.rcptTo.map((r) => r.address),
            subject: mail.subject ?? "",
            text: typeof mail.text === "string" ? mail.text : "",
            html: typeof mail.html === "string" ? mail.html : "",
          })
          callback()
        })
      },
    })
    await new Promise<void>((resolve) => smtpServer.listen(TEST_SMTP_PORT, resolve))
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => smtpServer.close(() => resolve()))
  })

  beforeEach(() => {
    received.length = 0
  })

  it("sends a real email through SMTP and it is received", async () => {
    const provider = new SmtpEmailProvider({
      host: "127.0.0.1",
      port: TEST_SMTP_PORT,
      user: "",
      pass: "",
      from: "noreply@liaison.test",
    })

    await provider.send({
      to: "alice@example.com",
      subject: "Password Reset",
      html: "<p>Click <a href='http://localhost/reset?token=abc123'>here</a> to reset.</p>",
      text: "Reset your password: http://localhost/reset?token=abc123",
    })

    expect(received).toHaveLength(1)
    expect(received[0].from).toBe("noreply@liaison.test")
    expect(received[0].to).toEqual(["alice@example.com"])
    expect(received[0].subject).toBe("Password Reset")
    expect(received[0].text).toContain("reset?token=abc123")
    expect(received[0].html).toContain("reset?token=abc123")
  })

  it("sends multiple emails to different recipients", async () => {
    const provider = new SmtpEmailProvider({
      host: "127.0.0.1",
      port: TEST_SMTP_PORT,
      user: "",
      pass: "",
      from: "noreply@liaison.test",
    })

    await provider.send({
      to: "bob@example.com",
      subject: "Invite to Acme Corp",
      html: "<p>You've been invited to <strong>Acme Corp</strong>.</p>",
      text: "You've been invited to Acme Corp.",
    })

    await provider.send({
      to: "carol@example.com",
      subject: "Invite to Acme Corp",
      html: "<p>You've been invited to <strong>Acme Corp</strong>.</p>",
      text: "You've been invited to Acme Corp.",
    })

    expect(received).toHaveLength(2)
    expect(received[0].to).toEqual(["bob@example.com"])
    expect(received[1].to).toEqual(["carol@example.com"])
  })

  it("preserves replyTo header", async () => {
    const provider = new SmtpEmailProvider({
      host: "127.0.0.1",
      port: TEST_SMTP_PORT,
      user: "",
      pass: "",
      from: "noreply@liaison.test",
    })

    await provider.send({
      to: "dave@example.com",
      subject: "Support reply",
      html: "<p>Reply to this ticket.</p>",
      replyTo: "ticket-42@support.liaison.test",
    })

    expect(received).toHaveLength(1)
    expect(received[0].to).toEqual(["dave@example.com"])
  })

  it("verify returns true when SMTP is reachable", async () => {
    const provider = new SmtpEmailProvider({
      host: "127.0.0.1",
      port: TEST_SMTP_PORT,
      user: "",
      pass: "",
      from: "noreply@liaison.test",
    })

    const result = await provider.verify()
    expect(result).toBe(true)
  })

  it("send throws when SMTP server is down", async () => {
    const provider = new SmtpEmailProvider({
      host: "127.0.0.1",
      port: 19998, // nothing listening
      user: "",
      pass: "",
      from: "noreply@liaison.test",
    })

    expect(
      provider.send({ to: "fail@test.com", subject: "Fail", html: "<p>fail</p>" }),
    ).rejects.toThrow()
  })
})

describe("Fix #17: escapeHtml prevents XSS in email templates", () => {
  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;",
    )
  })

  it("escapes ampersands", () => {
    expect(escapeHtml("A & B")).toBe("A &amp; B")
  })

  it("escapes double quotes", () => {
    expect(escapeHtml('He said "hello"')).toBe("He said &quot;hello&quot;")
  })

  it("passes through safe strings unchanged", () => {
    expect(escapeHtml("Acme Corp")).toBe("Acme Corp")
  })

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("")
  })
})

describe("system email channel (getSystemEmailProvider)", () => {
  // In the test env SYSTEM_RESEND_API_KEY is unset, so the system channel falls
  // through to the default provider unless a provider is explicitly injected.
  afterEach(() => {
    setSystemEmailProvider(null)
  })

  it("inherits the default provider when no system provider is configured", () => {
    const def = new ConsoleEmailProvider()
    setEmailProvider(def)
    setSystemEmailProvider(null)
    expect(getSystemEmailProvider()).toBe(def)
  })

  it("an injected system provider overrides the channel without changing the default", () => {
    const def = new ConsoleEmailProvider()
    const sys = new ConsoleEmailProvider()
    setEmailProvider(def)
    setSystemEmailProvider(sys)
    expect(getSystemEmailProvider()).toBe(sys)
    // The default channel (customer/app mail incl. CSAT) is unaffected.
    expect(getEmailProvider()).toBe(def)
  })

  it("routes a system send only to the system provider, leaving the default sink untouched", async () => {
    const def = new ConsoleEmailProvider()
    const sys = new ConsoleEmailProvider()
    setEmailProvider(def)
    setSystemEmailProvider(sys)
    await getSystemEmailProvider().send({
      to: "team@test.com",
      subject: "Your sign-in code",
      html: "<p>123456</p>",
    })
    expect(sys.sent).toHaveLength(1)
    expect(sys.sent[0].to).toBe("team@test.com")
    expect(def.sent).toHaveLength(0)
  })

  describe("system sender (SYSTEM_EMAIL_FROM)", () => {
    const saved = { system: env.SYSTEM_EMAIL_FROM, from: env.EMAIL_FROM }
    afterEach(() => {
      env.SYSTEM_EMAIL_FROM = saved.system
      env.EMAIL_FROM = saved.from
    })

    it("stamps the system sender on system mail when it is set", async () => {
      env.EMAIL_FROM = "Acme Support <noreply@acme.test>"
      env.SYSTEM_EMAIL_FROM = "Liaison Acme <noreply@acme.test>"
      const def = new ConsoleEmailProvider()
      setEmailProvider(def)
      await getSystemEmailProvider().send({
        to: "team@test.com",
        subject: "Code",
        html: "<p>1</p>",
      })
      expect(def.sent[0].from).toBe("Liaison Acme <noreply@acme.test>")
    })

    it("leaves customer mail on the default channel with its own sender", async () => {
      env.SYSTEM_EMAIL_FROM = "Liaison Acme <noreply@acme.test>"
      const def = new ConsoleEmailProvider()
      setEmailProvider(def)
      await getEmailProvider().send({ to: "customer@test.com", subject: "CSAT", html: "<p>1</p>" })
      expect(def.sent[0].from).toBeUndefined()
    })

    it("keeps an explicit per-message From", async () => {
      env.SYSTEM_EMAIL_FROM = "Liaison Acme <noreply@acme.test>"
      const def = new ConsoleEmailProvider()
      setEmailProvider(def)
      await getSystemEmailProvider().send({
        to: "team@test.com",
        subject: "Code",
        html: "<p>1</p>",
        from: "Org Identity <id@acme.test>",
      })
      expect(def.sent[0].from).toBe("Org Identity <id@acme.test>")
    })

    it("falls back to EMAIL_FROM when unset", () => {
      env.EMAIL_FROM = "Acme Support <noreply@acme.test>"
      env.SYSTEM_EMAIL_FROM = ""
      expect(systemEmailFrom()).toBe("Acme Support <noreply@acme.test>")
    })
  })
})

// Live walk 2026-10-24: the demo box logged "Email sent (resend)" with the subject, and the code
// mail's subject is "NNNNNN is your Liaison demo code", so anyone reading the logs held live
// sign-in codes. Every provider now logs the template id and the recipient's domain, nothing else.
describe("a send's log line carries no code, link, token or address", () => {
  const CODE = "482913"
  const LINK = "https://liaison.example/auth/magic?token=tok_live_7f3a9c"
  const message = {
    to: "Visitor.Person@Example.ORG",
    subject: `${CODE} is your Liaison sign-in code`,
    html: `<p>${CODE}</p><a href="${LINK}">Sign in</a>`,
    text: `Enter ${CODE} or open ${LINK}`,
    template: "auth.sign-in-code" as const,
  }

  async function logLinesOf(send: () => Promise<unknown>): Promise<string[]> {
    const { rootLogger } = await import("~/lib/logger")
    const proto = Object.getPrototypeOf(rootLogger.child({ service: "email" }))
    const lines: string[] = []
    const spies = (["trace", "debug", "info", "warn", "error", "fatal"] as const).map((level) => {
      const spy = spyOn(proto, level)
      spy.mockImplementation(function (this: unknown, ...args: unknown[]) {
        lines.push(JSON.stringify(args))
      })
      return spy
    })
    try {
      await send().catch(() => undefined)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    return lines
  }

  function expectClean(lines: string[]) {
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line).not.toContain(CODE)
      expect(line).not.toContain("tok_live_7f3a9c")
      expect(line.toLowerCase()).not.toContain("visitor.person")
      expect(line).not.toContain("sign-in code")
    }
    expect(lines.some((l) => l.includes('"template":"auth.sign-in-code"'))).toBe(true)
    expect(lines.some((l) => l.includes('"toDomain":"example.org"'))).toBe(true)
  }

  it("resend", async () => {
    const provider = new ResendEmailProvider({
      apiKey: "re_test",
      from: "Liaison <noreply@example.com>",
      fetch: async () => new Response(JSON.stringify({ id: "m1" }), { status: 200 }),
    })
    expectClean(await logLinesOf(() => provider.send(message)))
  })

  it("console without the operator's body opt-in", async () => {
    expectClean(await logLinesOf(() => new ConsoleEmailProvider(false).send(message)))
  })

  it("the demo refusal and the demo capture", async () => {
    expectClean(await logLinesOf(() => new DemoRefusingEmailProvider().send(message)))
    expectClean(await logLinesOf(() => new CapturedDemoMailProvider().send(message)))
  })

  it("the recipient domain is lowercased and never the local part", () => {
    expect(recipientDomain("A.B@Sub.Example.COM")).toBe("sub.example.com")
    expect(recipientDomain("no-at-sign")).toBe("unknown")
  })
})
