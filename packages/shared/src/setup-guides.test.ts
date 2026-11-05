// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The provider setup guides are structured steps a card or the agent renders: every
// string comes from the `setup-guides` i18n namespace, every value the person
// copies comes from the computed values, never from the copy.
import { describe, expect, test } from "bun:test"
import { connectFailureReason } from "./connect-failures"
import { dictionariesFor } from "./i18n/dictionaries"
import {
  GMAIL_PUSH_PUBLISHER,
  type GoogleClientInfo,
  type GoogleSetupValues,
  googleApiUrl,
  googleAuthorizedDomain,
  googleConnectPath,
  googleConsumerStatement,
  googleSetupGuide,
  googleTrustedClients,
  googleTrustedGuide,
  IMAP_PROVIDERS,
  imapPasswordGuide,
  isGmailAddress,
  normalizeAppPassword,
  type SetupGuideTranslate,
  SHOPIFY_ALL_ORDERS_REASON,
  type ShopifyDashboardValues,
  shopifyDashboardGuide,
  shopifySetupGuide,
} from "./setup-guides"

/** A translator over the shipped dictionaries, like the web `t()` and the api `serverT`. */
function translator(locale: "en" | "fr"): SetupGuideTranslate {
  const dicts = dictionariesFor(locale)
  return (key, params) => {
    const [ns, ...rest] = key.split(".")
    let node: unknown = dicts[ns ?? ""]
    for (const part of rest) node = (node as Record<string, unknown> | undefined)?.[part]
    if (typeof node !== "string") throw new Error(`missing ${locale} key ${key}`)
    return node.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name: string) =>
      params?.[name] === undefined ? m : String(params[name]),
    )
  }
}

const values: GoogleSetupValues = {
  baseUrl: "https://liaison.example.com",
  connectionsRedirectUri: "https://liaison.example.com/api/connections/callback",
  signIn: { enabled: false, redirectUri: "https://liaison.example.com/api/auth/oauth/callback" },
  redirectUris: ["https://liaison.example.com/api/connections/callback"],
  scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.modify"],
  apis: [{ id: "gmail.googleapis.com", name: "Gmail API" }],
  unmappedScopes: [],
  connections: [
    {
      app: "mail",
      connection: "gmail",
      scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.modify"],
      workspaceClient: true,
      clientSource: "none",
    },
  ],
  gmailPush: {
    publisher: GMAIL_PUSH_PUBLISHER,
    endpoint: "https://liaison.example.com/webhooks/org-1/mail/gmail-push",
    instanceTopic: false,
  },
  instanceClientOnly: false,
  clientReady: false,
  verifyApis: false,
  clients: {
    workspace: { source: "none", restrictedVerified: false },
    drive: { source: "none", restrictedVerified: false },
  },
}

