// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a config tool accepts: the CLI schema of its section minus every secret
// (a secret comes from the secret card, never a tool param) and minus every
// field that reads the server's disk (an uploaded file id instead). What it
// returns: the runner's report without invite links or API keys.
import { describe, expect, spyOn, test } from "bun:test"
import * as parse from "~/cli/config/parse"
import { requiredScopesFor } from "~/modules/provisioning/config-section-scopes"
import type { ConfigReport } from "~/modules/provisioning/config-sections"
import {
  type ConfigToolSection,
  parseSectionInput,
  stripSecretsFromResult,
} from "~/modules/provisioning/config-tool-input"

const ORG = { slug: "acme", name: "Acme" }
const IMAP = {
  email: "desk@acme.example",
  imapHost: "imap.acme.example",
  imapPort: 993,
  smtpHost: "smtp.acme.example",
  smtpPort: 587,
  username: "desk@acme.example",
}

describe("secret fields are refused with a message naming request_secret", () => {
  const rows: Array<{ section: ConfigToolSection; data: unknown; path: string; message?: string }> =
    [
      {
        section: "users",
        data: [{ email: "a@acme.example", name: "A", role: "member", password: "pw" }],
        path: "users[0].password",
      },
      {
        section: "users",
        data: [{ email: "a@acme.example", name: "A", role: "member", mode: "create" }],
        path: "users[0].mode",
        message:
          "users[0].mode create needs a password, which is a secret: invite the person instead",
      },
      {
        section: "mail",
        data: {
          mailboxes: [
            { address: "a@acme.example", provider: "imap", imap: { ...IMAP, password: "s" } },
          ],
        },
        path: "mail.mailboxes[0].imap.password",
      },
      {
        section: "mail",
        data: {
          mailboxes: [
            {
              address: "a@acme.example",
              provider: "gmail",
              google: { clientId: "id", clientSecret: "s" },
            },
          ],
        },
        path: "mail.mailboxes[0].google.clientSecret",
      },
      {
        section: "tickets",
        data: {
          inboxes: [
            { address: "d@acme.example", provider: "imap", imap: { ...IMAP, password: "s" } },
          ],
        },
        path: "tickets.inboxes[0].imap.password",
      },
      {
        section: "tickets",
        data: {
          inboxes: [
            {
              address: "d@acme.example",
              provider: "gmail",
              google: { clientId: "id", clientSecret: "s" },
            },
          ],
        },
        path: "tickets.inboxes[0].google.clientSecret",
      },
      {
        section: "apps",
        data: [
          { name: "boxtal", enable: true, connection: { name: "api", credentials: { k: "v" } } },
        ],
        path: "apps[0].connection.credentials",
      },
      {
        section: "apps",
        data: [
          {
            name: "shopify",
            enable: true,
            connection: { name: "shop", oauthClient: { clientId: "id", clientSecret: "s" } },
          },
        ],
        path: "apps[0].connection.oauthClient.clientSecret",
      },
      {
        section: "apiConnectors",
        data: [
          {
            identifier: "crm",
            adapter: { name: "CRM" },
            credentials: { apiKey: "k" },
          },
        ],
        path: "apiConnectors[0].credentials",
      },
    ]
  for (const row of rows) {
    test(row.path, () => {
      const r = parseSectionInput(row.section, row.data, ORG)
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error).toContain(
        row.message ?? `${row.path} is a secret: ask for it with request_secret`,
      )
    })
  }
})

describe("fields that read the server's disk are refused with the file-id replacement", () => {
  const rows: Array<{ section: ConfigToolSection; data: unknown; message: string }> = [
    {
      section: "knowledge",
      data: { documents: [{ title: "T", collection: "C", contentFile: "./t.md" }] },
      message:
        "knowledge.documents[0].contentFile reads the server's disk: upload the file and pass contentFileId",
    },
    {
      section: "knowledge",
      data: { documents: [{ dir: "./docs", collection: "C" }] },
      message:
        "knowledge.documents[0].dir reads the server's disk: upload the file and pass contentFileId",
    },
    {
      section: "invoicing",
      data: { issuerProfiles: [{ legalName: "Acme", country: "FR", logoPath: "./logo.png" }] },
      message:
        "invoicing.issuerProfiles[0].logoPath reads the server's disk: upload the file and pass logoFileId",
    },
    {
      section: "apiConnectors",
      data: [{ identifier: "crm", adapter: "./crm.adapter.yaml" }],
      message: "apiConnectors[0].adapter reads the server's disk: pass the adapter document inline",
    },
  ]
  for (const row of rows) {
    test(row.message.split(" ")[0] ?? "", () => {
      const r = parseSectionInput(row.section, row.data, ORG)
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error).toContain(row.message)
    })
  }
})

// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${VAR} config reference, never a JS template.
const ENV_REF = "${CONFIG_TOOL_TEST_VAR}"

describe("accepted input", () => {
  test("an env reference inside inline knowledge content is kept verbatim, never interpolated", () => {
    const parseSpy = spyOn(parse, "parseConfigFile")
    const interpolateSpy = spyOn(parse, "interpolateEnv")
    process.env.CONFIG_TOOL_TEST_VAR = "leaked"
    try {
      const r = parseSectionInput(
        "knowledge",
        {
          collections: [{ name: "Policies" }],
          documents: [{ title: "Env", collection: "Policies", content: `Set ${ENV_REF}.` }],
        },
        ORG,
      )
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const doc = r.config.knowledge?.documents?.[0]
      expect(doc && "content" in doc ? doc.content : null).toBe(`Set ${ENV_REF}.`)
      expect(parseSpy).not.toHaveBeenCalled()
      expect(interpolateSpy).not.toHaveBeenCalled()
    } finally {
      delete process.env.CONFIG_TOOL_TEST_VAR
      parseSpy.mockRestore()
      interpolateSpy.mockRestore()
    }
  })

  test("a mailbox without its password becomes a tool-path entry with an empty secret", () => {
    const r = parseSectionInput(
      "mail",
      { mailboxes: [{ address: "a@acme.example", provider: "imap", imap: IMAP }] },
      ORG,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.mail?.mailboxes?.[0]?.imap?.password).toBe("")
    expect(r.config.org).toEqual(ORG)
  })

  // Walk 4: the approval card read "personal, owner …" while the password card
  // connected the mailbox as the organization's. The secret card can only
  // connect a shared mailbox, so the tool path refuses a personal one.
  test("a personal IMAP mailbox is refused on the tool path, naming where its owner connects it", () => {
    const r = parseSectionInput(
      "mail",
      {
        mailboxes: [
          { address: "a@acme.example", provider: "imap", owner: "a@acme.example", imap: IMAP },
        ],
      },
      ORG,
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/owner/)
    expect(r.error).toContain("Settings > Mail")
    // A personal Gmail is connected on its owner's consent card, never the CLI.
    expect(r.error).toContain("oauth_connect")
  })

  test("an unknown key in any section entry is refused, never dropped", () => {
    const rows: Array<[ConfigToolSection, unknown, RegExp]> = [
      ["roles", [{ name: "Ops", scopes: [], colour: "red" }], /^roles\[0\]/],
      ["email", { from: "a@acme.example", sender: "x" }, /^email/],
      ["agents", [{ handle: "@ops", displayName: "Ops", x: 1 }], /^agents\[0\]/],
      [
        "knowledge",
        { collections: [{ name: "C", colour: "red" }] },
        /^knowledge\.collections\[0\]/,
      ],
      [
        "knowledge",
        { sources: [{ type: "folder", app: "google-drive", path: "/x", depth: 2 }] },
        /^knowledge\.sources\[0\]/,
      ],
      [
        "invoicing",
        {
          taxRegimes: [
            { issuerCountry: "FR", treatment: "domestic", defaultRateBp: 2000, rate: 1 },
          ],
        },
        /^invoicing\.taxRegimes\[0\]/,
      ],
      ["invoicing", { hsCodes: [{ code: "9207", note: "x" }] }, /^invoicing\.hsCodes\[0\]/],
    ]
    for (const [section, data, path] of rows) {
      const r = parseSectionInput(section, data, ORG)
      expect(r.ok).toBe(false)
      if (r.ok) continue
      expect(r.error).toMatch(path)
    }
  })
})

