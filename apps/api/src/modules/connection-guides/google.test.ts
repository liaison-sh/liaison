// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Google setup values the agent quotes are the ones the code uses: the
// redirect URIs are built exactly as the connection and sign-in flows build
// theirs, and the scopes are the union of the Google scopes the apps that are on
// declare in their manifests. Drift between the guide and the code is a failure
// here, not a `redirect_uri_mismatch` for a person at Google's consent screen.
import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { GMAIL_PUSH_PUBLISHER, googleTrustedClients } from "@liaison/shared"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import { instanceOAuthClient } from "~/modules/apps/connections/oauth-client"
import { CONNECT_CALLBACK_PATH } from "~/modules/apps/connections/service"
import {
  computeGoogleSetupValues,
  googleApiForScope,
  googleSetupValuesFrom,
  instancePushTopicFor,
  isGoogleConnection,
  parseInternalDomains,
} from "./google"
import { CONNECTIONS_CALLBACK_PATH, SIGN_IN_CALLBACK_PATH } from "./paths"

const API_SRC = path.resolve(import.meta.dir, "../..")
const REPO = path.resolve(API_SRC, "../../..")

interface ManifestConnection {
  type?: string
  authorizationUrl?: string
  scopes?: string[]
}

/** Every app manifest, kernel apps and bundled apps alike. */
function manifests(): Array<{ name: string; connections: Record<string, ManifestConnection> }> {
  const out: Array<{ name: string; connections: Record<string, ManifestConnection> }> = []
  for (const base of [path.join(API_SRC, "apps"), path.join(REPO, "bundled-apps")]) {
    for (const d of readdirSync(base)) {
      const p = path.join(base, d, "app.manifest.json")
      if (!existsSync(p)) continue
      const j = JSON.parse(readFileSync(p, "utf8")) as {
        name: string
        connections?: Record<string, ManifestConnection>
      }
      out.push({ name: j.name, connections: j.connections ?? {} })
    }
  }
  return out
}

function manifestConnection(app: string, connection: string): ManifestConnection {
  const m = manifests().find((x) => x.name === app)
  const c = m?.connections[connection]
  if (!c) throw new Error(`no ${app}/${connection} in the manifests`)
  return c
}

