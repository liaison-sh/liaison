// SPDX-License-Identifier: FSL-1.1-ALv2
// A managed-edition server refuses to boot without each setting it depends on,
// and names the missing one. Raw process.env values, as the server sees them.
import { describe, expect, it } from "bun:test"
import { DEFAULT_LIAISON_TEAM_ENDPOINT } from "~/lib/env"
import {
  legacyControlPlaneBootProblem,
  managedBootProblems,
  managedBootRequired,
} from "~/lib/managed-boot"

const COMPLETE = {
  LIAISON_OPERATOR_ORG_ID: "00000000-0000-4000-8000-0000000c0001",
  LIAISON_ORG_HOST_TEMPLATE: "https://{slug}.example.test",
  LIAISON_TEAM_ENDPOINT: "https://control.example.test/hook",
  LIAISON_PAY_FRAME_ORIGIN: "https://pay.example.test",
  LIAISON_MANAGED_DEFAULT_MODELS: "deepseek/deepseek-v4.1-flash",
  RESEND_API_KEY: "re_test",
  OPENROUTER_API_KEY: "sk-or-test-cell",
}

/** Every platform key a managed cell must not hold, and a Gemini variable. */
const FORBIDDEN_KEYS = [
  "LIAISON_ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "MISTRAL_API_KEY",
  "EXA_API_KEY",
  "GEMINI_API_KEY",
  "GEMINI_ANYTHING",
] as const