describe("googleSetupGuide", () => {
  test("walks project, APIs, audience, branding, scopes, client, secret, then optional push", () => {
    const guide = googleSetupGuide(values, translator("en"))
    expect(guide.title.length).toBeGreaterThan(0)
    expect(guide.steps.map((s) => s.id)).toEqual([
      "project",
      "apis",
      "audience",
      "branding",
      "dataAccess",
      "client",
      "secret",
      "push",
    ])
    expect(guide.steps.find((s) => s.id === "push")?.optional).toBe(true)
  })

  test("with Google Drive on, every path says to pick the shared drives the team should see", () => {
    const drive = {
      app: "google-drive",
      connection: "drive",
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      workspaceClient: false,
      clientSource: "none" as const,
    }
    const withDrive = { ...values, connections: [...values.connections, drive] }
    for (const v of [
      withDrive,
      { ...withDrive, clientReady: true },
      { ...withDrive, instanceClientOnly: true },
    ]) {
      const step = googleSetupGuide(v, translator("en")).steps.find((s) => s.id === "sharedDrives")
      expect(step?.body).toContain("member of each shared drive")
    }
    expect(
      googleSetupGuide(values, translator("en")).steps.some((s) => s.id === "sharedDrives"),
    ).toBe(false)
  })

  test("the values a person copies are the computed ones", () => {
    const guide = googleSetupGuide(values, translator("en"))
    const step = (id: string) => guide.steps.find((s) => s.id === id)
    expect(step("apis")?.values).toEqual(["Gmail API"])
    expect(step("dataAccess")?.values).toEqual(values.scopes)
    expect(step("client")?.values).toEqual(values.redirectUris)
    expect(step("push")?.values).toEqual([
      GMAIL_PUSH_PUBLISHER,
      values.gmailPush.endpoint as string,
    ])
  })

  test("the sign-in callback appears only when the deployment signs in with Google", () => {
    const off = googleSetupGuide(values, translator("en"))
    expect(off.steps.some((s) => s.id === "signIn")).toBe(false)
    const on = googleSetupGuide(
      {
        ...values,
        signIn: { ...values.signIn, enabled: true },
        redirectUris: [values.connectionsRedirectUri, values.signIn.redirectUri],
      },
      translator("en"),
    )
    expect(on.steps.find((s) => s.id === "client")?.values).toContain(values.signIn.redirectUri)
  })

  test("API pages open with the project selected when its id is known", () => {
    expect(googleApiUrl("gmail.googleapis.com", "acme-liaison")).toBe(
      "https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=acme-liaison",
    )
    const guide = googleSetupGuide({ ...values, projectId: "acme-liaison" }, translator("en"))
    for (const link of guide.steps.find((s) => s.id === "apis")?.links ?? []) {
      expect(link.url).toEndWith("?project=acme-liaison")
    }
  })

  test("every Cloud console page opens with the project selected when its id is known", () => {
    const guide = googleSetupGuide({ ...values, projectId: "acme-liaison" }, translator("en"))
    const consoleLinks = guide.steps
      .filter((s) => s.id !== "project")
      .flatMap((s) => s.links ?? [])
      .filter((l) => l.url.startsWith("https://console.cloud.google.com/"))
    expect(consoleLinks.map((l) => new URL(l.url).pathname)).toEqual(
      expect.arrayContaining(["/auth/audience", "/auth/branding", "/auth/scopes", "/auth/clients"]),
    )
    for (const l of consoleLinks)
      expect(new URL(l.url).searchParams.get("project")).toBe("acme-liaison")
  })

  test("the branding step hands a ready value for every field: app name, support email, domain", () => {
    const withEmail = googleSetupGuide(
      { ...values, supportEmail: "admin@acme.example" },
      translator("en"),
    ).steps.find((s) => s.id === "branding")
    expect(withEmail?.values).toEqual(["Liaison", "admin@acme.example", "example.com"])
    expect(withEmail?.body).toContain("Developer contact email")
    const noEmail = googleSetupGuide(values, translator("en")).steps.find(
      (s) => s.id === "branding",
    )
    expect(noEmail?.values).toEqual(["Liaison", "example.com"])
    expect(noEmail?.body).toContain("your own admin address")
    expect(googleAuthorizedDomain("https://liaison.acme.co.uk")).toBe("acme.co.uk")
    expect(googleAuthorizedDomain("https://acme.com")).toBe("acme.com")
    expect(googleAuthorizedDomain("http://127.0.0.1:3000")).toBe("127.0.0.1")
  })

  test("other features' APIs are an optional aside, never part of the step", () => {
    const guide = googleSetupGuide(
      {
        ...values,
        alsoApis: [{ id: "calendar-json.googleapis.com", name: "Google Calendar API" }],
      },
      translator("en"),
    )
    const aside = guide.steps.find((s) => s.id === "alsoApis")
    expect(aside?.optional).toBe(true)
    expect(aside?.values).toEqual(["Google Calendar API"])
    expect(guide.steps.find((s) => s.id === "apis")?.values).toEqual(["Gmail API"])
  })

  test("the client step asks for one client with both redirect URIs and its JSON file", () => {
    const body = googleSetupGuide(values, translator("en")).steps.find(
      (s) => s.id === "client",
    )?.body
    expect(body).toContain("One client serves both")
    expect(body).toContain("Download JSON")
  })

  test("no Google app on: no APIs or scopes to list, the guide says so", () => {
    const guide = googleSetupGuide(
      { ...values, apis: [], scopes: [], connections: [] },
      translator("en"),
    )
    expect(guide.steps.find((s) => s.id === "apis")?.values).toEqual([])
    expect(guide.steps.find((s) => s.id === "apis")?.body).toMatch(/no Google app/i)
  })

  test("renders in French with no key left untranslated", () => {
    const fr = googleSetupGuide(values, translator("fr"))
    const en = googleSetupGuide(values, translator("en"))
    expect(fr.steps.map((s) => s.id)).toEqual(en.steps.map((s) => s.id))
    for (const [i, s] of fr.steps.entries()) {
      expect(s.title).not.toBe(en.steps[i]?.title)
      expect(s.body).not.toMatch(/\{\{/)
    }
  })
})

describe("shopifySetupGuide", () => {
  test("coding agent (surface agent): the agent writes, deploys and reads the client; the person runs only the interactive login and link", () => {
    const guide = shopifySetupGuide(
      {
        callbackUrl: "https://liaison.example.com/api/connections/callback",
        clientSource: "none",
        hasClientId: false,
        handedFilename: "shopify-app.toml",
        surface: "agent",
      },
      translator("en"),
    )
    const who = Object.fromEntries(guide.steps.map((s) => [s.id, s.who ?? "human"]))
    expect(who).toMatchObject({
      file: "agent",
      cli: "agent",
      login: "human",
      link: "human",
      deploy: "agent",
      credentials: "agent",
      fullOrderHistorySetting: "agent",
    })
    expect(guide.steps.find((s) => s.id === "deploy")?.values).toEqual([
      "shopify app deploy --allow-updates",
    ])
    expect(guide.steps.find((s) => s.id === "credentials")?.values).toEqual([
      "shopify app env show",
    ])
    expect(guide.steps.find((s) => s.id === "login")?.body).toContain("never runs this login")
  })

  test("file, CLI, link, deploy, full order history request, distribution, client card, connect card", () => {
    const guide = shopifySetupGuide(
      {
        callbackUrl: "https://liaison.example.com/api/connections/callback",
        clientSource: "none",
        hasClientId: false,
        handedFilename: "shopify-app.toml",
      },
      translator("en"),
    )
    expect(guide.steps.map((s) => s.id)).toEqual([
      "file",
      "cli",
      "login",
      "link",
      "deploy",
      "fullOrderHistory",
      "distribution",
      "credentials",
      "fullOrderHistorySetting",
      "connect",
    ])
    expect(guide.steps[0]?.values).toEqual(["shopify.app.toml"])
    expect(guide.steps[0]?.body).toContain("shopify-app.toml")
    expect(guide.steps[1]?.values).toEqual(["npm install -g @shopify/cli@latest"])
    expect(guide.steps.find((s) => s.id === "deploy")?.values).toEqual(["shopify app deploy"])
    // The release works without read_all_orders. Its request comes right after the
    // release (approval takes days), is not optional, and hands the reason to paste.
    const full = guide.steps.find((s) => s.id === "fullOrderHistory")
    expect(full?.optional).toBeUndefined()
    expect(full?.body).toContain("partners.shopify.com")
    expect(full?.body).toContain("API access requests")
    // Managed installation: once approved, the scope reaches the store only through
    // the regenerated file, a deploy, then a reconnect.
    expect(full?.body).toContain("read_all_orders in its scopes")
    expect(full?.body).toContain("shopify app deploy")
    expect(full?.values).toEqual([SHOPIFY_ALL_ORDERS_REASON])
    expect(SHOPIFY_ALL_ORDERS_REASON).toContain("complete order history")
    expect(guide.steps.some((s) => s.optional)).toBe(false)
  })

  test("with a client id already in the file, linking is skipped", () => {
    const guide = shopifySetupGuide(
      {
        clientSource: "org",
        callbackUrl: "https://x/api/connections/callback",
        hasClientId: true,
        handedFilename: "f",
      },
      translator("fr"),
    )
    expect(guide.steps.some((s) => s.id === "link")).toBe(false)
  })
})

describe("instance-provided clients", () => {
  test("Google: every connection covered by the instance collapses the guide to connect", () => {
    for (const locale of ["en", "fr"] as const) {
      const guide = googleSetupGuide(
        {
          ...values,
          connections: values.connections.map((c) => ({ ...c, clientSource: "instance" })),
          instanceClientOnly: true,
          clientReady: true,
        },
        translator(locale),
      )
      expect(guide.steps.map((s) => s.id)).toEqual(["connect"])
      expect(guide.steps[0]?.body.length).toBeGreaterThan(0)
    }
  })

  test("Google: a workspace that has its own client skips every creation step", () => {
    for (const locale of ["en", "fr"] as const) {
      const guide = googleSetupGuide(
        {
          ...values,
          connections: values.connections.map((c) => ({ ...c, clientSource: "org" })),
          clientReady: true,
        },
        translator(locale),
      )
      // Only what remains: connecting, and the optional push the instance does not provide.
      expect(guide.steps.map((s) => s.id)).toEqual(["connect", "push"])
      // A connection the client was never used for: its APIs and scopes are checked first.
      const unproven = googleSetupGuide(
        {
          ...values,
          connections: values.connections.map((c) => ({ ...c, clientSource: "org" })),
          clientReady: true,
          verifyApis: true,
        },
        translator(locale),
      )
      expect(unproven.steps.map((s) => s.id)).toEqual(["apis", "dataAccess", "connect", "push"])
      expect(guide.steps[0]?.body).not.toBe(
        googleSetupGuide({ ...values, instanceClientOnly: true }, translator(locale)).steps[0]
          ?.body,
      )
    }
  })

  test("Google: a shared instance push topic drops the Pub/Sub step", () => {
    const guide = googleSetupGuide(
      { ...values, gmailPush: { ...values.gmailPush, instanceTopic: true } },
      translator("en"),
    )
    expect(guide.steps.map((s) => s.id)).not.toContain("push")
    expect(guide.steps.map((s) => s.id)).toContain("client")
  })

  test("Shopify: an instance app leaves only the connect step", () => {
    const guide = shopifySetupGuide(
      {
        clientSource: "instance",
        callbackUrl: "https://x/api/connections/callback",
        hasClientId: true,
        handedFilename: "f",
      },
      translator("fr"),
    )
    expect(guide.steps.map((s) => s.id)).toEqual(["connect"])
  })
})

describe("imapPasswordGuide", () => {
  test("every provider has server settings and en/fr steps", () => {
    for (const provider of Object.keys(IMAP_PROVIDERS) as Array<keyof typeof IMAP_PROVIDERS>) {
      for (const locale of ["en", "fr"] as const) {
        const guide = imapPasswordGuide(provider, translator(locale))
        expect(guide.steps.length).toBeGreaterThan(0)
        for (const s of guide.steps) expect(s.body).not.toMatch(/\{\{/)
      }
    }
  })

  test("Microsoft mailboxes are told plainly that a password does not work", () => {
    expect(IMAP_PROVIDERS.outlook.passwordWorks).toBe(false)
    const guide = imapPasswordGuide("outlook", translator("en"))
    expect(guide.steps[0]?.body).toMatch(/Microsoft/)
    // The title never promises the app password the body rules out.
    expect(guide.title).toBe("Outlook or Microsoft 365 cannot connect with a password")
    expect(imapPasswordGuide("outlook", translator("fr")).title).not.toMatch(
      /avec un mot de passe d'application/,
    )
  })

  test("Gmail links to 2-Step Verification and App passwords, and shows its servers", () => {
    for (const locale of ["en", "fr"] as const) {
      const guide = imapPasswordGuide("gmail", translator(locale))
      expect(guide.steps.map((s) => s.id)).toEqual(["twoStep", "password", "card"])
      expect(guide.steps.flatMap((s) => (s.links ?? []).map((l) => l.url))).toEqual([
        "https://myaccount.google.com/signinoptions/twosv",
        "https://myaccount.google.com/apppasswords",
      ])
      expect(guide.steps[2]?.values).toEqual(["imap.gmail.com:993", "smtp.gmail.com:465"])
    }
  })

  test("an app password pasted with Google's spaces signs in without them", () => {
    expect(normalizeAppPassword("abcd efgh ijkl mnop")).toBe("abcdefghijklmnop")
    expect(normalizeAppPassword("my pass word")).toBe("my pass word")
    expect(isGmailAddress("Someone@GMail.com")).toBe(true)
    expect(isGmailAddress("someone@company.com")).toBe(false)
  })

  test("Gmail uses imap.gmail.com and an app password", () => {
    expect(IMAP_PROVIDERS.gmail).toMatchObject({
      imapHost: "imap.gmail.com",
      imapPort: 993,
      smtpHost: "smtp.gmail.com",
      smtpPort: 465,
      passwordWorks: true,
    })
  })
})

describe("googleConnectPath", () => {
  const none: GoogleClientInfo = { source: "none", restrictedVerified: false }
  const org: GoogleClientInfo = { source: "org", restrictedVerified: false }
  const unverified: GoogleClientInfo = {
    source: "instance",
    instanceClientId: "i.apps.googleusercontent.com",
    restrictedVerified: false,
  }
  const verified: GoogleClientInfo = { ...unverified, restrictedVerified: true }

  test("each account type and client gives one path", () => {
    expect(googleConnectPath("google_workspace", unverified)).toBe("trusted")
    expect(googleConnectPath("google_consumer", unverified)).toBe("consumer_imap")
    expect(googleConnectPath("google_workspace", verified)).toBe("consent")
    expect(googleConnectPath("google_consumer", verified)).toBe("consent")
    expect(googleConnectPath("google_workspace", org)).toBe("consent")
    expect(googleConnectPath("google_consumer", org)).toBe("consent")
    expect(googleConnectPath("google_workspace", none)).toBe("own_client")
    expect(googleConnectPath("google_consumer", none)).toBe("own_client")
    expect(googleConnectPath("microsoft", unverified)).toBe("imap")
    expect(googleConnectPath("other", none)).toBe("imap")
    expect(googleConnectPath("unknown", org)).toBe("ask")
  })

  test("a client Internal to the address's Workspace domain connects with no Trusted mark", () => {
    const internal: GoogleClientInfo = { ...unverified, internalDomains: ["acme.example"] }
    expect(googleConnectPath("google_workspace", internal, "ana@acme.example")).toBe("consent")
    expect(googleConnectPath("google_workspace", internal, "Ana@ACME.example")).toBe("consent")
    // Another Workspace, or no address: the External rules still apply.
    expect(googleConnectPath("google_workspace", internal, "bo@other.example")).toBe("trusted")
    expect(googleConnectPath("google_workspace", internal)).toBe("trusted")
    expect(googleConnectPath("google_consumer", internal, "x@gmail.com")).toBe("consumer_imap")
  })

  test("no address: decided by the client alone, else ask", () => {
    expect(googleConnectPath(null, none)).toBe("own_client")
    expect(googleConnectPath(null, org)).toBe("consent")
    expect(googleConnectPath(null, verified)).toBe("consent")
    expect(googleConnectPath(null, unverified)).toBe("ask")
  })
})

describe("googleTrustedGuide", () => {
  const clients = {
    workspace: {
      source: "instance" as const,
      instanceClientId: "gmail.apps.googleusercontent.com",
      restrictedVerified: false,
    },
    drive: {
      source: "instance" as const,
      instanceClientId: "drive.apps.googleusercontent.com",
      restrictedVerified: false,
    },
  }

  test("admin, open, add, scope, trust, connect; every distinct client id to add", () => {
    const trusted = googleTrustedClients(clients)
    expect(trusted.map((c) => c.clientId)).toEqual([
      "gmail.apps.googleusercontent.com",
      "drive.apps.googleusercontent.com",
    ])
    const guide = googleTrustedGuide(
      { baseUrl: "https://liaison.example.com", clients: trusted },
      translator("en"),
    )
    expect(guide.steps.map((s) => s.id)).toEqual([
      "admin",
      "open",
      "add",
      "scope",
      "trust",
      "connect",
    ])
    expect(guide.steps.find((s) => s.id === "add")?.values).toEqual(trusted.map((c) => c.clientId))
    expect(guide.steps.find((s) => s.id === "add")?.body).toMatch(/each other client ID/)
    expect(guide.steps.find((s) => s.id === "open")?.body).toContain(
      "Security, then Access and data control, then API controls, and click Manage App Access",
    )
    // Google's current Admin console labels, in the order they are clicked.
    expect(guide.steps.find((s) => s.id === "add")?.body).toContain("Configure new app")
    expect(guide.steps.find((s) => s.id === "trust")?.body).toMatch(
      /Trusted and click Continue.*Finish/,
    )
    const message = guide.steps.find((s) => s.id === "admin")?.values?.[0] ?? ""
    expect(message).toContain("https://liaison.example.com")
    expect(message).toContain("Gmail and Google Calendar: gmail.apps.googleusercontent.com")
    expect(message).toContain("Google Drive: drive.apps.googleusercontent.com")
    expect(message).toMatch(/revoked/)
    expect(guide.steps.find((s) => s.id === "connect")?.body).toContain("admin_policy_enforced")
  })

  test("one shared client id is listed once; verified or own clients are not trusted", () => {
    const shared = {
      workspace: clients.workspace,
      drive: { ...clients.drive, instanceClientId: clients.workspace.instanceClientId },
    }
    expect(googleTrustedClients(shared)).toHaveLength(1)
    const guide = googleTrustedGuide(
      { baseUrl: "https://l.example", clients: googleTrustedClients(shared) },
      translator("en"),
    )
    expect(guide.steps.find((s) => s.id === "add")?.body).not.toMatch(/each other/)
    expect(
      googleTrustedClients({
        workspace: { ...clients.workspace, restrictedVerified: true },
        drive: { source: "org", restrictedVerified: false },
      }),
    ).toEqual([])
  })

  test("renders in French with no key left untranslated", () => {
    const v = { baseUrl: "https://l.example", clients: googleTrustedClients(clients) }
    const fr = googleTrustedGuide(v, translator("fr"))
    const en = googleTrustedGuide(v, translator("en"))
    expect(fr.steps.map((s) => s.id)).toEqual(en.steps.map((s) => s.id))
    for (const [i, s] of fr.steps.entries()) {
      expect(s.body).not.toBe(en.steps[i]?.body)
      expect(`${s.body}${s.values?.join("")}`).not.toMatch(/\{\{/)
    }
  })

  test("the personal Gmail statement names IMAP, what does not sync, and no forwarding", () => {
    for (const locale of ["en", "fr"] as const) {
      const s = googleConsumerStatement(translator(locale))
      expect(s).toContain("IMAP")
      expect(s).toContain("Google Workspace")
      expect(s.toLowerCase()).not.toMatch(/forward|transf/)
    }
  })
})

describe("shopifyDashboardGuide", () => {
  const dashboard: ShopifyDashboardValues = {
    clientSource: "none",
    appUrl: "https://liaison.example.com",
    redirectUrls: ["https://liaison.example.com/api/connections/callback"],
    scopes: ["read_orders", "write_orders"],
    protectedScopes: ["read_all_orders"],
    apiVersion: "2026-04",
  }

  test("open, version, full order history, distribution, credentials, connect; no terminal", () => {
    const guide = shopifyDashboardGuide(dashboard, translator("en"))
    expect(guide.steps.map((s) => s.id)).toEqual([
      "open",
      "version",
      "fullOrderHistory",
      "distribution",
      "credentials",
      "fullOrderHistorySetting",
      "connect",
    ])
    expect(guide.steps.find((s) => s.id === "version")?.values).toEqual([
      "https://liaison.example.com",
      "https://liaison.example.com/api/connections/callback",
      // A merchant organization's own Dev Dashboard app gets read_all_orders
      // without Shopify's review: it is listed from the start.
      "read_orders,write_orders,read_all_orders",
      "2026-04",
    ])
    expect(guide.steps.find((s) => s.id === "fullOrderHistory")?.body).toContain(
      "Partner organization",
    )
    expect(guide.steps.find((s) => s.id === "open")?.body).toContain("dev.shopify.com/dashboard")
    expect(guide.steps.find((s) => s.id === "distribution")?.body).toContain("Custom distribution")
    expect(JSON.stringify(guide)).not.toMatch(/npm |shopify app /)
  })

  test("no protected scope: no full order history step", () => {
    const guide = shopifyDashboardGuide({ ...dashboard, protectedScopes: [] }, translator("en"))
    expect(guide.steps.map((s) => s.id)).not.toContain("fullOrderHistory")
    expect(guide.steps.find((s) => s.id === "version")?.values?.[2]).toBe(
      "read_orders,write_orders",
    )
  })

  test("managed installation, no optional scopes; the instance's app is connect only", () => {
    const guide = shopifyDashboardGuide(dashboard, translator("en"))
    const version = guide.steps.find((s) => s.id === "version")
    expect(version?.values).toHaveLength(4)
    expect(version?.body).toContain("Use legacy install flow off")
    expect(version?.body).toContain("leave Optional scopes empty")
    expect(
      shopifyDashboardGuide({ ...dashboard, clientSource: "instance" }, translator("en")).steps.map(
        (s) => s.id,
      ),
    ).toEqual(["connect"])
  })

  test("renders in French with no key left untranslated", () => {
    const fr = shopifyDashboardGuide(dashboard, translator("fr"))
    const en = shopifyDashboardGuide(dashboard, translator("en"))
    for (const [i, s] of fr.steps.entries()) {
      expect(s.title).not.toBe(en.steps[i]?.title)
      expect(s.body).not.toMatch(/\{\{/)
    }
  })
})

describe("connectFailureReason: admin policy", () => {
  test("Google's admin-policy codes, and an access_denied that names a policy", () => {
    expect(connectFailureReason("admin_policy_enforced")).toBe("admin_policy_blocked")
    expect(connectFailureReason("org_internal")).toBe("admin_policy_blocked")
    expect(
      connectFailureReason("access_denied", "Access blocked by your administrator's admin policy"),
    ).toBe("admin_policy_blocked")
    expect(connectFailureReason("access_denied", "The user denied access")).toBe("access_denied")
    expect(connectFailureReason("access_denied")).toBe("access_denied")
    expect(connectFailureReason("unverified_app")).toBe("failed")
  })

  test("every reason has its sentence in both languages", () => {
    for (const locale of ["en", "fr"] as const) {
      const t = translator(locale)
      expect(t("kernel.auth.connectFailedReason.admin_policy_blocked")).toMatch(/Trusted|Fiable/)
      expect(t("secret-request.connectFailure.admin_policy_blocked")).toMatch(/Trusted|Fiable/)
    }
  })
})