/** The paths the code appends to BASE_URL for an OAuth redirect_uri. */
function redirectPathsIn(file: string): string[] {
  const src = readFileSync(path.join(API_SRC, file), "utf8")
  // Every flow builds its redirect_uri on the one OAuth redirect base.
  return [...src.matchAll(/`\$\{oauthRedirectBaseUrl\(\)\}([^`]+)`/g)].map((m) => m[1] as string)
}

describe("redirect URIs (drift against the flows)", () => {
  test("the connections callback is the one every app connection sends", () => {
    const paths = redirectPathsIn("modules/apps/connections/service.ts")
    expect(paths.length).toBeGreaterThan(0)
    for (const p of paths) expect(p).toBe(CONNECTIONS_CALLBACK_PATH)
    expect(CONNECT_CALLBACK_PATH).toBe(CONNECTIONS_CALLBACK_PATH)
  })

  test("the sign-in callback is the one Google sign-in sends", () => {
    const paths = redirectPathsIn("modules/auth/oauth-routes.ts")
    expect(paths.length).toBeGreaterThan(0)
    for (const p of paths) expect(p).toBe(SIGN_IN_CALLBACK_PATH)
  })

  test("built from BASE_URL, with a trailing slash dropped", () => {
    const v = googleSetupValuesFrom({
      baseUrl: "https://liaison.example.com/",
      signInEnabled: false,
      orgId: "org-1",
      connections: [],
    })
    expect(v.redirectUris).toEqual([
      "https://liaison.example.com/api/connections/callback",
      "https://liaison.example.com/api/auth/oauth/callback",
    ])
    expect(v.signIn.redirectUri).toBe("https://liaison.example.com/api/auth/oauth/callback")
  })

  test("one Web client by default: both redirect URIs, whether sign-in is on yet or not", () => {
    for (const signInEnabled of [true, false]) {
      const v = googleSetupValuesFrom({
        baseUrl: "https://l.example",
        signInEnabled,
        orgId: "o",
        connections: [],
      })
      expect(v.redirectUris).toEqual([
        "https://l.example/api/connections/callback",
        "https://l.example/api/auth/oauth/callback",
      ])
    }
  })
})

describe("one Google client for sign-in and every connection", () => {
  const ID = "123-one.apps.googleusercontent.com"
  const SECRET = "one-secret"
  const sameEverywhere = {
    GMAIL_OAUTH_CLIENT_ID: ID,
    GMAIL_OAUTH_CLIENT_SECRET: SECRET,
    GOOGLE_DRIVE_OAUTH_CLIENT_ID: ID,
    GOOGLE_DRIVE_OAUTH_CLIENT_SECRET: SECRET,
    GOOGLE_MARKETING_OAUTH_CLIENT_ID: ID,
    GOOGLE_MARKETING_OAUTH_CLIENT_SECRET: SECRET,
  }

  test("the same pair serves Gmail, Calendar, Drive, Ads and YouTube", () => {
    for (const key of [
      "mail:gmail",
      "tickets:gmail",
      "calendar:google-calendar",
      "google-drive:drive",
      "ads:google",
      "ads:merchant",
      "social:google",
    ]) {
      expect(instanceOAuthClient(key, sameEverywhere)).toEqual({
        clientId: ID,
        clientSecret: SECRET,
      })
    }
  })

  test("a Workspace admin trusts it once, not once per family", () => {
    const one = { source: "instance" as const, instanceClientId: ID, restrictedVerified: false }
    expect(googleTrustedClients({ workspace: one, drive: one })).toEqual([
      { family: "workspace", clientId: ID },
    ])
  })

  test("the sign-in client (GOOGLE_OAUTH_*) and the connections share both redirect URIs", () => {
    const v = googleSetupValuesFrom({
      baseUrl: "https://l.example",
      signInEnabled: true,
      orgId: "o",
      connections: [{ app: "mail", connection: "gmail", scopes: ["https://mail.google.com/"] }],
    })
    expect(v.redirectUris).toContain(`https://l.example${SIGN_IN_CALLBACK_PATH}`)
    expect(v.redirectUris).toContain(`https://l.example${CONNECTIONS_CALLBACK_PATH}`)
  })
})

describe("internal audience (GOOGLE_OAUTH_INTERNAL_DOMAINS)", () => {
  test("parsed lower-cased, blanks dropped", () => {
    expect(parseInternalDomains(" Acme.example , ,b.example")).toEqual([
      "acme.example",
      "b.example",
    ])
    expect(parseInternalDomains(undefined)).toEqual([])
  })
})

describe("one feature at a time", () => {
  const connections = [
    { app: "mail", connection: "gmail", scopes: ["https://www.googleapis.com/auth/gmail.modify"] },
    {
      app: "calendar",
      connection: "google-calendar",
      scopes: ["https://www.googleapis.com/auth/calendar"],
    },
  ]

  test("a feature lists only its own APIs and scopes; the others are an aside", () => {
    const v = googleSetupValuesFrom({
      baseUrl: "https://l.example",
      signInEnabled: false,
      orgId: "o",
      connections,
      feature: "mail",
      projectId: "acme-liaison",
    })
    expect(v.apis.map((a) => a.name)).toEqual(["Gmail API"])
    expect(v.scopes).toEqual(["https://www.googleapis.com/auth/gmail.modify"])
    expect(v.alsoApis?.map((a) => a.name)).toEqual(["Google Calendar API"])
    expect(v.projectId).toBe("acme-liaison")
  })

  test("no feature: every app's APIs, no aside", () => {
    const v = googleSetupValuesFrom({
      baseUrl: "https://l.example",
      signInEnabled: false,
      orgId: "o",
      connections,
    })
    expect(v.apis.map((a) => a.name).sort()).toEqual(["Gmail API", "Google Calendar API"])
    expect(v.alsoApis).toBeUndefined()
  })
})