describe("results never carry an invite link or an API key", () => {
  test("inviteUrl and key are stripped", () => {
    const report: ConfigReport = {
      ok: true,
      sections: {
        users: {
          users: [
            { email: "a@acme.example", mode: "invite", invited: true, inviteUrl: "https://x/t" },
          ],
        },
        apiKeys: { keys: [{ label: "ci", key: "lsk_secret" }] },
      },
      pending: [],
      changed: ["users.a@acme.example"],
      unchanged: [],
    }
    const out = JSON.stringify(stripSecretsFromResult(report))
    expect(out).not.toContain("inviteUrl")
    expect(out).not.toContain("https://x/t")
    expect(out).not.toContain("lsk_secret")
    expect(out).toContain("a@acme.example")
  })
})

describe("required scopes include what a role change would revoke", () => {
  test("a scope the stored role holds and the change drops is required", () => {
    const r = parseSectionInput("roles", [{ name: "Ops", scopes: ["kernel:threads:read"] }], ORG)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const stored = new Map([["Ops", new Set(["kernel:threads:read", "shopify:orders:admin"])]])
    expect(
      [...requiredScopesFor("org-1", "roles", r.config, { storedRoleScopes: stored })].sort(),
    ).toEqual(["kernel:roles:admin", "kernel:threads:read", "shopify:orders:admin"])
  })
})

describe("required scopes per section and entry", () => {
  const rows: Array<{ section: ConfigToolSection; data: unknown; scopes: string[] }> = [
    { section: "roles", data: [], scopes: ["kernel:roles:admin"] },
    {
      section: "roles",
      data: [{ name: "Ops", scopes: ["shopify:orders:admin", "kernel:threads:read"] }],
      scopes: ["kernel:roles:admin", "shopify:orders:admin", "kernel:threads:read"],
    },
    { section: "users", data: [], scopes: ["kernel:users:admin"] },
    { section: "email", data: { from: "a@acme.example" }, scopes: ["kernel:org:admin"] },
    { section: "agents", data: [], scopes: ["kernel:agents:admin"] },
    { section: "invoicing", data: {}, scopes: ["invoicing:settings:write"] },
    { section: "apiConnectors", data: [], scopes: ["api-connector:admin"] },
    { section: "mail", data: { mailboxes: [] }, scopes: ["mail:accounts:admin"] },
    {
      section: "mail",
      data: {
        mailboxes: [
          {
            address: "a@acme.example",
            provider: "gmail",
            google: { clientId: "id.apps.googleusercontent.com" },
          },
        ],
      },
      scopes: ["mail:accounts:admin", "kernel:apps:admin"],
    },
    {
      section: "tickets",
      data: { inboxes: [{ address: "d@acme.example", provider: "imap", imap: IMAP }] },
      scopes: ["tickets:inboxes:admin", "tickets:accounts:admin"],
    },
    {
      section: "tickets",
      data: { approveRepliesFromHome: true },
      scopes: ["tickets:settings:admin"],
    },
    { section: "apps", data: [{ name: "projects", enable: true }], scopes: ["kernel:apps:admin"] },
    {
      section: "apps",
      data: [{ name: "boxtal", enable: true, connection: { name: "api" } }],
      scopes: ["kernel:apps:admin", "boxtal:accounts:admin"],
    },
    {
      section: "apps",
      data: [{ name: "mail", enable: true, providers: { gmail: { enabled: true } } }],
      scopes: ["kernel:apps:admin", "mail:accounts:admin"],
    },
    {
      section: "knowledge",
      data: { documents: [{ title: "T", collection: "C", content: "x" }] },
      scopes: ["knowledge:documents:create"],
    },
    {
      section: "knowledge",
      data: { collections: [{ name: "C" }] },
      scopes: ["knowledge:collections:manage"],
    },
    {
      section: "knowledge",
      data: { sources: [{ type: "folder", app: "google-drive", path: "/x" }] },
      scopes: ["knowledge:sources:manage"],
    },
  ]
  for (const row of rows) {
    test(`${row.section}: ${row.scopes.join(" + ")}`, () => {
      const r = parseSectionInput(row.section, row.data, ORG)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect([...requiredScopesFor("org-1", row.section, r.config)].sort()).toEqual(
        [...row.scopes].sort(),
      )
    })
  }
})