describe("managedBootProblems", () => {
  it("passes with every setting and a registered identity", () => {
    expect(managedBootProblems(COMPLETE, "registered")).toEqual([])
  })

  it.each([
    "LIAISON_OPERATOR_ORG_ID",
    "LIAISON_ORG_HOST_TEMPLATE",
    "LIAISON_TEAM_ENDPOINT",
    "LIAISON_PAY_FRAME_ORIGIN",
    "LIAISON_MANAGED_DEFAULT_MODELS",
  ] as const)("refuses without %s, naming it", (name) => {
    for (const value of [undefined, "", "   "]) {
      const problems = managedBootProblems({ ...COMPLETE, [name]: value }, "registered")
      expect(problems.length).toBe(1)
      expect(problems[0]).toContain(name)
    }
  })

  it("refuses a pay frame origin that is not a bare https origin", () => {
    for (const value of [
      "http://pay.example.test",
      "https://pay.example.test/",
      "https://pay.example.test/frame",
      "pay.example.test",
      "https://pay.example.test?x=1",
    ]) {
      const problems = managedBootProblems(
        { ...COMPLETE, LIAISON_PAY_FRAME_ORIGIN: value },
        "registered",
      )
      expect({ value, problems: problems.length }).toEqual({ value, problems: 1 })
      expect(problems[0]).toContain("LIAISON_PAY_FRAME_ORIGIN")
    }
    expect(
      managedBootProblems(
        { ...COMPLETE, LIAISON_PAY_FRAME_ORIGIN: "https://pay.example.test:8443" },
        "registered",
      ),
    ).toEqual([])
  })

  it("refuses default models that are not vendor/model ids", () => {
    for (const value of ["deepseek", "a/b, c", "a/b,,with space/x"]) {
      const problems = managedBootProblems(
        { ...COMPLETE, LIAISON_MANAGED_DEFAULT_MODELS: value },
        "registered",
      )
      expect({ value, problems: problems.length }).toEqual({ value, problems: 1 })
      expect(problems[0]).toContain("LIAISON_MANAGED_DEFAULT_MODELS")
    }
    expect(
      managedBootProblems(
        {
          ...COMPLETE,
          LIAISON_MANAGED_DEFAULT_MODELS: "deepseek/deepseek-v4.1-flash, openai/gpt-x",
        },
        "registered",
      ),
    ).toEqual([])
  })

  it("refuses without a mail transport, and takes Resend or SMTP", () => {
    const { RESEND_API_KEY: _, ...noMail } = COMPLETE
    for (const value of [undefined, "", "  "]) {
      const problems = managedBootProblems({ ...noMail, RESEND_API_KEY: value }, "registered")
      expect(problems.length).toBe(1)
      expect(problems[0]).toContain("mail transport")
    }
    expect(
      managedBootProblems({ ...noMail, SMTP_HOST: "smtp.example.test" }, "registered"),
    ).toEqual([])
    expect(
      managedBootProblems(
        { ...noMail, RESEND_API_KEY: "re_x", EMAIL_FROM: "A <a@example.test>" },
        "registered",
      ),
    ).toEqual([])
  })

  it("refuses a host template without the {slug} placeholder", () => {
    const problems = managedBootProblems(
      { ...COMPLETE, LIAISON_ORG_HOST_TEMPLATE: "https://app.example.test" },
      "registered",
    )
    expect(problems.join()).toContain("LIAISON_ORG_HOST_TEMPLATE")
  })

  it("refuses the built-in default endpoint unless explicitly allowed", () => {
    const env = { ...COMPLETE, LIAISON_TEAM_ENDPOINT: DEFAULT_LIAISON_TEAM_ENDPOINT }
    expect(managedBootProblems(env, "registered").join()).toContain(
      "LIAISON_TEAM_ENDPOINT_ALLOW_DEFAULT",
    )
    expect(
      managedBootProblems(
        { ...env, LIAISON_TEAM_ENDPOINT: `${DEFAULT_LIAISON_TEAM_ENDPOINT}/` },
        "registered",
      ).length,
    ).toBe(1)
    expect(
      managedBootProblems({ ...env, LIAISON_TEAM_ENDPOINT_ALLOW_DEFAULT: "1" }, "registered"),
    ).toEqual([])
  })

  it.each([
    ["missing", "no liaison team identity"],
    ["pending", "not installed"],
    ["unreadable", "does not decrypt"],
    ["retiring", "retiring"],
  ] as const)("refuses an identity that is %s", (state, words) => {
    const problems = managedBootProblems(COMPLETE, state)
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain("liaison team identity")
    expect(problems[0]).toContain(words)
  })

  it("lists every problem at once", () => {
    expect(managedBootProblems({}, "missing").length).toBe(8)
  })

  // S31: every AI call of a managed cell goes through OpenRouter.
  it("refuses without OPENROUTER_API_KEY, naming it", () => {
    for (const value of [undefined, "", "   "]) {
      const problems = managedBootProblems({ ...COMPLETE, OPENROUTER_API_KEY: value }, "registered")
      expect(problems.length).toBe(1)
      expect(problems[0]).toContain("OPENROUTER_API_KEY")
    }
  })

  it.each(FORBIDDEN_KEYS)("refuses %s when it is set, naming it", (name) => {
    const problems = managedBootProblems({ ...COMPLETE, [name]: "a-key" }, "registered")
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain(name)
    // Set but blank is not a key.
    expect(managedBootProblems({ ...COMPLETE, [name]: "  " }, "registered")).toEqual([])
  })

  it("names every forbidden key that is set, in one problem", () => {
    const all = Object.fromEntries(FORBIDDEN_KEYS.map((k) => [k, "x"]))
    const problems = managedBootProblems({ ...COMPLETE, ...all }, "registered")
    expect(problems.length).toBe(1)
    for (const name of FORBIDDEN_KEYS) expect(problems[0]).toContain(name)
  })

  // S30: a cell's Gmail push topic delivers to /webhooks/_cell/gmail-push with
  // an OIDC token whose audience and service account the cell must know.
  describe("Gmail push on a cell", () => {
    const PUSH = {
      GMAIL_PUBSUB_TOPIC: "projects/example/topics/gmail-push-cell-a",
      GMAIL_PUSH_AUDIENCE: "https://cell-a.example.test/webhooks/_cell/gmail-push",
      GMAIL_PUSH_SERVICE_ACCOUNT: "gmail-push-cell-a@example.iam.gserviceaccount.com",
    }
    it("boots with the topic, its audience and its service account, and without any of them", () => {
      expect(managedBootProblems({ ...COMPLETE, ...PUSH }, "registered")).toEqual([])
      expect(managedBootProblems(COMPLETE, "registered")).toEqual([])
    })
    it.each(["GMAIL_PUSH_AUDIENCE", "GMAIL_PUSH_SERVICE_ACCOUNT"] as const)(
      "refuses a topic without %s, naming it",
      (name) => {
        for (const value of [undefined, "", "  "]) {
          const problems = managedBootProblems(
            { ...COMPLETE, ...PUSH, [name]: value },
            "registered",
          )
          expect(problems.length).toBe(1)
          expect(problems[0]).toContain(name)
        }
      },
    )
    it("refuses an audience that is not an https URL and a service account that is not an address", () => {
      const a = managedBootProblems(
        { ...COMPLETE, ...PUSH, GMAIL_PUSH_AUDIENCE: "http://cell-a.example.test/x" },
        "registered",
      )
      expect(a.length).toBe(1)
      expect(a[0]).toContain("GMAIL_PUSH_AUDIENCE")
      const s = managedBootProblems(
        { ...COMPLETE, ...PUSH, GMAIL_PUSH_SERVICE_ACCOUNT: "not-an-address" },
        "registered",
      )
      expect(s.length).toBe(1)
      expect(s[0]).toContain("GMAIL_PUSH_SERVICE_ACCOUNT")
    })
  })

  it("OAuth client variables are not keys: a cell with them boots", () => {
    expect(
      managedBootProblems(
        {
          ...COMPLETE,
          GOOGLE_OAUTH_CLIENT_ID: "client.apps.example.test",
          GOOGLE_OAUTH_CLIENT_SECRET: "secret",
        },
        "registered",
      ),
    ).toEqual([])
  })
})