describe("scopes and APIs (drift against the manifests)", () => {
  test("every Google scope any manifest declares maps to an API or is an identity scope", () => {
    const unknown: string[] = []
    for (const m of manifests()) {
      for (const [name, c] of Object.entries(m.connections)) {
        if (!isGoogleConnection(c)) continue
        for (const s of c.scopes ?? []) {
          if (googleApiForScope(s) === undefined) unknown.push(`${m.name}/${name}: ${s}`)
        }
      }
    }
    expect(unknown).toEqual([])
  })

  test("the scopes are the union of the manifests of the apps that are on", () => {
    const on = [
      ["mail", "gmail"],
      ["tickets", "gmail"],
      ["calendar", "google-calendar"],
      ["google-drive", "drive"],
    ] as const
    const v = googleSetupValuesFrom({
      baseUrl: "https://l.example",
      signInEnabled: false,
      orgId: "org-1",
      connections: on.map(([app, connection]) => ({
        app,
        connection,
        scopes: manifestConnection(app, connection).scopes ?? [],
      })),
    })
    const expected = new Set(on.flatMap(([a, c]) => manifestConnection(a, c).scopes ?? []))
    expect(new Set(v.scopes)).toEqual(expected)
    expect(v.scopes.length).toBe(expected.size)
    expect(v.apis.map((a) => a.id).sort()).toEqual([
      "calendar-json.googleapis.com",
      "drive.googleapis.com",
      "gmail.googleapis.com",
    ])
    expect(v.unmappedScopes).toEqual([])
    expect(v.gmailPush).toEqual({
      publisher: GMAIL_PUSH_PUBLISHER,
      endpoint: "https://l.example/webhooks/org-1/mail/gmail-push",
      instanceTopic: false,
    })
  })

  test("connections the instance covers drop out of the client to create", () => {
    const on: Array<[string, string]> = [
      ["mail", "gmail"],
      ["google-drive", "drive"],
    ]
    const v = googleSetupValuesFrom({
      baseUrl: "https://l.example",
      signInEnabled: false,
      orgId: "org-1",
      connections: on.map(([app, connection]) => ({
        app,
        connection,
        scopes: manifestConnection(app, connection).scopes ?? [],
        clientSource: app === "mail" ? "instance" : "none",
      })),
    })
    expect(v.instanceClientOnly).toBe(false)
    expect(v.clientReady).toBe(false)
    expect(new Set(v.scopes)).toEqual(new Set(manifestConnection("google-drive", "drive").scopes))
    expect(v.apis.map((a) => a.id)).toEqual(["drive.googleapis.com"])
    expect(v.connections.map((c) => [c.app, c.clientSource])).toEqual([
      ["google-drive", "none"],
      ["mail", "instance"],
    ])
  })

  test("every connection covered by the instance: nothing to create, push dropped with a shared topic", () => {
    const v = googleSetupValuesFrom({
      baseUrl: "https://l.example",
      signInEnabled: false,
      orgId: "org-1",
      connections: [
        {
          app: "mail",
          connection: "gmail",
          scopes: manifestConnection("mail", "gmail").scopes ?? [],
          clientSource: "instance",
        },
      ],
      instancePushTopic: true,
    })
    expect(v.instanceClientOnly).toBe(true)
    expect(v.clientReady).toBe(true)
    expect(v.gmailPush.instanceTopic).toBe(true)
    expect(new Set(v.scopes)).toEqual(new Set(manifestConnection("mail", "gmail").scopes))
  })

  test("own client used for Gmail only, Calendar on later: Calendar's API and scopes are listed to check", () => {
    const v = googleSetupValuesFrom({
      baseUrl: "https://l.example",
      signInEnabled: false,
      orgId: "org-1",
      connections: [
        {
          app: "mail",
          connection: "gmail",
          scopes: manifestConnection("mail", "gmail").scopes ?? [],
          clientSource: "org",
          clientProven: true,
        },
        {
          app: "tickets",
          connection: "gmail",
          scopes: manifestConnection("tickets", "gmail").scopes ?? [],
          clientSource: "org",
        },
        {
          app: "calendar",
          connection: "google-calendar",
          scopes: manifestConnection("calendar", "google-calendar").scopes ?? [],
          clientSource: "org",
        },
      ],
    })
    expect(v.clientReady).toBe(true)
    expect(v.verifyApis).toBe(true)
    // Tickets' Gmail asks only for scopes mail's Gmail already got with that client.
    expect(v.apis.map((a) => a.id)).toEqual(["calendar-json.googleapis.com"])
  })

  test("the workspace's own client counts as a client: nothing is left to create", () => {
    const v = googleSetupValuesFrom({
      baseUrl: "https://l.example",
      signInEnabled: false,
      orgId: "org-1",
      connections: [
        {
          app: "mail",
          connection: "gmail",
          scopes: manifestConnection("mail", "gmail").scopes ?? [],
          clientSource: "org",
        },
      ],
    })
    expect(v.instanceClientOnly).toBe(false)
    expect(v.clientReady).toBe(true)
  })

  test("Gmail and Calendar take the workspace client, Drive its own", () => {
    const v = googleSetupValuesFrom({
      baseUrl: "https://l.example",
      signInEnabled: false,
      orgId: "o",
      connections: [
        { app: "mail", connection: "gmail", scopes: [] },
        { app: "tickets", connection: "gmail", scopes: [] },
        { app: "calendar", connection: "google-calendar", scopes: [] },
        { app: "google-drive", connection: "drive", scopes: [] },
      ],
    })
    const flag = (app: string) => v.connections.find((c) => c.app === app)?.workspaceClient
    expect([flag("mail"), flag("tickets"), flag("calendar"), flag("google-drive")]).toEqual([
      true,
      true,
      true,
      false,
    ])
    // The flag mirrors the resolvers: Gmail and Calendar resolve the workspace client.
    const src = (f: string) => readFileSync(path.join(API_SRC, "apps", f), "utf8")
    expect(src("tickets/manifest-descriptor.ts")).toContain("resolveGoogleOAuthClientConfig")
    expect(src("calendar/manifest-descriptor.ts")).toContain("resolveGoogleOAuthClientConfig")
    expect(src("mail/manifest-descriptor.ts")).toContain("resolveEnabledMailProviderOAuthClient")
    expect(src("google-drive/manifest-descriptor.ts")).not.toContain(
      "resolveGoogleOAuthClientConfig",
    )
  })

  test("the workspace's own Google client set: Drive and YouTube (own clients) leave the steps, Calendar's APIs stay", () => {
    const scopes = (app: string, connection: string) =>
      manifestConnection(app, connection).scopes ?? []
    const v = googleSetupValuesFrom({
      baseUrl: "https://l.example",
      signInEnabled: false,
      orgId: "org-1",
      connections: [
        {
          app: "mail",
          connection: "gmail",
          scopes: scopes("mail", "gmail"),
          clientSource: "org",
          clientProven: true,
        },
        {
          app: "calendar",
          connection: "google-calendar",
          scopes: scopes("calendar", "google-calendar"),
          clientSource: "org",
        },
        {
          app: "google-drive",
          connection: "drive",
          scopes: scopes("google-drive", "drive"),
          clientSource: "none",
        },
      ],
    })
    // Nothing to create: the client exists; only Calendar's API and scopes are checked.
    expect(v.clientReady).toBe(true)
    expect(v.verifyApis).toBe(true)
    expect(v.apis.map((a) => a.id)).toEqual(["calendar-json.googleapis.com"])
    expect(v.scopes.some((s) => s.includes("drive"))).toBe(false)
    expect(v.separateClients?.map((c) => `${c.app}/${c.connection}`)).toEqual([
      "google-drive/drive",
    ])
    expect(v.separateClients?.[0]?.apis).toEqual(["Google Drive API"])
  })

  test("no workspace client yet: Drive stays in the client to create", () => {
    const v = googleSetupValuesFrom({
      baseUrl: "https://l.example",
      signInEnabled: false,
      orgId: "org-1",
      connections: [
        { app: "mail", connection: "gmail", scopes: [], clientSource: "none" },
        { app: "google-drive", connection: "drive", scopes: [], clientSource: "none" },
      ],
    })
    expect(v.clientReady).toBe(false)
    expect(v.separateClients).toBeUndefined()
  })

  test("no Mail app: no push endpoint", () => {
    const v = googleSetupValuesFrom({
      baseUrl: "https://l.example",
      signInEnabled: false,
      orgId: "o",
      connections: [{ app: "calendar", connection: "google-calendar", scopes: [] }],
    })
    expect(v.gmailPush.endpoint).toBeNull()
  })
})

