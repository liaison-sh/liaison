// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `liaison guide` prints the agent's own guide: the same path, values and
 * shared-builder steps, as text or JSON. Real test DB for the org; the app
 * registry warm-up and the MX lookup are injected.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { createGuide, type GuideDeps } from "~/cli/guide"
import { env } from "~/lib/env"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let orgSlug: string

beforeAll(async () => {
  await acquireTestLock()
  orgSlug = `cli-guide-${crypto.randomUUID().slice(0, 12)}`
  orgId = (await ensureOrg({ slug: orgSlug, name: "GuideTestOrg" })).orgId
})
afterAll(async () => {
  connectionConfigRegistry.deleteByPrefix([orgId])
  await releaseTestLock()
})

function run(overrides: Partial<GuideDeps> = {}) {
  const out: string[] = []
  const err: string[] = []
  const deps: GuideDeps = {
    ensureAppsForOrg: async () => {},
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    resolver: async () => [{ exchange: "aspmx.l.google.com" }],
    ...overrides,
  }
  return { guide: createGuide(deps), out, err }
}

const instance = env as { GMAIL_OAUTH_CLIENT_ID?: string; GMAIL_OAUTH_CLIENT_SECRET?: string }
async function withInstanceClient<T>(fn: () => Promise<T>): Promise<T> {
  const saved = [instance.GMAIL_OAUTH_CLIENT_ID, instance.GMAIL_OAUTH_CLIENT_SECRET] as const
  instance.GMAIL_OAUTH_CLIENT_ID = "instance-guide.apps.googleusercontent.com"
  instance.GMAIL_OAUTH_CLIENT_SECRET = "instance-guide-secret"
  try {
    return await fn()
  } finally {
    instance.GMAIL_OAUTH_CLIENT_ID = saved[0]
    instance.GMAIL_OAUTH_CLIENT_SECRET = saved[1]
  }
}

describe("liaison guide", () => {
  test("an unknown provider or locale is a usage error, exit 2", async () => {
    const a = run()
    expect((await a.guide({ provider: "outlook", orgSlug })).exitCode).toBe(2)
    expect(a.err.join("")).toContain("usage: liaison guide")
    const b = run()
    expect((await b.guide({ provider: "google", orgSlug, locale: "de" })).exitCode).toBe(2)
  })

  test("google --json: a Workspace address on an unverified instance client is the trusted path", async () => {
    const { guide, out } = run()
    const res = await withInstanceClient(() =>
      guide({ provider: "google", email: "ana@acme.example", orgSlug, json: true }),
    )
    expect(res.exitCode).toBe(0)
    const report = JSON.parse(out.join("")) as {
      path: string
      accountType: string
      guide: { steps: Array<{ id: string; values?: string[] }> }
    }
    expect(report.path).toBe("trusted")
    expect(report.accountType).toBe("google_workspace")
    expect(report.guide.steps.map((s) => s.id)).toEqual([
      "admin",
      "open",
      "add",
      "scope",
      "trust",
      "connect",
    ])
    expect(report.guide.steps.find((s) => s.id === "add")?.values).toEqual([
      "instance-guide.apps.googleusercontent.com",
    ])
    expect(out.join("")).not.toContain("instance-guide-secret")
  })

  test("google --json: an instance client Internal to the address's Workspace is consent, no Trusted steps", async () => {
    const internalEnv = env as { GOOGLE_OAUTH_INTERNAL_DOMAINS?: string }
    const saved = internalEnv.GOOGLE_OAUTH_INTERNAL_DOMAINS
    internalEnv.GOOGLE_OAUTH_INTERNAL_DOMAINS = "acme.example"
    try {
      const { guide, out } = run()
      const res = await withInstanceClient(() =>
        guide({ provider: "google", email: "ana@acme.example", orgSlug, json: true }),
      )
      expect(res.exitCode).toBe(0)
      const report = JSON.parse(out.join("")) as {
        path: string
        guide: { steps: Array<{ id: string; optional?: boolean; links?: Array<{ url: string }> }> }
      }
      expect(report.path).toBe("consent")
      const ids = report.guide.steps.map((s) => s.id)
      expect(ids).not.toContain("trust")
      const check = report.guide.steps.find((s) => s.id === "internalTrust")
      expect(check?.optional).toBe(true)
      expect(check?.links?.[0]?.url).toBe("https://admin.google.com/ac/owl")
    } finally {
      internalEnv.GOOGLE_OAUTH_INTERNAL_DOMAINS = saved
    }
  })

  test("google --project must be a Cloud project ID", async () => {
    const r = run()
    expect(
      (await r.guide({ provider: "google", orgSlug, project: "Not a project!" })).exitCode,
    ).toBe(2)
    expect(r.err.join("")).toContain("--project")
  })

  test("google text in French: a personal Gmail gets the statement, then the IMAP steps", async () => {
    const { guide, out } = run()
    const res = await withInstanceClient(() =>
      guide({ provider: "google", email: "ana@gmail.com", orgSlug, locale: "fr" }),
    )
    expect(res.exitCode).toBe(0)
    const text = out.join("")
    expect(text).toContain("path: consumer_imap")
    expect(text).toContain("Google Workspace")
    expect(text).toContain("imap.gmail.com:993")
  })

  test("google: a personal Gmail on the instance's unverified Drive client is Drive picked mode, with the in-app picker link", async () => {
    const drive = instance as typeof instance & {
      GOOGLE_DRIVE_OAUTH_CLIENT_ID?: string
      GOOGLE_DRIVE_OAUTH_CLIENT_SECRET?: string
    }
    const saved = [drive.GOOGLE_DRIVE_OAUTH_CLIENT_ID, drive.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET]
    drive.GOOGLE_DRIVE_OAUTH_CLIENT_ID = "instance-drive.apps.googleusercontent.com"
    drive.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET = "instance-drive-secret"
    try {
      const text = run()
      await withInstanceClient(() =>
        text.guide({ provider: "google", email: "ana@gmail.com", orgSlug }),
      )
      expect(text.out.join("")).toContain("Google Drive: picked")
      expect(text.out.join("")).toContain("/settings/apps/google-drive")
      const json = run()
      await withInstanceClient(() =>
        json.guide({ provider: "google", email: "ana@gmail.com", orgSlug, json: true }),
      )
      const report = JSON.parse(json.out.join("")) as {
        driveMode: string
        drivePicker?: { url: string }
      }
      expect(report.driveMode).toBe("picked")
      expect(report.drivePicker?.url).toContain("/settings/apps/google-drive")
      const workspace = run()
      await withInstanceClient(() =>
        workspace.guide({ provider: "google", email: "ana@acme.example", orgSlug, json: true }),
      )
      expect((JSON.parse(workspace.out.join("")) as { driveMode: string }).driveMode).toBe("full")
    } finally {
      drive.GOOGLE_DRIVE_OAUTH_CLIENT_ID = saved[0]
      drive.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET = saved[1]
    }
  })

  test("imap without an address lists every known provider's steps", async () => {
    const { guide, out } = run()
    expect((await guide({ provider: "imap", orgSlug })).exitCode).toBe(0)
    const text = out.join("")
    for (const host of ["imap.gmail.com", "imap.mail.me.com", "imap.fastmail.com"]) {
      expect(text).toContain(host)
    }
    expect(text).toContain("Outlook")
  })

  test("shopify with the app off: exit 1, saying to turn it on", async () => {
    connectionConfigRegistry.deleteByPrefix([orgId, "shopify"])
    const { guide, err } = run()
    expect((await guide({ provider: "shopify", orgSlug })).exitCode).toBe(1)
    expect(err.join("")).toContain("Shopify app is not on")
  })
})

