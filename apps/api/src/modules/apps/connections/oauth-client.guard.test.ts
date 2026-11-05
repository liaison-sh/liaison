// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Drift guard: no app connection picks its OAuth client outside the one resolver
// (modules/apps/connections/oauth-client.ts). A module that reads an instance
// client from the environment, an org client from `oauth_providers` or the org's
// Google setting, or calls an app's own client resolver, would decide "org, then
// instance" on its own, and the guides, setup state and cards would describe a
// client the flow does not use. Each reviewed exception says why it is not a
// connection picking its client.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { LIAISON_ROOT, serverSourceFiles } from "../../../../test-support/security/enumerate"

const RESOLVER = "apps/api/src/modules/apps/connections/oauth-client.ts"

interface Rule {
  name: string
  pattern: RegExp
  /** file → why it may match. The resolver itself always may. */
  allowed: Record<string, string>
}

const INSTANCE_ENV =
  "(GMAIL_OAUTH_CLIENT|GOOGLE_DRIVE_OAUTH_CLIENT|GOOGLE_MARKETING_OAUTH_CLIENT|SHOPIFY_APP_CLIENT)_(ID|SECRET)"

const RULES: Rule[] = [
  {
    name: "reads an instance client from the environment",
    // `env.X`, `process.env.X`, `currentEnv.X`, `process.env["X"]`: any property read.
    pattern: new RegExp(`(\\.\\s*${INSTANCE_ENV}\\b|\\[\\s*["'\`]${INSTANCE_ENV}["'\`]\\s*\\])`),
    allowed: {},
  },
  {
    name: "reads a stored client from kernel.oauth_providers",
    pattern: /oauthProviders\.(clientId|clientSecretEncrypted)\b/,
    allowed: {
      "apps/api/src/modules/secret-requests/stored.ts":
        "fingerprints a stored secret so the secret card can tell it was saved; picks no client",
      "apps/api/src/modules/auth/google-login-provider.ts":
        "keeps the Google sign-in provider row in step with the deployment's login client; sign-in, not a connection",
    },
  },
  {
    name: "reads the workspace's Google client setting",
    pattern: /google\s*\??\.\s*oauthClient\b/,
    allowed: {},
  },
  {
    name: "calls an app's own client resolver",
    pattern: /oauthClientResolverRegistry\s*\.\s*get\s*\(/,
    allowed: {
      "apps/api/src/modules/apps/connections/oauth-client-config.ts":
        "the flows' entry: an app resolver may refuse (Gmail off) before the one resolver runs",
      "apps/api/src/modules/apps/connections/oauth-client-provisioning.ts":
        "the connect dialog's status mirrors the flows' order exactly",
    },
  },
]

/** Strip comments so a doc line naming a variable is not a read. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
}

const files = serverSourceFiles().map((abs) => ({
  rel: path.relative(LIAISON_ROOT, abs).split(path.sep).join("/"),
  text: code(readFileSync(abs, "utf8")),
}))

describe("OAuth clients are picked only by the one resolver", () => {
  test("the scan sees the server source and the resolver", () => {
    expect(files.length).toBeGreaterThan(500)
    expect(files.some((f) => f.rel === RESOLVER)).toBe(true)
  })

  for (const rule of RULES) {
    test(`nothing outside the resolver ${rule.name}`, () => {
      const offenders = files
        .filter((f) => f.rel !== RESOLVER && !(f.rel in rule.allowed))
        .filter((f) => rule.pattern.test(f.text))
        .map((f) => f.rel)
      expect(offenders).toEqual([])
    })

    test(`every reviewed exception to "${rule.name}" still matches`, () => {
      const stale = Object.keys(rule.allowed).filter((rel) => {
        const f = files.find((x) => x.rel === rel)
        return !f || !rule.pattern.test(f.text)
      })
      expect(stale).toEqual([])
    })
  }

  test("the resolver reads every instance client it documents", () => {
    const resolver = files.find((f) => f.rel === RESOLVER)?.text ?? ""
    for (const name of [
      "GMAIL_OAUTH_CLIENT_ID",
      "GOOGLE_DRIVE_OAUTH_CLIENT_ID",
      "GOOGLE_MARKETING_OAUTH_CLIENT_ID",
      "SHOPIFY_APP_CLIENT_ID",
    ]) {
      expect(resolver).toContain(`"${name}"`)
    }
  })
})