describe("computeGoogleSetupValues", () => {
  test("reads the Google connections registered for this workspace only", () => {
    const orgId = `org-google-setup-${crypto.randomUUID()}`
    const other = `org-google-other-${crypto.randomUUID()}`
    for (const m of manifests()) {
      if (!["mail", "calendar", "shopify"].includes(m.name)) continue
      for (const [name, c] of Object.entries(m.connections)) {
        connectionConfigRegistry.set([orgId, m.name, name], {
          ...(c as object),
          allowedDomains: [],
        } as never)
      }
    }
    connectionConfigRegistry.set([other, "google-drive", "drive"], {
      ...(manifestConnection("google-drive", "drive") as object),
      allowedDomains: [],
    } as never)
    try {
      const v = computeGoogleSetupValues(orgId)
      expect(v.connections.map((c) => `${c.app}/${c.connection}`)).toEqual([
        "calendar/google-calendar",
        "mail/gmail",
      ])
      const expected = new Set([
        ...(manifestConnection("mail", "gmail").scopes ?? []),
        ...(manifestConnection("calendar", "google-calendar").scopes ?? []),
      ])
      expect(new Set(v.scopes)).toEqual(expected)
      expect(v.apis.map((a) => a.name)).toEqual(["Google Calendar API", "Gmail API"])
    } finally {
      connectionConfigRegistry.deleteByPrefix([orgId])
      connectionConfigRegistry.deleteByPrefix([other])
    }
  })
})

// S30: a managed server's topic lives in the project of the server's own Google
// client; Gmail's watch only publishes to a topic in the calling client's project,
// so a workspace on its own client keeps the push step (a topic in its own project).
describe("instance push topic in the Google guide", () => {
  test("a server topic covers the workspace on the server's client or none", () => {
    for (const workspaceSource of ["instance", "none", undefined] as const) {
      expect(
        instancePushTopicFor({ topic: "projects/p/topics/t", managed: true, workspaceSource }),
      ).toBe(true)
    }
    expect(
      instancePushTopicFor({ topic: undefined, managed: true, workspaceSource: "instance" }),
    ).toBe(false)
  })
  test("managed, a workspace on its own client: no shared topic, the push step stays", () => {
    expect(
      instancePushTopicFor({ topic: "projects/p/topics/t", managed: true, workspaceSource: "org" }),
    ).toBe(false)
  })
  test("self-hosted: unchanged, the topic alone decides", () => {
    expect(
      instancePushTopicFor({
        topic: "projects/p/topics/t",
        managed: false,
        workspaceSource: "org",
      }),
    ).toBe(true)
  })
})