describe("liaison guide server and <app>/<connection>", () => {
  test("server: every surface with its state and HUMAN / AGENT steps, no org needed", async () => {
    const r = run()
    expect((await r.guide({ provider: "server", json: true })).exitCode).toBe(0)
    const json = JSON.parse(r.out.join("")) as { server: Array<{ id: string; steps: unknown[] }> }
    expect(json.server.map((s) => s.id)).toContain("email")
    const t = run()
    await t.guide({ provider: "server" })
    const text = t.out.join("")
    expect(text).toContain("[HUMAN]")
    expect(text).toContain("[AGENT]")
    expect(text).toContain(`${env.BASE_URL.replace(/\/+$/, "")}/api/auth/oauth/callback`)
  })

  test("an app connection: the manifest steps, then the redirect URI, scopes and the config + connect commands", async () => {
    connectionConfigRegistry.set([orgId, "acme-crm", "crm"], {
      type: "oauth2",
      authorizationUrl: "https://crm.acme.example/oauth/authorize",
      tokenUrl: "https://crm.acme.example/oauth/token",
      scopes: ["contacts.read"],
      allowedDomains: ["crm.acme.example"],
      setupGuide: {
        summary: "Create an OAuth app in Acme CRM.",
        steps: ["Open Acme CRM settings."],
      },
    })
    const r = run()
    expect((await r.guide({ provider: "acme-crm/crm", orgSlug })).exitCode).toBe(0)
    const text = r.out.join("")
    expect(text).toContain("1. [HUMAN] Open Acme CRM settings.")
    expect(text).toContain(`${env.BASE_URL.replace(/\/+$/, "")}/api/connections/callback`)
    expect(text).toContain("contacts.read")
    expect(text).toContain("liaison connect acme-crm/crm --config <path>")
  })

  test("an unknown connection: exit 2, listing the known ones", async () => {
    const r = run()
    expect((await r.guide({ provider: "nope/nothing", orgSlug })).exitCode).toBe(2)
    expect(r.err.join("")).toContain("acme-crm/crm")
  })
})
