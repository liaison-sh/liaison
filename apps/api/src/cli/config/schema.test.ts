// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  imapCredentialFieldNames,
  LEGACY_MAILBOXES_MESSAGE,
  validateConfig,
} from "~/cli/config/schema"

const IMAP = {
  email: "s@x.com",
  imapHost: "imap.x.com",
  imapPort: 993,
  smtpHost: "smtp.x.com",
  smtpPort: 587,
  username: "s@x.com",
  password: "p",
}

describe("validateConfig", () => {
  test("minimal { org: { slug, name } } validates", () => {
    const res = validateConfig({ org: { slug: "fabrikam", name: "Fabrikam" } })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error(res.message)
    expect(res.config.org.slug).toBe("fabrikam")
    expect(res.config.org.name).toBe("Fabrikam")
  })

  test("missing org → code 2", () => {
    const res = validateConfig({ admin: { email: "a@b.com", name: "A", password: "x" } })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected failure")
    expect(res.code).toBe(2)
    expect(res.message).toContain("org")
  })

  test("mode:create without password → code 2", () => {
    const res = validateConfig({
      org: { slug: "o", name: "O" },
      users: [{ email: "u@x.com", name: "U", role: "member", mode: "create" }],
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected failure")
    expect(res.code).toBe(2)
    expect(res.message.toLowerCase()).toContain("password")
  })

  test("mode:create with password is accepted", () => {
    const res = validateConfig({
      org: { slug: "o", name: "O" },
      users: [
        { email: "u@x.com", name: "U", role: "member", mode: "create", password: "secret123" },
      ],
    })
    expect(res.ok).toBe(true)
  })

  test("mode:invite without password is accepted", () => {
    const res = validateConfig({
      org: { slug: "o", name: "O" },
      users: [{ email: "u@x.com", name: "U", role: "member", mode: "invite" }],
    })
    expect(res.ok).toBe(true)
  })

  test("the removed top-level mailboxes key fails with guidance naming both new sections", () => {
    const res = validateConfig({
      org: { slug: "o", name: "O" },
      mailboxes: [
        {
          address: "support@x.com",
          provider: "gmail",
          inbox: { default: true, name: "Support" },
        },
      ],
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected failure")
    expect(res.code).toBe(2)
    expect(res.message).toBe(LEGACY_MAILBOXES_MESSAGE)
    expect(res.message).toContain("tickets.inboxes")
    expect(res.message).toContain("mail.mailboxes")
  })

  test("tickets.inboxes imap entry with settings validates", () => {
    const res = validateConfig({
      org: { slug: "o", name: "O" },
      tickets: {
        inboxes: [
          {
            address: "s@x.com",
            provider: "imap",
            imap: IMAP,
            name: "Support",
            fromDisplayName: "X Support",
            defaultTeam: "Desk",
            default: true,
          },
        ],
      },
    })
    expect(res.ok).toBe(true)
  })

  test("tickets.inboxes imap entry missing an imap field -> code 2", () => {
    const { imapHost: _drop, ...partial } = IMAP
    const res = validateConfig({
      org: { slug: "o", name: "O" },
      tickets: { inboxes: [{ address: "s@x.com", provider: "imap", imap: partial }] },
    })
    expect(res.ok).toBe(false)
  })

  test("tickets.inboxes rejects the old nested inbox block", () => {
    const res = validateConfig({
      org: { slug: "o", name: "O" },
      tickets: {
        inboxes: [{ address: "s@x.com", provider: "gmail", inbox: { name: "Support" } }],
      },
    })
    expect(res.ok).toBe(false)
  })

  test("tickets.inboxes: two default inboxes -> code 2", () => {
    const res = validateConfig({
      org: { slug: "o", name: "O" },
      tickets: {
        inboxes: [
          { address: "a@x.com", provider: "gmail", default: true },
          { address: "b@x.com", provider: "gmail", default: true },
        ],
      },
    })
    expect(res.ok).toBe(false)
  })

  test("two IMAP entries for the same owner are refused (the second would replace the first)", () => {
    const tickets = validateConfig({
      org: { slug: "o", name: "O" },
      tickets: {
        inboxes: [
          { address: "a@x.com", provider: "imap", imap: IMAP },
          { address: "b@x.com", provider: "imap", imap: IMAP },
        ],
      },
    })
    expect(tickets.ok).toBe(false)
    const mail = validateConfig({
      org: { slug: "o", name: "O" },
      mail: {
        mailboxes: [
          { address: "a@x.com", provider: "imap", imap: IMAP },
          { address: "b@x.com", provider: "imap", imap: IMAP, owner: "b@x.com" },
        ],
      },
    })
    expect(mail.ok).toBe(true)
  })

  test("mail.mailboxes: shared gmail and personal imap validate; ticket fields are refused", () => {
    const ok = validateConfig({
      org: { slug: "o", name: "O" },
      mail: {
        mailboxes: [
          {
            address: "team@x.com",
            provider: "gmail",
            google: { clientId: "c.apps.googleusercontent.com", clientSecret: "s" },
          },
          { address: "me@x.com", provider: "imap", owner: "me@x.com", imap: IMAP },
        ],
      },
    })
    expect(ok.ok).toBe(true)
    const withInbox = validateConfig({
      org: { slug: "o", name: "O" },
      mail: {
        mailboxes: [{ address: "team@x.com", provider: "gmail", inbox: { name: "Support" } }],
      },
    })
    expect(withInbox.ok).toBe(false)
  })

  test("a Google client id that is not one (another app's id) is refused", () => {
    const res = validateConfig({
      org: { slug: "o", name: "O" },
      mail: {
        mailboxes: [
          {
            address: "team@x.com",
            provider: "gmail",
            google: { clientId: "0f3c5e1d2b4a69788a7d6c5b4a392817", clientSecret: "s" },
          },
        ],
      },
    })
    expect(res.ok).toBe(false)
    expect(JSON.stringify(res)).toContain(".apps.googleusercontent.com")
  })

  test("mail.mailboxes: a personal gmail mailbox is refused (the owner must consent)", () => {
    const res = validateConfig({
      org: { slug: "o", name: "O" },
      mail: { mailboxes: [{ address: "me@x.com", provider: "gmail", owner: "me@x.com" }] },
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected failure")
    expect(res.message).toContain("Settings > Mail")
  })

  test("unknown mailbox provider -> code 2", () => {
    const res = validateConfig({
      org: { slug: "o", name: "O" },
      mail: { mailboxes: [{ address: "s@x.com", provider: "exchange" }] },
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected failure")
    expect(res.code).toBe(2)
  })

  test("apiKeys[].allowedOrigins: [] is accepted (empty array legal)", () => {
    const res = validateConfig({
      org: { slug: "o", name: "O" },
      apiKeys: [{ label: "hub-sync", allowedOrigins: [] }],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error(res.message)
    expect(res.config.apiKeys?.[0]?.allowedOrigins).toEqual([])
  })

  test("unknown top-level key → code 2 (strict top-level rejects typos)", () => {
    const res = validateConfig({ org: { slug: "o", name: "O" }, oops: true })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected failure")
    expect(res.code).toBe(2)
  })

  test("collections accept an optional slug alias; name is the key", () => {
    const res = validateConfig({
      org: { slug: "o", name: "O" },
      knowledge: { collections: [{ name: "Runbooks", slug: "runbooks" }] },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error(res.message)
    expect(res.config.knowledge?.collections?.[0]?.name).toBe("Runbooks")
  })

  test("collections validate without a slug (slug is optional)", () => {
    const res = validateConfig({
      org: { slug: "o", name: "O" },
      knowledge: { collections: [{ name: "Runbooks" }] },
    })
    expect(res.ok).toBe(true)
  })

  test("byok record of provider → { apiKey, validate? } validates", () => {
    const res = validateConfig({
      org: { slug: "o", name: "O" },
      byok: { anthropic: { apiKey: "sk-ant", validate: true }, openai: { apiKey: "sk-oa" } },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error(res.message)
    expect(res.config.byok?.anthropic?.apiKey).toBe("sk-ant")
    expect(res.config.byok?.anthropic?.validate).toBe(true)
  })

  test("full example-shaped config validates end-to-end", () => {
    const res = validateConfig({
      org: {
        slug: "fabrikam",
        name: "Fabrikam",
        timezone: "Europe/Paris",
        defaultLocale: "en",
        credits: { currency: "EUR", initial: "0" },
      },
      admin: { email: "m@fabrikam.example", name: "Taylor", password: "pw" },
      users: [{ email: "a@fabrikam.example", name: "Alice", role: "member", mode: "invite" }],
      byok: { anthropic: { apiKey: "sk-ant", validate: true } },
      apiKeys: [{ label: "hub-sync", key: "K7QF3A2B", allowedOrigins: [] }],
      email: {
        from: "Fabrikam Support <support@fabrikam.example>",
        replyTo: "support@fabrikam.example",
      },
      tickets: {
        inboxes: [
          {
            address: "support@fabrikam.example",
            provider: "gmail",
            google: { clientId: "cid.apps.googleusercontent.com", clientSecret: "csec" },
            default: true,
            name: "Support",
            fromDisplayName: "Fabrikam Support",
          },
        ],
      },
      apps: [
        {
          name: "pennylane",
          enable: true,
          connection: {
            name: "pennylane",
            identifier: "company",
            ownerType: "org",
            credentials: { apiToken: "tok" },
          },
        },
        { name: "invoicing", enable: true },
      ],
      knowledge: {
        collections: [{ name: "Runbooks", slug: "runbooks" }],
        documents: [
          { title: "Refund policy", collection: "runbooks", contentFile: "./kb/refund-policy.md" },
        ],
        sources: [{ type: "gitlab", app: "gitlab", path: "fabrikam/handbook" }],
      },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error(res.message)
  })
})

describe("invoicing section", () => {
  test("minimal issuer profile (legalName + country) validates", () => {
    const res = validateConfig({
      org: { slug: "o", name: "O" },
      invoicing: { issuerProfiles: [{ legalName: "Fabrikam SAS", country: "FR" }] },
    })
    expect(res.ok).toBe(true)
  })

  test("full issuer profile + taxRegimes + hsCodes validates", () => {
    const res = validateConfig({
      org: { slug: "o", name: "O" },
      invoicing: {
        issuerProfiles: [
          {
            legalName: "Fabrikam SAS",
            country: "FR",
            vatId: "FR12345678901",
            taxRegistrationId: "RCS Paris 123",
            address: "1 Rue de la Paix, 75001 Paris",
            iban: "FR7612345678901234567890185",
            swiftBic: "AGRIFRPP",
            bankName: "Credit Agricole",
            defaultCurrency: "EUR",
            defaultLanguage: "en",
            paymentTermsDays: 30,
            shopifyShop: "auto",
            autoEmail: false,
            invoiceApprovalThresholdMinor: 500000,
          },
        ],
        taxRegimes: [
          {
            issuerCountry: "FR",
            treatment: "domestic",
            defaultRateBp: 2000,
            requiresHsCode: false,
          },
        ],
        hsCodes: [{ code: "9207.10", description: "Instrument controllers" }],
      },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error(res.message)
    expect(res.config.invoicing?.issuerProfiles?.[0]?.shopifyShop).toBe("auto")
  })

  test("issuer profile missing legalName → code 2", () => {
    const res = validateConfig({
      org: { slug: "o", name: "O" },
      invoicing: { issuerProfiles: [{ country: "FR" }] },
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected failure")
    expect(res.code).toBe(2)
  })

  test("issuer profile missing country → code 2", () => {
    const res = validateConfig({
      org: { slug: "o", name: "O" },
      invoicing: { issuerProfiles: [{ legalName: "Fabrikam SAS" }] },
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected failure")
    expect(res.code).toBe(2)
  })

  test("shopifyShop omitted/null are both accepted (no mapping intent)", () => {
    const resOmitted = validateConfig({
      org: { slug: "o", name: "O" },
      invoicing: { issuerProfiles: [{ legalName: "Fabrikam SAS", country: "FR" }] },
    })
    expect(resOmitted.ok).toBe(true)

    const resNull = validateConfig({
      org: { slug: "o", name: "O" },
      invoicing: {
        issuerProfiles: [{ legalName: "Fabrikam SAS", country: "FR", shopifyShop: null }],
      },
    })
    expect(resNull.ok).toBe(true)
  })
})

describe("invoicing issuer identity + einvoicing sections", () => {
  const base = { org: { slug: "o", name: "O" } }
  const issuer = { legalName: "Fabrikam SAS", country: "FR" }

  test("issuer identity fields are accepted", () => {
    const res = validateConfig({
      ...base,
      invoicing: {
        issuerProfiles: [
          {
            ...issuer,
            siren: "123456782",
            siret: "12345678200002",
            legalForm: "SAS",
            shareCapital: "10000",
            rcsCity: "Paris",
            vatOnDebits: true,
            routingAddress: "fabrikam-routing",
            addressLine1: "1 Rue de la Paix",
            addressLine2: "Batiment B",
            postcode: "75001",
            city: "Paris",
            countryCode: "FR",
          },
        ],
      },
    })
    expect(res.ok).toBe(true)
  })

  test("a typo in an issuer key is refused", () => {
    const res = validateConfig({
      ...base,
      invoicing: { issuerProfiles: [{ ...issuer, legalForme: "SAS" }] },
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected failure")
    expect(res.code).toBe(2)
  })

  test("a non-Luhn SIREN or SIRET is refused", () => {
    for (const bad of [{ siren: "123456783" }, { siret: "12345678200003" }, { siren: "12345" }]) {
      const res = validateConfig({
        ...base,
        invoicing: { issuerProfiles: [{ ...issuer, ...bad }] },
      })
      expect(res.ok).toBe(false)
    }
  })

  test("einvoicing gateMode and cibsSwitchDate are accepted", () => {
    const res = validateConfig({
      ...base,
      invoicing: { einvoicing: { gateMode: "enforce", cibsSwitchDate: "2027-01-01" } },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error(res.message)
    expect(res.config.invoicing?.einvoicing).toEqual({
      gateMode: "enforce",
      cibsSwitchDate: "2027-01-01",
    })
  })

  test("einvoicing.gatemode typo, bad mode value and bad date are refused", () => {
    for (const einvoicing of [
      { gatemode: "enforce" },
      { gateMode: "strict" },
      { cibsSwitchDate: "2027-13-40" },
      { cibsSwitchDate: "01/01/2027" },
    ]) {
      const res = validateConfig({ ...base, invoicing: { einvoicing } })
      expect(res.ok).toBe(false)
    }
  })

  test("einvoicing transmission settings: providerApp, cutoverDate, sendEnabled, bookEnabled; strict", () => {
    const res = validateConfig({
      ...base,
      invoicing: {
        einvoicing: {
          providerApp: "pennylane",
          cutoverDate: "2026-11-01",
          sendEnabled: false,
          bookEnabled: false,
        },
      },
    })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error(res.message)
    expect(res.config.invoicing?.einvoicing).toEqual({
      providerApp: "pennylane",
      cutoverDate: "2026-11-01",
      sendEnabled: false,
      bookEnabled: false,
    })
    for (const einvoicing of [
      { provider: "pennylane" },
      { providerApp: "Pennylane!" },
      { cutoverDate: "2026-11-31" },
      { sendEnabled: "yes" },
      { bookenabled: true },
    ]) {
      expect(validateConfig({ ...base, invoicing: { einvoicing } }).ok).toBe(false)
    }
  })

  test("gateMode accepts warn and enforce only", () => {
    for (const gateMode of ["warn", "enforce"]) {
      expect(validateConfig({ ...base, invoicing: { einvoicing: { gateMode } } }).ok).toBe(true)
    }
    const res = validateConfig({ ...base, invoicing: { einvoicing: { gateMode: "off" } } })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected failure")
    expect(res.code).toBe(2)
    expect(res.message).toContain("invoicing.einvoicing.gateMode")
  })

  test("a typo'd key in the invoicing section is refused, never silently skipped", () => {
    for (const invoicing of [
      { einvoice: { gateMode: "enforce" } },
      { issuerProfile: [issuer] },
      { hsCode: [] },
    ]) {
      const res = validateConfig({ ...base, invoicing })
      expect(res.ok).toBe(false)
      if (res.ok) throw new Error("expected failure")
      expect(res.code).toBe(2)
      expect(res.message).toContain(Object.keys(invoicing)[0] as string)
    }
  })
})

describe("apps[].providers (mail provider switches)", () => {
  test("accepted on the mail app, strict { enabled } per known provider", () => {
    const res = validateConfig({
      org: { slug: "o", name: "O" },
      apps: [{ name: "mail", enable: true, providers: { gmail: { enabled: true } } }],
    })
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error(res.message)
    expect(res.config.apps?.[0]?.providers).toEqual({ gmail: { enabled: true } })
  })

  test("providers on a non-mail app -> code 2", () => {
    const res = validateConfig({
      org: { slug: "o", name: "O" },
      apps: [{ name: "tickets", enable: true, providers: { gmail: { enabled: true } } }],
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected failure")
    expect(res.code).toBe(2)
    expect(res.message).toContain("apps.0.providers: providers is only supported on the 'mail' app")
  })

  test("unknown provider id -> code 2 naming the known providers", () => {
    const res = validateConfig({
      org: { slug: "o", name: "O" },
      apps: [{ name: "mail", enable: true, providers: { outlook: { enabled: true } } }],
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected failure")
    expect(res.code).toBe(2)
    expect(res.message).toContain("apps.0.providers.outlook: unknown mail provider")
    expect(res.message).toContain("gmail")
  })

  test("extra field on a provider switch -> code 2 (no free-form app config)", () => {
    const res = validateConfig({
      org: { slug: "o", name: "O" },
      apps: [
        { name: "mail", enable: true, providers: { gmail: { enabled: true, pushSecret: "x" } } },
      ],
    })
    expect(res.ok).toBe(false)
  })

  test("providers with enable: false -> code 2 (a disabled entry is skipped)", () => {
    const res = validateConfig({
      org: { slug: "o", name: "O" },
      apps: [{ name: "mail", enable: false, providers: { gmail: { enabled: true } } }],
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected failure")
    expect(res.message).toContain("providers requires enable: true")
  })
})

describe("manifest parity (correction #17)", () => {
  test("IMAP Zod field names are declared by BOTH the mail and the tickets imap connections", () => {
    for (const app of ["mail", "tickets"]) {
      const manifestPath = join(import.meta.dir, "..", "..", "apps", app, "app.manifest.json")
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
      const manifestFieldNames: string[] = (manifest.connections?.imap?.credentialFields ?? []).map(
        (f: { name: string }) => f.name,
      )
      expect(manifestFieldNames.length).toBeGreaterThan(0)
      for (const name of imapCredentialFieldNames) {
        expect(manifestFieldNames).toContain(name)
      }
    }
  })
})
