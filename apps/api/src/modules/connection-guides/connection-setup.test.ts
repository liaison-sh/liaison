// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Guard: every connection the product ships has a guide a person can follow,
// in the app (client card) and from a coding agent (`liaison guide`), from the
// same definition. A manifest that gains a connection with no steps, an OAuth
// connection without its redirect URI or scopes, or a server surface whose
// variables compose does not pass to the app, fails here.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import {
  type ConnectionDecl,
  connectionSetup,
  connectionSetupExtraSteps,
  isPublicHttps,
} from "~/modules/connection-guides/connection-setup"
import { CONNECTIONS_CALLBACK_PATH } from "~/modules/connection-guides/paths"
import { SERVER_SURFACE_IDS, serverSetup } from "~/modules/connection-guides/server-setup"
import {
  BASIC_ONBOARDING_MINUTES,
  basicOnboardingSummary,
  connectionEstimate,
  FULL_ONBOARDING_MAX_MINUTES,
  fullOnboardingSummary,
  SERVER_ESTIMATES,
  TRIAL_SUMMARY,
} from "~/modules/connection-guides/setup-timings"

const ROOT = path.resolve(import.meta.dir, "../../../../..")
const BASE = "https://liaison.example.com"
const ORG = "00000000-0000-0000-0000-000000000000"

/** Apps that ship: bundled apps and the in-tree apps, never the example or test apps. */
const NOT_SHIPPED = new Set(["example"])

interface Manifest {
  name: string
  connections?: Record<string, ConnectionDecl>
  webhooks?: Record<string, unknown>
}

function shippedManifests(): Manifest[] {
  const out: Manifest[] = []
  for (const dir of ["bundled-apps", "apps/api/src/apps"]) {
    for (const name of readdirSync(path.join(ROOT, dir))) {
      if (NOT_SHIPPED.has(name)) continue
      try {
        out.push(JSON.parse(readFileSync(path.join(ROOT, dir, name, "app.manifest.json"), "utf8")))
      } catch {
        // not an app directory
      }
    }
  }
  return out
}

const all = shippedManifests().flatMap((m) =>
  Object.entries(m.connections ?? {}).map(([connection, decl]) =>
    connectionSetup({
      baseUrl: BASE,
      orgId: ORG,
      app: m.name,
      connection,
      decl,
      webhookEndpoints: Object.keys(m.webhooks ?? {}),
    }),
  ),
)

describe("every shipped connection has a guide", () => {
  it("reads the real manifests", () => {
    const refs = all.map((s) => `${s.app}/${s.connection}`)
    for (const ref of [
      "mail/gmail",
      "shopify/shop",
      "social/facebook",
      "social/instagram",
      "gitlab/gitlab",
      "boxtal/boxtal",
      "pennylane/pennylane",
    ]) {
      expect(refs).toContain(ref)
    }
  })

  for (const s of all) {
    const ref = `${s.app}/${s.connection}`
    it(`${ref} (${s.family}) has followable steps`, () => {
      if (s.family === "app") {
        // The manifest's own steps: what to click at the provider. A summary alone is not a guide.
        expect({ ref, steps: s.steps.length > 0 }).toEqual({ ref, steps: true })
      }
      if (s.type === "oauth2") {
        expect(s.redirectUri).toBe(`${BASE}${CONNECTIONS_CALLBACK_PATH}`)
        // A provider configuration read from an app setting carries the permissions.
        expect((s.scopes?.length ?? 0) + (s.appSettings?.length ?? 0)).toBeGreaterThan(0)
      }
      if (s.type === "credentials") expect(s.fields?.length ?? 0).toBeGreaterThan(0)
      const cli = connectionSetupExtraSteps(s, "cli").map((l) => l.text)
      if (s.family === "app" && s.type === "oauth2") {
        expect(cli.some((t) => t.includes(s.redirectUri as string))).toBe(true)
        expect(cli.some((t) => t.includes(`liaison connect ${ref}`))).toBe(true)
      }
      if (s.family === "app" && s.type === "credentials") {
        expect(cli.some((t) => t.includes("liaison config apply"))).toBe(true)
      }
      expect(s.guideCommand.startsWith("liaison guide ")).toBe(true)
    })
  }
})

describe("ads/google-config (Google Ads without a developer token)", () => {
  const cfg = all.find((s) => s.app === "ads" && s.connection === "google-config")

  it("marks the legacy developer token optional in the agent's config line, so it is never collected", () => {
    expect(cfg).toBeDefined()
    if (!cfg) return
    const line = connectionSetupExtraSteps(cfg, "cli").find((l) =>
      l.text.includes("liaison config apply"),
    )
    expect(line?.text).toContain("developerToken (secret, optional)")
    expect(line?.text).toContain("merchantId (optional)")
    expect(line?.text).toMatch(/loginCustomerId, customerId/)
  })

  it("sends people to Explorer access in the Cloud console, never the API Center form", () => {
    const text = [cfg?.summary ?? "", ...(cfg?.steps ?? []).map((s) => s.text)].join("\n")
    expect(text).toContain("https://console.cloud.google.com/google/ads-apis/overview")
    expect(text).not.toContain("ads.google.com/aw/apicenter")
  })
})