describe("managedBootRequired", () => {
  it("applies to LIAISON_EDITION=managed", () => {
    expect(managedBootRequired({ LIAISON_EDITION: "managed" })).toBe(true)
  })
  it("not to the legacy control-plane pair alone (that server refuses to boot instead)", () => {
    expect(
      managedBootRequired({
        NODE_ENV: "production",
        CONTROL_PLANE_URL: "https://cp.example",
        CONTROL_PLANE_API_KEY: "k",
      }),
    ).toBe(false)
  })
  it("not to a self-hosted server", () => {
    expect(managedBootRequired({})).toBe(false)
    expect(managedBootRequired({ LIAISON_EDITION: "self_hosted" })).toBe(false)
  })
  it("a self-hosted server holding every provider key boots: the key guard is managed only (S19)", () => {
    const all = Object.fromEntries(FORBIDDEN_KEYS.map((k) => [k, "x"]))
    expect(managedBootRequired(all)).toBe(false)
    expect(managedBootRequired({ ...all, LIAISON_EDITION: "self_hosted" })).toBe(false)
  })
})

describe("legacyControlPlaneBootProblem", () => {
  const pair = { CONTROL_PLANE_URL: "https://cp.example", CONTROL_PLANE_API_KEY: "k" }
  it("the legacy pair alone refuses to boot and says what to set", () => {
    const problem = legacyControlPlaneBootProblem({ NODE_ENV: "production", ...pair })
    expect(problem).toContain("LIAISON_EDITION=managed")
    expect(problem).toContain("CONTROL_PLANE_URL")
  })
  it("an explicit edition, or no pair, boots", () => {
    expect(legacyControlPlaneBootProblem({ ...pair, LIAISON_EDITION: "managed" })).toBeNull()
    expect(legacyControlPlaneBootProblem({ ...pair, LIAISON_EDITION: "self_hosted" })).toBeNull()
    expect(legacyControlPlaneBootProblem({})).toBeNull()
    expect(
      legacyControlPlaneBootProblem({ CONTROL_PLANE_URL: " ", CONTROL_PLANE_API_KEY: "" }),
    ).toBeNull()
  })
})
