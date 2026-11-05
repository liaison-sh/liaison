// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `kernel__google_setup` gives the agent the real Google values and the guide in
// the person's language; `kernel__shopify_app_toml` hands the generated
// shopify.app.toml over as a file in the conversation. Both are deferred tools,
// and neither ever carries a secret.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { and, eq, sql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { connectedAccounts, files, messages, oauthProviders } from "~/db/schema/kernel"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { env } from "~/lib/env"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import {
  handleDrivePicker,
  handleGoogleSetup,
  handleShopifyAppToml,
  handleShopifySetup,
  shopifyTomlNextStep,
} from "~/modules/agent/tools/setup-guide-tools"
import { isDeferredTool } from "~/modules/agent/tools/tool-bridge"
import {
  connectionConfigRegistry,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { upsertConnectionOAuthClient } from "~/modules/apps/connections/oauth-client-provisioning"
import {
  shopifyCliPlan,
  shopifyOptedInProtectedScopes,
  translator,
} from "~/modules/connection-guides/plan"
import { shopifyAppToml } from "~/modules/connection-guides/shopify-app-toml"
import {
  clearGoogleIntegrationConfig,
  saveGoogleIntegrationConfig,
} from "~/modules/settings/google-integration"
import { bootstrapAdminThread } from "~/tests/helpers/agent-ctx"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const REPO = path.resolve(import.meta.dir, "../../../../../..")
const shopifyManifest = JSON.parse(
  readFileSync(path.join(REPO, "bundled-apps/shopify/app.manifest.json"), "utf8"),
) as { connections: { shop: Record<string, unknown> } }
const mailManifest = JSON.parse(
  readFileSync(path.join(REPO, "apps/api/src/apps/mail/app.manifest.json"), "utf8"),
) as { connections: { gmail: Record<string, unknown> } }

const driveManifest = JSON.parse(
  readFileSync(path.join(REPO, "apps/api/src/apps/google-drive/app.manifest.json"), "utf8"),
) as { connections: { drive: Record<string, unknown> } }

const calendarManifest = JSON.parse(
  readFileSync(path.join(REPO, "apps/api/src/apps/calendar/app.manifest.json"), "utf8"),
) as { connections: Record<string, Record<string, unknown>> }

let orgId: string
let admin: UserContext
let threadId: string

/** The instance settings these tests turn on, on the cached env the code reads. */
type InstanceVars = Partial<
  Record<
    | "GMAIL_OAUTH_CLIENT_ID"
    | "GMAIL_OAUTH_CLIENT_SECRET"
    | "GOOGLE_DRIVE_OAUTH_CLIENT_ID"
    | "GOOGLE_DRIVE_OAUTH_CLIENT_SECRET"
    | "GOOGLE_MARKETING_OAUTH_CLIENT_ID"
    | "GOOGLE_MARKETING_OAUTH_CLIENT_SECRET"
    | "SHOPIFY_APP_CLIENT_ID"
    | "SHOPIFY_APP_CLIENT_SECRET"
    | "GMAIL_PUBSUB_TOPIC",
    string
  >
>
const mutableEnv = env as InstanceVars

async function withInstance<T>(vars: InstanceVars, fn: () => Promise<T>): Promise<T> {
  const keys = Object.keys(vars) as Array<keyof InstanceVars>
  const saved = keys.map((k) => [k, mutableEnv[k]] as const)
  for (const k of keys) mutableEnv[k] = vars[k]
  try {
    return await fn()
  } finally {
    for (const [k, v] of saved) mutableEnv[k] = v
  }
}

/** Every Google client an instance can provide: whatever Google app is on is covered. */
const GOOGLE_INSTANCE: InstanceVars = {
  GMAIL_OAUTH_CLIENT_ID: "instance-google.apps.googleusercontent.com",
  GMAIL_OAUTH_CLIENT_SECRET: "instance-google-secret",
  GOOGLE_DRIVE_OAUTH_CLIENT_ID: "instance-drive.apps.googleusercontent.com",
  GOOGLE_DRIVE_OAUTH_CLIENT_SECRET: "instance-drive-secret",
  GOOGLE_MARKETING_OAUTH_CLIENT_ID: "instance-marketing.apps.googleusercontent.com",
  GOOGLE_MARKETING_OAUTH_CLIENT_SECRET: "instance-marketing-secret",
}

function mailSource(values: { connections: Array<{ app: string; clientSource: string }> }) {
  return values.connections.find((c) => c.app === "mail")?.clientSource
}
const SHOPIFY_INSTANCE: InstanceVars = {
  SHOPIFY_APP_CLIENT_ID: "instance-shopify-client-id",
  SHOPIFY_APP_CLIENT_SECRET: "instance-shopify-secret",
}

/** A checkout's .env.test may set a server Google or Shopify client: every test
 *  starts from none and turns on only what it names (withInstance). */
const NO_INSTANCE: InstanceVars = {
  GMAIL_OAUTH_CLIENT_ID: undefined,
  GMAIL_OAUTH_CLIENT_SECRET: undefined,
  GOOGLE_DRIVE_OAUTH_CLIENT_ID: undefined,
  GOOGLE_DRIVE_OAUTH_CLIENT_SECRET: undefined,
  GOOGLE_MARKETING_OAUTH_CLIENT_ID: undefined,
  GOOGLE_MARKETING_OAUTH_CLIENT_SECRET: undefined,
  SHOPIFY_APP_CLIENT_ID: undefined,
  SHOPIFY_APP_CLIENT_SECRET: undefined,
  GMAIL_PUBSUB_TOPIC: undefined,
}
const savedInstance = (Object.keys(NO_INSTANCE) as Array<keyof InstanceVars>).map(
  (k) => [k, mutableEnv[k]] as const,
)

beforeAll(async () => {
  await acquireTestLock()
  Object.assign(mutableEnv, NO_INSTANCE)
  const t = await bootstrapAdminThread()
  orgId = t.orgId
  admin = t.actor
  threadId = t.threadId
  await registerKernelAgentTools(orgId)
  // The files SELECT policy is generated at boot from the registered file parents
  // (the upload session, the message): build it, as a booted server has it.
  await rebuildFilesSelectPolicy()
})

afterAll(async () => {
  for (const [k, v] of savedInstance) mutableEnv[k] = v
  connectionConfigRegistry.deleteByPrefix([orgId, "shopify"])
  connectionConfigRegistry.deleteByPrefix([orgId, "mail"])
  await releaseTestLock()
})

describe("registration", () => {
  test("both tools are deferred with short descriptions; the skills are deferred playbooks", () => {
    for (const name of ["google_setup", "drive_picker", "shopify_setup", "shopify_app_toml"]) {
      const def = toolRegistry.get([orgId, "kernel", name])
      expect(def).toBeDefined()
      expect(isDeferredTool("kernel", def as { deferLoading?: boolean })).toBe(true)
      expect((def?.description ?? "").length).toBeLessThanOrEqual(240)
    }
    const google = toolRegistry.get([orgId, "kernel", "google_setup"])
    expect(google?.readOnly).toBe(true)
    expect(google?.requiredScopes).toEqual(["kernel:threads:read"])
    const picker = toolRegistry.get([orgId, "kernel", "drive_picker"])
    expect(picker?.readOnly).toBe(true)
    expect(picker?.requiredScopes).toEqual(["kernel:threads:read"])
    const shopifySetup = toolRegistry.get([orgId, "kernel", "shopify_setup"])
    expect(shopifySetup?.readOnly).toBe(true)
    expect(shopifySetup?.requiredScopes).toEqual(["kernel:threads:read"])
    expect(toolRegistry.get([orgId, "kernel", "shopify_app_toml"])?.requiredScopes).toEqual([
      "kernel:threads:write",
    ])
    for (const skill of ["google-setup", "shopify-setup"]) {
      expect(skillRegistry.get([orgId, "kernel", skill])?.body).toContain("kernel__")
    }
  })
})

describe("kernel__google_setup", () => {
  test("quotes the values computed from BASE_URL and the apps that are on", async () => {
    connectionConfigRegistry.set([orgId, "mail", "gmail"], {
      ...mailManifest.connections.gmail,
      allowedDomains: [],
    } as never)
    const r = await handleGoogleSetup({}, { orgId, userId: admin.userId })
    const base = env.BASE_URL.replace(/\/+$/, "")
    expect(r.values.connectionsRedirectUri).toBe(`${base}/api/connections/callback`)
    for (const s of mailManifest.connections.gmail.scopes as string[]) {
      expect(r.values.scopes).toContain(s)
    }
    expect(new Set(r.values.scopes).size).toBe(r.values.scopes.length)
    expect(r.values.apis.map((a) => a.name)).toContain("Gmail API")
    expect(r.guide?.steps.find((s) => s.id === "client")?.values).toEqual(r.values.redirectUris)
    expect("imap" in r).toBe(false)
  })

  test("the result carries the rule to quote the values, not to recall them", async () => {
    const def = toolRegistry.get([orgId, "kernel", "google_setup"])
    if (!def) throw new Error("google_setup not registered")
    const handler = def.handler as (p: unknown, c: unknown) => Promise<{ hint?: string }>
    const r = await handler({}, { orgId, userId: admin.userId })
    expect(r.hint).toMatch(/exactly/)
  })

  test("client source none: the full Cloud guide, with the optional push step", async () => {
    connectionConfigRegistry.set([orgId, "mail", "gmail"], {
      ...mailManifest.connections.gmail,
      allowedDomains: [],
    } as never)
    const r = await handleGoogleSetup({}, { orgId, userId: admin.userId })
    expect(mailSource(r.values)).toBe("none")
    expect(r.values.instanceClientOnly).toBe(false)
    expect(r.guide?.steps.map((s) => s.id)).toEqual([
      "project",
      "apis",
      "audience",
      "branding",
      "dataAccess",
      "client",
      "secret",
      // Google Drive is on: its org connection shares only the picked shared drives.
      "sharedDrives",
      "push",
    ])
  })

  test("client source instance: no Cloud steps, the guide is the connect step", async () => {
    connectionConfigRegistry.set([orgId, "mail", "gmail"], {
      ...mailManifest.connections.gmail,
      allowedDomains: [],
    } as never)
    const r = await withInstance(GOOGLE_INSTANCE, () =>
      handleGoogleSetup({}, { orgId, userId: admin.userId }),
    )
    expect(new Set(r.values.connections.map((c) => c.clientSource))).toEqual(new Set(["instance"]))
    expect(r.values.instanceClientOnly).toBe(true)
    // Google Drive is on: its org connection shares only the picked shared drives.
    expect(r.guide?.steps.map((s) => s.id)).toEqual(["connect", "sharedDrives"])
    expect(r.nextStep).toMatch(/nothing is created in Google Cloud/)
  })

  test("a shared instance push topic drops the Pub/Sub step", async () => {
    connectionConfigRegistry.set([orgId, "mail", "gmail"], {
      ...mailManifest.connections.gmail,
      allowedDomains: [],
    } as never)
    const r = await withInstance({ GMAIL_PUBSUB_TOPIC: "projects/p/topics/gmail-push" }, () =>
      handleGoogleSetup({}, { orgId, userId: admin.userId }),
    )
    expect(r.values.gmailPush.instanceTopic).toBe(true)
    expect(r.guide?.steps.map((s) => s.id)).not.toContain("push")
    expect(r.guide?.steps.map((s) => s.id)).toContain("client")
  })

  test("client source org: the workspace's own client overrides the instance's", async () => {
    connectionConfigRegistry.set([orgId, "mail", "gmail"], {
      ...mailManifest.connections.gmail,
      allowedDomains: [],
    } as never)
    await saveGoogleIntegrationConfig(orgId, {
      clientId: "org-google.apps.googleusercontent.com",
      clientSecret: "org-google-secret",
    })
    try {
      const r = await withInstance(GOOGLE_INSTANCE, () =>
        handleGoogleSetup({}, { orgId, userId: admin.userId }),
      )
      expect(mailSource(r.values)).toBe("org")
      expect(r.values.instanceClientOnly).toBe(false)
      // Nothing is created again in Google Cloud.
      expect(r.values.clientReady).toBe(true)
      const ids = r.guide?.steps.map((s) => s.id)
      for (const creation of ["project", "audience", "branding", "client", "secret"]) {
        expect(ids).not.toContain(creation)
      }
    } finally {
      await clearGoogleIntegrationConfig(orgId)
    }
  })

  test("own client set up for Gmail, Calendar turned on later: only Calendar's API and scopes are checked, then connect", async () => {
    const clientId = "org-gmail-then-calendar.apps.googleusercontent.com"
    const calendarBefore = connectionConfigRegistry.get([orgId, "calendar", "google-calendar"])
    // Only the workspace-client connections are in play: Drive takes a client of its own.
    const driveBefore = connectionConfigRegistry.get([orgId, "google-drive", "drive"])
    connectionConfigRegistry.deleteByPrefix([orgId, "google-drive"])
    connectionConfigRegistry.set([orgId, "mail", "gmail"], {
      ...mailManifest.connections.gmail,
      allowedDomains: [],
    } as never)
    connectionConfigRegistry.set(
      [orgId, "calendar", "google-calendar"],
      calendarManifest.connections["google-calendar"] as never,
    )
    await saveGoogleIntegrationConfig(orgId, { clientId, clientSecret: "org-secret" })
    // Gmail was connected with this very client (the minting client the account records).
    await withSystemDb("test-gmail-minted", (db) =>
      db.insert(connectedAccounts).values({
        orgId,
        appName: "mail",
        connectionName: "gmail",
        ownerType: "org",
        providerType: "oauth2",
        identifier: `team-${orgId.slice(0, 8)}@acme.example`,
        createdBy: admin.userId,
        oauthClientSource: "org",
        oauthClientId: clientId,
      }),
    )
    try {
      const r = await handleGoogleSetup({}, { orgId, userId: admin.userId })
      expect(r.values.clientReady).toBe(true)
      expect(r.values.verifyApis).toBe(true)
      expect(r.values.apis.map((a) => a.name)).toEqual(["Google Calendar API"])
      expect(r.values.scopes.some((s) => s.includes("gmail"))).toBe(false)
      expect(r.guide?.steps.map((s) => s.id).slice(0, 3)).toEqual(["apis", "dataAccess", "connect"])
      expect(r.guide?.steps.map((s) => s.id)).not.toContain("client")
      expect(r.nextStep).toContain("calendar/google-calendar")
      expect(r.nextStep).toContain("Google Calendar API")

      // Once Calendar too was connected with it, only connecting remains.
      await withSystemDb("test-calendar-minted", (db) =>
        db.insert(connectedAccounts).values({
          orgId,
          appName: "calendar",
          connectionName: "google-calendar",
          ownerType: "org",
          providerType: "oauth2",
          identifier: `cal-${orgId.slice(0, 8)}@acme.example`,
          createdBy: admin.userId,
          oauthClientSource: "org",
          oauthClientId: clientId,
        }),
      )
      const done = await handleGoogleSetup({}, { orgId, userId: admin.userId })
      expect(done.values.verifyApis).toBe(false)
      expect(done.guide?.steps[0]?.id).toBe("connect")
      expect(done.guide?.steps.map((s) => s.id)).not.toContain("apis")
      expect(done.nextStep).toContain("nothing is created in Google Cloud")
    } finally {
      await withSystemDb("test-minted-cleanup", (db) =>
        db
          .delete(connectedAccounts)
          .where(
            and(eq(connectedAccounts.orgId, orgId), eq(connectedAccounts.oauthClientId, clientId)),
          ),
      )
      if (driveBefore) connectionConfigRegistry.set([orgId, "google-drive", "drive"], driveBefore)
      if (calendarBefore) {
        connectionConfigRegistry.set([orgId, "calendar", "google-calendar"], calendarBefore)
      } else {
        connectionConfigRegistry.deleteByPrefix([orgId, "calendar"])
      }
      await clearGoogleIntegrationConfig(orgId)
    }
  })

  test("walk N31/N36: own client set, Calendar and Drive on: no project/client/secret steps, and what is left in Google Cloud leads the result", async () => {
    const clientId = "org-walk-n31.apps.googleusercontent.com"
    const calendarBefore = connectionConfigRegistry.get([orgId, "calendar", "google-calendar"])
    const driveBefore = connectionConfigRegistry.get([orgId, "google-drive", "drive"])
    const driveManifest = JSON.parse(
      readFileSync(path.join(REPO, "apps/api/src/apps/google-drive/app.manifest.json"), "utf8"),
    ) as { connections: { drive: Record<string, unknown> } }
    connectionConfigRegistry.set([orgId, "google-drive", "drive"], {
      ...driveManifest.connections.drive,
    } as never)
    connectionConfigRegistry.set([orgId, "mail", "gmail"], {
      ...mailManifest.connections.gmail,
      allowedDomains: [],
    } as never)
    connectionConfigRegistry.set(
      [orgId, "calendar", "google-calendar"],
      calendarManifest.connections["google-calendar"] as never,
    )
    await saveGoogleIntegrationConfig(orgId, { clientId, clientSecret: "org-secret" })
    await withSystemDb("test-gmail-minted-n31", (db) =>
      db.insert(connectedAccounts).values({
        orgId,
        appName: "mail",
        connectionName: "gmail",
        ownerType: "org",
        providerType: "oauth2",
        identifier: `n31-${orgId.slice(0, 8)}@acme.example`,
        createdBy: admin.userId,
        oauthClientSource: "org",
        oauthClientId: clientId,
      }),
    )
    try {
      const r = await handleGoogleSetup({}, { orgId, userId: admin.userId })
      const ids = r.guide?.steps.map((s) => s.id) ?? []
      for (const gone of ["project", "audience", "branding", "client", "secret"]) {
        expect(ids).not.toContain(gone)
      }
      expect(ids.slice(0, 3)).toEqual(["apis", "dataAccess", "connect"])
      expect(r.values.apis.map((a) => a.name)).toEqual(["Google Calendar API"])
      // N36: the remaining Google Cloud work is a top-level list, first in the result.
      expect(Object.keys(r)[0]).toBe("remainingInGoogleCloud")
      expect(r.remainingInGoogleCloud).toHaveLength(2)
      expect(r.remainingInGoogleCloud?.[0]).toContain("Google Calendar API")
      expect(r.remainingInGoogleCloud?.[1]).toContain("calendar")
      expect(r.nextStep.startsWith("Still to do in Google Cloud, BEFORE connecting")).toBe(true)
      expect(r.nextStep).toContain("Never say nothing is left to do in Google Cloud")
      // Drive takes a client of its own: named, only if the person asks.
      expect(r.nextStep).toContain("google-drive/drive take a client of their own")
    } finally {
      await withSystemDb("test-minted-cleanup-n31", (db) =>
        db
          .delete(connectedAccounts)
          .where(
            and(eq(connectedAccounts.orgId, orgId), eq(connectedAccounts.oauthClientId, clientId)),
          ),
      )
      if (driveBefore) connectionConfigRegistry.set([orgId, "google-drive", "drive"], driveBefore)
      else connectionConfigRegistry.deleteByPrefix([orgId, "google-drive"])
      if (calendarBefore) {
        connectionConfigRegistry.set([orgId, "calendar", "google-calendar"], calendarBefore)
      } else {
        connectionConfigRegistry.deleteByPrefix([orgId, "calendar"])
      }
      await clearGoogleIntegrationConfig(orgId)
    }
  })

  test("nothing left in Google Cloud is said explicitly", async () => {
    await withInstance(GOOGLE_INSTANCE, async () => {
      const r = await handleGoogleSetup({}, { orgId, userId: admin.userId })
      expect(r.remainingInGoogleCloud).toEqual([])
      expect(r.nextStep).toContain("Nothing is left to do in Google Cloud")
    })
  })

  test("a mailbox that is not Google gets its app-password steps and servers", async () => {
    const r = await handleGoogleSetup({ imapProvider: "icloud" }, { orgId, userId: admin.userId })
    expect(r.imap?.settings.imapHost).toBe("imap.mail.me.com")
    expect(r.imap?.guide.steps.map((s) => s.id)).toEqual(["password", "servers", "card"])
  })
})

describe("kernel__google_setup with an address: the connect path", () => {
  const googleMx = async () => [{ exchange: "aspmx.l.google.com" }]
  const microsoftMx = async () => [{ exchange: "acme-example.mail.protection.outlook.com" }]
  const noDns = async (): Promise<Array<{ exchange: string }>> => {
    throw new Error("ENOTFOUND")
  }
  const verifiedEnv = env as { GOOGLE_OAUTH_RESTRICTED_SCOPES_VERIFIED: boolean }
  async function verified<T>(fn: () => Promise<T>): Promise<T> {
    const saved = verifiedEnv.GOOGLE_OAUTH_RESTRICTED_SCOPES_VERIFIED
    verifiedEnv.GOOGLE_OAUTH_RESTRICTED_SCOPES_VERIFIED = true
    try {
      return await fn()
    } finally {
      verifiedEnv.GOOGLE_OAUTH_RESTRICTED_SCOPES_VERIFIED = saved
    }
  }
  const ctx = () => ({ orgId, userId: admin.userId })
  const onMail = () =>
    connectionConfigRegistry.set([orgId, "mail", "gmail"], {
      ...mailManifest.connections.gmail,
      allowedDomains: [],
    } as never)

  test("Workspace address, unverified instance client: the Trusted guide with every client id", async () => {
    onMail()
    const r = await withInstance(GOOGLE_INSTANCE, () =>
      handleGoogleSetup({ email: "ana@acme.example" }, ctx(), { resolver: googleMx }),
    )
    expect(r.accountType).toBe("google_workspace")
    expect(r.path).toBe("trusted")
    expect(r.values.clients.workspace).toEqual({
      source: "instance",
      instanceClientId: GOOGLE_INSTANCE.GMAIL_OAUTH_CLIENT_ID,
      restrictedVerified: false,
    })
    expect(r.guide?.steps.map((s) => s.id)).toEqual([
      "admin",
      "open",
      "add",
      "scope",
      "trust",
      "connect",
    ])
    // Gmail and Drive have different instance clients: both are trusted.
    expect(r.guide?.steps.find((s) => s.id === "add")?.values).toEqual([
      "instance-google.apps.googleusercontent.com",
      "instance-drive.apps.googleusercontent.com",
    ])
    const message = r.guide?.steps.find((s) => s.id === "admin")?.values?.[0] ?? ""
    expect(message).toContain(env.BASE_URL.replace(/\/+$/, ""))
    expect(message).toContain(GOOGLE_INSTANCE.GMAIL_OAUTH_CLIENT_ID ?? "-")
    expect(message).not.toContain(GOOGLE_INSTANCE.GMAIL_OAUTH_CLIENT_SECRET ?? "-")
    expect(JSON.stringify(r)).not.toContain(GOOGLE_INSTANCE.GMAIL_OAUTH_CLIENT_SECRET ?? "-")
    expect("remainingInGoogleCloud" in r).toBe(false)
    expect(r.nextStep).toMatch(/^Path trusted/)
    // One step per message: the admin question alone, no Connect card yet.
    expect(r.nextStep).toContain("super admin")
    expect(r.nextStep).toContain("Post no Connect card")
  })

  test("personal Gmail, unverified instance client: the statement first, then IMAP, no Connect card", async () => {
    onMail()
    const r = await withInstance(GOOGLE_INSTANCE, () =>
      handleGoogleSetup({ email: "ana@gmail.com" }, ctx(), { resolver: noDns }),
    )
    expect(r.accountType).toBe("google_consumer")
    expect(r.path).toBe("consumer_imap")
    expect(r.statement).toContain("IMAP")
    expect(r.statement).toContain("Google Workspace")
    expect(r.imap?.provider).toBe("gmail")
    expect(r.guide?.steps.map((s) => s.id)).toEqual(["twoStep", "password", "card"])
    expect(r.nextStep).toContain("Never post a Gmail Connect card")
    expect(r.nextStep).toContain("never offer mail forwarding")
    // The member's own mailbox: the personal IMAP card, named exactly.
    expect(r.nextStep).toContain(
      "kind connection_credentials, app mail, connection imap, mode personal",
    )
    expect(r.nextStep).toContain("identifier ana@gmail.com")
    // One card per message: the mailbox, then Drive in a later message.
    expect(r.nextStep).toContain("alone in its message")
    expect(r.nextStep).toContain("One card per message")
  })

  test("Drive on: personal Gmail on an unverified instance client is picked mode; Workspace is full", async () => {
    onMail()
    connectionConfigRegistry.set(
      [orgId, "google-drive", "drive"],
      driveManifest.connections.drive as never,
    )
    try {
      const consumer = await withInstance(GOOGLE_INSTANCE, () =>
        handleGoogleSetup({ email: "ana@gmail.com" }, ctx(), { resolver: noDns }),
      )
      expect(consumer.drive?.mode).toBe("picked")
      expect(consumer.drive?.nextStep).toContain("kernel__drive_picker")
      // Never with the mailbox card, and the picker only once Drive is connected.
      expect(consumer.drive?.nextStep).toContain("Not in the same message as a mailbox card")
      expect(consumer.drive?.nextStep).toContain("Only once it says connected, in a later message")
      expect(consumer.drive?.nextStep).toContain(
        "Google Workspace account can share the whole Drive",
      )
      const workspace = await withInstance(GOOGLE_INSTANCE, () =>
        handleGoogleSetup({ email: "ana@acme.example" }, ctx(), { resolver: googleMx }),
      )
      expect(workspace.drive?.mode).toBe("full")
      expect(workspace.drive?.nextStep).not.toContain("kernel__drive_picker")
      const verifiedConsumer = await withInstance(GOOGLE_INSTANCE, () =>
        verified(() => handleGoogleSetup({ email: "ana@gmail.com" }, ctx(), { resolver: noDns })),
      )
      expect(verifiedConsumer.drive?.mode).toBe("full")
    } finally {
      connectionConfigRegistry.deleteByPrefix([orgId, "google-drive"])
    }
  })

  test("kernel__drive_picker: no Drive account says how to connect, and shows no card", async () => {
    const r = await handleDrivePicker({}, { ...ctx(), scopes: [] })
    expect(r.accounts).toEqual([])
    expect(r.card).toBe("none")
    expect(r.nextStep).toContain("kernel__google_setup")
  })

  test("personal Gmail, verified instance client: straight to consent", async () => {
    onMail()
    const r = await withInstance(GOOGLE_INSTANCE, () =>
      verified(() => handleGoogleSetup({ email: "ana@gmail.com" }, ctx(), { resolver: noDns })),
    )
    expect(r.path).toBe("consent")
    expect(r.values.clients.workspace.restrictedVerified).toBe(true)
    expect(r.guide?.steps.map((s) => s.id)).toEqual(["connect"])
  })

  test("Workspace address, the workspace's own client: consent, never the Trusted guide", async () => {
    onMail()
    await saveGoogleIntegrationConfig(orgId, {
      clientId: "org-own.apps.googleusercontent.com",
      clientSecret: "org-own-secret",
    })
    try {
      const r = await withInstance(GOOGLE_INSTANCE, () =>
        handleGoogleSetup({ email: "ana@acme.example" }, ctx(), { resolver: googleMx }),
      )
      expect(r.values.clients.workspace.source).toBe("org")
      expect(r.path).toBe("consent")
      expect(r.guide?.steps.map((s) => s.id)).not.toContain("trust")
    } finally {
      await clearGoogleIntegrationConfig(orgId)
    }
  })

  test("no client anywhere: own_client, the create-your-own-client guide", async () => {
    onMail()
    const r = await handleGoogleSetup({ email: "ana@acme.example" }, ctx(), {
      resolver: googleMx,
    })
    expect(r.path).toBe("own_client")
    expect(r.guide?.steps.map((s) => s.id)).toContain("client")
  })

  test("Microsoft 365 by MX: imap, with the plain Outlook refusal", async () => {
    const r = await withInstance(GOOGLE_INSTANCE, () =>
      handleGoogleSetup({ email: "ana@contoso.example" }, ctx(), { resolver: microsoftMx }),
    )
    expect(r.accountType).toBe("microsoft")
    expect(r.path).toBe("imap")
    expect(r.guide?.steps.map((s) => s.id)).toEqual(["unsupported"])
  })

  test("a domain that does not answer: ask the person, guess nothing", async () => {
    const r = await withInstance(GOOGLE_INSTANCE, () =>
      handleGoogleSetup({ email: "ana@nowhere.example" }, ctx(), { resolver: noDns }),
    )
    expect(r.accountType).toBe("unknown")
    expect(r.path).toBe("ask")
    expect(r.guide).toBeNull()
    expect(r.nextStep).toMatch(/^Path ask/)
  })

  test("the person's word wins: a Workspace domain behind a filtering gateway gets the Trusted path", async () => {
    const gatewayMx = async () => [{ exchange: "eu-smtp-inbound-1.mimecast.com", priority: 10 }]
    const detected = await withInstance(GOOGLE_INSTANCE, () =>
      handleGoogleSetup({ email: "ana@filtered.example" }, ctx(), { resolver: gatewayMx }),
    )
    expect(detected.path).toBe("imap")
    expect(detected.nextStep).toMatch(/accountType google_workspace/)
    expect(detected.nextStep).toContain("Never assume Google Workspace yourself")
    const said = await withInstance(GOOGLE_INSTANCE, () =>
      handleGoogleSetup({ email: "ana@filtered.example", accountType: "google_workspace" }, ctx(), {
        resolver: gatewayMx,
      }),
    )
    expect(said.accountType).toBe("google_workspace")
    expect(said.path).toBe("trusted")
  })
})

describe("kernel__shopify_setup", () => {
  test("refuses with a reason when the Shopify app is off", async () => {
    connectionConfigRegistry.deleteByPrefix([orgId, "shopify"])
    const r = await handleShopifySetup({ orgId, userId: admin.userId })
    expect("error" in r && r.error.code).toBe("shopify_not_installed")
    // A request error the agent can act on (turn the app on), not a server error.
    expect("error" in r && r.error.status).toBe(400)
    expect("error" in r && r.error.retryable).toBe(true)
  })

  test("no client: the Dev Dashboard steps, with the toml generator's values", async () => {
    connectionConfigRegistry.set([orgId, "shopify", "shop"], {
      ...shopifyManifest.connections.shop,
      allowedDomains: [],
    } as never)
    const r = await handleShopifySetup({ orgId, userId: admin.userId })
    if ("error" in r) throw new Error(r.error.message)
    expect(r.values.clientSource).toBe("none")
    expect(r.guide.steps.map((s) => s.id)).toEqual([
      "open",
      "version",
      "fullOrderHistory",
      "distribution",
      "credentials",
      "fullOrderHistorySetting",
      "connect",
    ])
    // In the product, the agent turns full order history on with kernel__config_apps.
    const setting = r.guide.steps.find((s) => s.id === "fullOrderHistorySetting")
    expect(setting?.who).toBe("agent")
    expect(setting?.values?.[0]).toBe("kernel__config_apps")
    const toml = shopifyAppToml(env.BASE_URL, shopifyManifest.connections.shop as never)
    const version = r.guide.steps.find((s) => s.id === "version")?.values ?? []
    expect(toml).toContain(`application_url = "${version[0]}"`)
    expect(toml).toContain(`redirect_urls = [ "${version[1]}" ]`)
    // The Dev Dashboard version names read_all_orders (a merchant organization's
    // app gets it without review); the toml leaves protected scopes out.
    expect(version[2]).toMatch(/,read_all_orders$/)
    expect(toml).toContain(`scopes = "${version[2]?.replace(/,read_all_orders$/, "")}"`)
    expect(toml).toContain(`api_version = "${version[version.length - 1]}"`)
    expect(r.nextStep).toContain("kernel__request_secret kind oauth_client")
    // One step per message: the first message is the open step alone.
    expect(r.nextStep).toContain("Your message now is step open alone")
    expect(r.nextStep).toContain("distribution, on its own")
  })

  test("instance client: the guide is the connect step", async () => {
    connectionConfigRegistry.set([orgId, "shopify", "shop"], {
      ...shopifyManifest.connections.shop,
      allowedDomains: [],
    } as never)
    const r = await withInstance(SHOPIFY_INSTANCE, () =>
      handleShopifySetup({ orgId, userId: admin.userId }),
    )
    if ("error" in r) throw new Error(r.error.message)
    expect(r.values.clientSource).toBe("instance")
    expect(r.guide.steps.map((s) => s.id)).toEqual(["connect"])
  })
})

describe("the Shopify app configuration under Shopify-managed installation", () => {
  test("lists read_all_orders once the org turned on full order history", async () => {
    // Shopify grants only the released configuration's scopes, so the opted-in
    // protected scope must be in the file the person deploys.
    const shop = shopifyManifest.connections.shop as {
      scopes: string[]
      protectedScopes: Array<{ scope: string; setting: string }>
      apiVersion: string
    }
    connectionConfigRegistry.set([orgId, "shopify", "shop"], {
      ...shop,
      allowedDomains: [],
    } as never)
    const setFullHistory = (on: boolean) =>
      withSystemDb("test-shopify-full-history", (db) =>
        db.execute(sql`UPDATE kernel.organizations
          SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{shopify}',
            jsonb_build_object('fullOrderHistory', ${on}::boolean))
          WHERE id = ${orgId}`),
      )
    expect(await shopifyOptedInProtectedScopes(orgId, shop)).toEqual([])
    await setFullHistory(true)
    try {
      expect(await shopifyOptedInProtectedScopes(orgId, shop)).toEqual(["read_all_orders"])
      const plan = await shopifyCliPlan(orgId, translator("en"))
      if ("error" in plan) throw new Error(plan.error.message)
      expect(plan.toml).toBe(
        shopifyAppToml(env.BASE_URL, shop, { protectedScopes: ["read_all_orders"] }),
      )
      expect(plan.toml).toContain(',read_all_orders"')
      expect(plan.toml).toContain("use_legacy_install_flow = false")
    } finally {
      await setFullHistory(false)
    }
  })
})

describe("kernel__shopify_app_toml", () => {
  test("with the client ID: the next message is replace the file, deploy, install; no card yet", () => {
    const next = shopifyTomlNextStep(true)
    const order = ["replace their shopify.app.toml", "shopify app deploy", "install on the store"]
    const at = order.map((s) => next.indexOf(s))
    for (const i of at) expect(i).toBeGreaterThanOrEqual(0)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(next).toContain("Do NOT post the client card or the Connect card in this message")
    expect(next.indexOf("kernel__request_secret")).toBeGreaterThan(next.indexOf("installed"))
    expect(shopifyTomlNextStep(false)).toContain("call this again with clientId")
  })

  test("refuses with a reason when the Shopify app is off", async () => {
    connectionConfigRegistry.deleteByPrefix([orgId, "shopify"])
    const r = await withRlsContext(admin, (tx) =>
      handleShopifyAppToml(
        {},
        { orgId, userId: admin.userId, db: tx, agentExecutionThreadId: threadId },
      ),
    )
    expect("error" in r && r.error.code).toBe("shopify_not_installed")
    expect("error" in r && r.error.status).toBe(400)
  })

  test("posts the generated file in the conversation, with the CLI steps", async () => {
    connectionConfigRegistry.set([orgId, "shopify", "shop"], {
      ...shopifyManifest.connections.shop,
      allowedDomains: [],
    } as never)
    const r = await withRlsContext(admin, (tx) =>
      handleShopifyAppToml(
        { clientId: "0123456789abcdef0123456789abcdef" },
        { orgId, userId: admin.userId, db: tx, agentExecutionThreadId: threadId },
      ),
    )
    if ("error" in r) throw new Error(r.error.message)
    if (r.clientSource === "instance") throw new Error("no instance client in this test")
    expect(r.clientSource).toBe("none")
    expect(r.posted).toBe(true)
    expect(r.filename).toBe("shopify-app.toml")
    expect(r.guide?.steps.map((s) => s.id)).toEqual([
      "file",
      "cli",
      "login",
      "deploy",
      "fullOrderHistory",
      "distribution",
      "credentials",
      "fullOrderHistorySetting",
      "connect",
    ])

    const expected = shopifyAppToml(env.BASE_URL, shopifyManifest.connections.shop, {
      clientId: "0123456789abcdef0123456789abcdef",
    })
    const attached = await withSystemDb("test-shopify-toml-attached", async (db) => {
      const [m] = await db
        .select({ id: messages.id, content: messages.content, authorType: messages.authorType })
        .from(messages)
        .where(and(eq(messages.threadId, threadId), eq(messages.content, "shopify-app.toml")))
        .limit(1)
      if (!m) return null
      const rows = await db
        .select({ filename: files.filename, sizeBytes: files.sizeBytes })
        .from(files)
        .where(
          and(eq(files.orgId, orgId), eq(files.entityType, "message"), eq(files.entityId, m.id)),
        )
      return { message: m, files: rows }
    })
    expect(attached?.message.authorType).toBe("agent")
    expect(attached?.files).toEqual([
      { filename: "shopify-app.toml", sizeBytes: Buffer.byteLength(expected, "utf8") },
    ])
  })

  test("client source instance: no file, no message, the guide is the connect step", async () => {
    connectionConfigRegistry.set([orgId, "shopify", "shop"], {
      ...shopifyManifest.connections.shop,
      allowedDomains: [],
    } as never)
    const before = await countTomlMessages()
    const r = await withInstance(SHOPIFY_INSTANCE, () =>
      withRlsContext(admin, (tx) =>
        handleShopifyAppToml(
          {},
          { orgId, userId: admin.userId, db: tx, agentExecutionThreadId: threadId },
        ),
      ),
    )
    if ("error" in r) throw new Error(`no error expected: ${r.error.message}`)
    expect(r.clientSource).toBe("instance")
    if (r.clientSource !== "instance") return
    expect(r.file).toBeNull()
    expect(r.guide?.steps.map((s) => s.id)).toEqual(["connect"])
    expect(r.nextStep).toMatch(/just connects/)
    expect(await countTomlMessages()).toBe(before)
  })

  test("client source org: the workspace's own app wins over the instance's; the file is posted", async () => {
    connectionConfigRegistry.set([orgId, "shopify", "shop"], {
      ...shopifyManifest.connections.shop,
      allowedDomains: [],
    } as never)
    await upsertConnectionOAuthClient({
      orgId,
      appName: "shopify",
      connectionName: "shop",
      clientId: "org-shopify-client-id",
      clientSecret: "org-shopify-secret",
    })
    try {
      const r = await withInstance(SHOPIFY_INSTANCE, () =>
        withRlsContext(admin, (tx) =>
          handleShopifyAppToml(
            {},
            { orgId, userId: admin.userId, db: tx, agentExecutionThreadId: threadId },
          ),
        ),
      )
      if ("error" in r) throw new Error(r.error.message)
      expect(r.clientSource).toBe("org")
      if (r.clientSource === "instance") return
      expect(r.posted).toBe(true)
      expect(r.guide?.steps.map((s) => s.id)).toContain("deploy")
    } finally {
      await withSystemDb("test-shopify-org-client-clear", (db) =>
        db
          .delete(oauthProviders)
          .where(and(eq(oauthProviders.orgId, orgId), eq(oauthProviders.name, "shopify:shop"))),
      )
    }
  })
})

async function countTomlMessages(): Promise<number> {
  return withSystemDb("test-shopify-toml-count", async (db) => {
    const rows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.threadId, threadId), eq(messages.content, "shopify-app.toml")))
    return rows.length
  })
}