describe("connection setup values", () => {
  it("Meta connections need a public https address, and say so on a local trial", () => {
    const fb = all.find((s) => s.app === "social" && s.connection === "facebook")
    expect(fb?.needsPublicHttps).toBe(true)
    const trial = connectionSetup({
      baseUrl: "http://127.0.0.1:3000",
      orgId: ORG,
      app: "social",
      connection: "facebook",
      decl: {
        type: "oauth2",
        authorizationUrl: "https://www.facebook.com/v21.0/dialog/oauth",
        scopes: ["pages_show_list"],
        setupGuide: { steps: ["x"] },
      },
      webhookEndpoints: ["meta"],
    })
    expect(trial.baseUrlPublicHttps).toBe(false)
    expect(connectionSetupExtraSteps(trial, "card")[0]?.text).toContain("public https address")
    expect(trial.webhooks).toEqual([
      { endpoint: "meta", url: `http://127.0.0.1:3000/webhooks/${ORG}/social/meta` },
    ])
  })

  it("a Google connection points at the Google guide and lists no webhook of its own", () => {
    const cal = all.find((s) => s.app === "calendar")
    expect(cal?.family).toBe("google")
    expect(cal?.webhooks).toEqual([])
    expect(cal?.guideCommand).toBe("liaison guide google --email <address>")
  })

  it("tells a public https address from a local one", () => {
    expect(isPublicHttps("https://liaison.acme.example")).toBe(true)
    expect(isPublicHttps("https://localhost:3000")).toBe(false)
    expect(isPublicHttps("http://liaison.acme.example")).toBe(false)
    expect(isPublicHttps("https://127.0.0.1")).toBe(false)
  })
})

describe("server surfaces", () => {
  const compose = readFileSync(path.join(ROOT, "deploy/docker-compose.yml"), "utf8")
  const passed = new Set([...compose.matchAll(/\$\{([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]))
  const surfaces = serverSetup({
    BASE_URL: BASE,
    EMAIL_FROM: "Liaison <noreply@liaison.example.com>",
  })

  it("lists every surface once, with steps and a check", () => {
    expect(surfaces.map((s) => s.id)).toEqual([...SERVER_SURFACE_IDS])
    for (const s of surfaces) {
      expect(s.steps.length).toBeGreaterThan(0)
      expect(s.verify.length).toBeGreaterThan(0)
    }
  })

  it("every variable a surface sets reaches the app through compose", () => {
    const missing = surfaces.flatMap((s) =>
      s.env.filter((n) => !passed.has(n)).map((n) => `${s.id}: ${n}`),
    )
    expect(missing).toEqual([])
  })

  it("computes the values from the env, and a placeholder sender is not done", () => {
    const signIn = surfaces.find((s) => s.id === "signInGoogle")
    // One Web client for sign-in and every connection: both redirect URIs on it.
    expect(signIn?.steps.find((s) => s.values)?.values).toEqual([
      `${BASE}/api/auth/oauth/callback`,
      `${BASE}/api/connections/callback`,
    ])
    const email = surfaces.find((s) => s.id === "email")
    expect(email?.done).toBe(false)
    const ok = serverSetup({
      BASE_URL: BASE,
      RESEND_API_KEY: "re_x",
      EMAIL_FROM: "Acme <noreply@mail.acme.example>",
    }).find((s) => s.id === "email")
    expect(ok?.done).toBe(true)
    expect(ok?.steps[1]?.values?.[0]).toContain("_dmarc.mail.acme.example")
    expect(JSON.stringify(ok)).not.toContain("re_x")
  })
})

describe("setup timings: one source, quoted everywhere", () => {
  it("every server surface and every shipped connection has an estimate", () => {
    expect(SERVER_SURFACE_IDS.filter((id) => !SERVER_ESTIMATES[id])).toEqual([])
    const missing = all
      .map((s) => `${s.app}/${s.connection}`)
      .filter((ref) => connectionEstimate(ref) === null)
    expect(missing).toEqual([])
  })

  it("the totals are the figures measured on a live install, not a sum of estimates", () => {
    // Measured 2026-10-31: basic onboarding about 15 min, full with every connector
    // at most about 2 h. A sum of the per-step estimates (4.5 to 8 h) overstated it.
    expect(BASIC_ONBOARDING_MINUTES).toBe(15)
    expect(FULL_ONBOARDING_MAX_MINUTES).toBe(120)
    expect(basicOnboardingSummary()).toStartWith("about 15 minutes for the basic onboarding")
    expect(fullOnboardingSummary()).toStartWith("up to about 2 hours of your own time")
  })

  it("the setup skill, the install page, the README and AGENTS.md quote the measured times", () => {
    for (const rel of [
      ".claude/skills/setup-liaison/SKILL.md",
      "docs/getting-started/install.md",
      "docs/reference/setup.md",
      "README.md",
      "AGENTS.md",
    ]) {
      const text = readFileSync(path.join(ROOT, rel), "utf8").replace(/\s+/g, " ")
      expect({ rel, full: text.includes(fullOnboardingSummary()) }).toEqual({ rel, full: true })
      expect({ rel, basic: text.includes(basicOnboardingSummary()) }).toEqual({ rel, basic: true })
      expect({ rel, trial: text.includes(TRIAL_SUMMARY) }).toEqual({ rel, trial: true })
      expect({ rel, stale: /4\.5 to 8 hours/.test(text) }).toEqual({ rel, stale: false })
    }
  })
})
