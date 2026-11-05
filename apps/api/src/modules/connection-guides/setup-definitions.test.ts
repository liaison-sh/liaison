// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Guards on the setup definitions, the one source every surface reads (the
// in-product agent and its cards, `liaison guide`, the setup skill, the setup
// reference): the shared guides (packages/shared setup-guides.ts), the manifests'
// `setupGuide` and the server surfaces.
//
// - every HUMAN step done in a console carries its direct page (a menu path alone
//   is not enough), and every shipped manifest step says who does it;
// - every HUMAN step carries its own time (minutes), the steps of a guide, a
//   connection or a server surface fit the row that times them, and the rows add
//   up to the measured totals every surface quotes (basic, full);
// - the in-product agent's setup prompts restate no setup fact (page, scope, env
//   variable, config change) the definitions do not hold, so the prompts and the
//   definitions cannot drift apart.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import {
  GMAIL_PUSH_PUBLISHER,
  type GoogleSetupValues,
  googleSetupGuide,
  googleTrustedGuide,
  IMAP_PROVIDERS,
  type ImapProvider,
  imapPasswordGuide,
  MAILBOX_MODE_CHOICE,
  SETUP_GUIDE_IDS,
  SETUP_URLS,
  type SetupGuide,
  type SetupGuideTranslate,
  SHOPIFY_ALL_ORDERS_REASON,
  shopifyDashboardGuide,
  shopifyFullOrderHistoryValues,
  shopifySetupGuide,
} from "@liaison/shared"
import type { ConnectionDecl, SetupStepInput } from "~/modules/connection-guides/connection-setup"
import { SERVER_SURFACE_IDS, serverSetup } from "~/modules/connection-guides/server-setup"
import {
  BASIC_ONBOARDING_MINUTES,
  connectionEstimate,
  estimateTotals,
  FULL_ONBOARDING_MAX_MINUTES,
  guideEstimate,
  SERVER_ESTIMATES,
  spoken,
} from "~/modules/connection-guides/setup-timings"
import {
  type ShopifyConnectionManifest,
  shopifyAppToml,
  shopifyAppValues,
} from "~/modules/connection-guides/shopify-app-toml"
import { serverT } from "~/modules/i18n/server-i18n"

const ROOT = path.resolve(import.meta.dir, "../../../../..")
const BASE = "https://liaison.example.com"
const t: SetupGuideTranslate = (key, params) => serverT("en", key, params)

interface Manifest {
  name: string
  connections?: Record<string, ConnectionDecl>
}

function shippedManifests(): Array<{ manifest: Manifest; raw: string }> {
  const out: Array<{ manifest: Manifest; raw: string }> = []
  for (const dir of ["bundled-apps", "apps/api/src/apps"]) {
    for (const name of readdirSync(path.join(ROOT, dir))) {
      if (name === "example") continue
      try {
        const raw = readFileSync(path.join(ROOT, dir, name, "app.manifest.json"), "utf8")
        out.push({ manifest: JSON.parse(raw), raw })
      } catch {
        // not an app directory
      }
    }
  }
  return out
}

const manifests = shippedManifests()
const shopifyManifest = manifests.find((m) => m.manifest.name === "shopify")?.manifest
const shopifyShop = shopifyManifest?.connections?.shop as unknown as ShopifyConnectionManifest

const googleValues = (over: Partial<GoogleSetupValues> = {}): GoogleSetupValues => ({
  baseUrl: BASE,
  connectionsRedirectUri: `${BASE}/api/connections/callback`,
  signIn: { enabled: true, redirectUri: `${BASE}/api/auth/oauth/callback` },
  redirectUris: [`${BASE}/api/connections/callback`, `${BASE}/api/auth/oauth/callback`],
  scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.modify"],
  apis: [{ id: "gmail.googleapis.com", name: "Gmail API" }],
  unmappedScopes: [],
  connections: [],
  gmailPush: {
    publisher: GMAIL_PUSH_PUBLISHER,
    endpoint: `${BASE}/webhooks/org/mail/gmail-push`,
    instanceTopic: false,
  },
  instanceClientOnly: false,
  clientReady: false,
  verifyApis: false,
  clients: {
    workspace: { source: "none", restrictedVerified: false },
    drive: { source: "none", restrictedVerified: false },
  },
  ...over,
})

/** Every shared guide, in every variant a surface can get. */
function allGuides(): Array<{ name: string; guide: SetupGuide }> {
  const out: Array<{ name: string; guide: SetupGuide }> = []
  out.push({ name: "google", guide: googleSetupGuide(googleValues(), t) })
  out.push({ name: "google:noApis", guide: googleSetupGuide(googleValues({ apis: [] }), t) })
  out.push({
    name: "google:verify",
    guide: googleSetupGuide(googleValues({ clientReady: true, verifyApis: true }), t),
  })
  out.push({
    name: "google:instance",
    guide: googleSetupGuide(googleValues({ instanceClientOnly: true }), t),
  })
  out.push({
    name: "googleTrusted",
    guide: googleTrustedGuide(
      {
        baseUrl: BASE,
        clients: [
          { family: "workspace", clientId: "1-a.apps.googleusercontent.com" },
          { family: "drive", clientId: "2-b.apps.googleusercontent.com" },
        ],
      },
      t,
    ),
  })
  for (const surface of ["app", "agent"] as const) {
    for (const hasClientId of [false, true]) {
      out.push({
        name: `shopify:${surface}:${hasClientId}`,
        guide: shopifySetupGuide(
          {
            clientSource: "none",
            callbackUrl: `${BASE}/api/connections/callback`,
            hasClientId,
            handedFilename: "shopify-app.toml",
            surface,
          },
          t,
        ),
      })
    }
    out.push({
      name: `shopifyDashboard:${surface}`,
      guide: shopifyDashboardGuide(
        {
          clientSource: "none",
          ...shopifyAppValues(BASE, shopifyShop),
          protectedScopes: (shopifyShop.protectedScopes ?? []).map((p) => p.scope),
          surface,
        },
        t,
      ),
    })
  }
  for (const p of Object.keys(IMAP_PROVIDERS) as ImapProvider[]) {
    out.push({ name: `imap:${p}`, guide: imapPasswordGuide(p, t) })
  }
  return out
}

describe("every HUMAN console step carries its direct page", () => {
  it("in the shared guides", () => {
    const missing: string[] = []
    for (const { name, guide } of allGuides()) {
      for (const step of guide.steps) {
        if (step.who === "agent" || step.place) continue
        if ((step.links ?? []).every((l) => !l.url.startsWith("https://")))
          missing.push(`${name}/${step.id}`)
      }
    }
    expect(missing).toEqual([])
  })

  it("in the shipped manifests, whose steps all say who does them", () => {
    const problems: string[] = []
    for (const { manifest } of manifests) {
      for (const [conn, decl] of Object.entries(manifest.connections ?? {})) {
        const ref = `${manifest.name}/${conn}`
        for (const [i, step] of ((decl.setupGuide?.steps ?? []) as SetupStepInput[]).entries()) {
          if (typeof step === "string") problems.push(`${ref}#${i + 1}: a plain string`)
          else if (step.who === "human" && !step.url && !step.place)
            problems.push(`${ref}#${i + 1}: a HUMAN step with no page`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it("in the server surfaces", () => {
    const missing: string[] = []
    for (const env of [{}, { BASE_URL: BASE, EMAIL_FROM: "Acme <noreply@mail.acme.example>" }]) {
      for (const s of serverSetup(env)) {
        for (const [i, step] of s.steps.entries()) {
          if (step.who === "human" && !step.url && !step.place) missing.push(`${s.id}#${i + 1}`)
        }
      }
    }
    expect(missing).toEqual([])
    expect(SERVER_SURFACE_IDS.length).toBeGreaterThan(0)
  })
})

/** Every shared guide's id (setup-guides.ts SETUP_GUIDE_IDS) from its variant name. */
const guideIdOf = (name: string) => name.split(":")[0] as string

const hasMinutes = (m: unknown) => typeof m === "number" && Number.isInteger(m) && m >= 0

describe("every HUMAN step carries its own time, and the times add up", () => {
  it("in the shared guides", () => {
    const missing: string[] = []
    for (const { name, guide } of allGuides())
      for (const step of guide.steps)
        if (step.who !== "agent" && !hasMinutes(step.minutes)) missing.push(`${name}/${step.id}`)
    expect(missing).toEqual([])
  })

  it("in the shipped manifests", () => {
    const missing: string[] = []
    for (const { manifest } of manifests)
      for (const [conn, decl] of Object.entries(manifest.connections ?? {}))
        for (const [i, step] of ((decl.setupGuide?.steps ?? []) as SetupStepInput[]).entries())
          if (typeof step !== "string" && step.who === "human" && !hasMinutes(step.minutes))
            missing.push(`${manifest.name}/${conn}#${i + 1}`)
    expect(missing).toEqual([])
  })

  it("in the server surfaces", () => {
    const missing: string[] = []
    for (const env of [{}, { BASE_URL: BASE, EMAIL_FROM: "Acme <noreply@mail.acme.example>" }])
      for (const s of serverSetup(env))
        for (const [i, step] of s.steps.entries())
          if (step.who === "human" && !hasMinutes(step.minutes)) missing.push(`${s.id}#${i + 1}`)
    expect(missing).toEqual([])
  })

  it("each shared guide has a row, and its required HUMAN steps fit it", () => {
    expect(SETUP_GUIDE_IDS.filter((id) => !guideEstimate(id))).toEqual([])
    const over: string[] = []
    for (const { name, guide } of allGuides()) {
      const high = guideEstimate(guideIdOf(name))?.minutes[1] ?? 0
      const sum = guide.steps
        .filter((s) => s.who !== "agent" && !s.optional)
        .reduce((n, s) => n + (s.minutes ?? 0), 0)
      if (sum > high) over.push(`${name}: ${sum} > ${high}`)
    }
    expect(over).toEqual([])
  })

  it("each manifest connection's HUMAN steps fit its group's row", () => {
    const over: string[] = []
    for (const { manifest } of manifests) {
      for (const [conn, decl] of Object.entries(manifest.connections ?? {})) {
        const steps = (decl.setupGuide?.steps ?? []) as SetupStepInput[]
        const sum = steps.reduce((n, s) => n + (typeof s === "string" ? 0 : (s.minutes ?? 0)), 0)
        const ref = `${manifest.name}/${conn}`
        const high = connectionEstimate(ref)?.minutes[1]
        if (sum > 0 && high === undefined) over.push(`${ref}: no row`)
        if (high !== undefined && sum > high) over.push(`${ref}: ${sum} > ${high}`)
      }
    }
    expect(over).toEqual([])
  })

  it("each server surface's HUMAN steps fit its row (a zero row: not part of a single-company setup)", () => {
    const over: string[] = []
    for (const s of serverSetup({ BASE_URL: BASE })) {
      const high = SERVER_ESTIMATES[s.id]?.minutes[1] ?? 0
      if (high === 0) continue
      const sum = s.steps.reduce((n, st) => n + (st.who === "human" ? (st.minutes ?? 0) : 0), 0)
      if (sum > high) over.push(`${s.id}: ${sum} > ${high}`)
    }
    expect(over).toEqual([])
  })

  it("the basic rows add up to the measured basic onboarding", () => {
    const [low, high] = estimateTotals().basic
    expect(low).toBeLessThanOrEqual(BASIC_ONBOARDING_MINUTES)
    expect(high).toBeGreaterThanOrEqual(BASIC_ONBOARDING_MINUTES)
    // "about 15 minutes" is not a range of an hour.
    expect(high).toBeLessThanOrEqual(BASIC_ONBOARDING_MINUTES * 2)
  })

  it("the full onboarding's rows add up to the measured 'up to about 2 hours', waits apart", () => {
    const [, high] = estimateTotals().full
    expect(high).toBeLessThanOrEqual(FULL_ONBOARDING_MAX_MINUTES)
    expect(spoken(high)).toBe(spoken(FULL_ONBOARDING_MAX_MINUTES))
  })
})

// --- drift: the in-product agent's setup prompts against the definitions --------

/** The setup texts that must not restate a fact the definitions lack: the in-product
 *  agent's setup prompts (the onboarding one included) and the coding agent's skill. */
const PROMPTS = [
  ...["google-setup.md", "shopify-setup.md", "setup-guide.md"].map((f) =>
    path.join("apps/api/src/modules/agent/prompts/kernel", f),
  ),
  ".claude/skills/setup-liaison/SKILL.md",
].map((file) => ({ file, text: readFileSync(path.join(ROOT, file), "utf8") }))

/**
 * Facts a setup text may state that are not setup definitions, each with why.
 * Anything else a prompt or the skill names must be in the definitions.
 */
const NOT_SETUP_FACTS: Record<string, string> = {
  GITHUB_TOKEN:
    "a secrets-file key the coding agent reads to clone a private GitHub repository for the knowledge gathering: no server setting, no connection field",
  GITLAB_TOKEN:
    "the same secrets-file key for a private GitLab repository (the gitlab connection's field is `token`, interpolated from it in the example config)",
  SUPPORT_IMAP_PASSWORD:
    "a secrets-file key the config file interpolates into the tickets/imap `password` field: the field is the manifest's, the key only its name in the file",
  "github.com/mathieufro/liaison/tree/main/docs":
    "the product's own documentation, linked so the owner can read more: not a setup page",
  "github.com/mathieufro/liaison/blob/main/docs/":
    "the same documentation, one page at a time: not a setup page",
  "github.com/acme/widget": "an example repository in a knowledge-gathering command",
  "acme.myshopify.com": "an example store address in a config entry",
  "atlassian.net": "the example Jira site address (`<site>.atlassian.net`) in an import request",
}

/** UI labels a prompt may name: each must be in the definitions too. */
const LABELS = ["Dev Dashboard", "Shopify CLI"]

/** Everything the definitions say, as one text, and every value a step hands over. */
function definitions(): { text: string; values: Set<string> } {
  const guides = allGuides()
  const values = new Set<string>()
  for (const { guide } of guides)
    for (const s of guide.steps) for (const v of s.values ?? []) values.add(v)
  for (const v of shopifyFullOrderHistoryValues("app")) values.add(v)
  const text = [
    JSON.stringify(guides),
    ...manifests.map((m) => m.raw),
    readFileSync(path.join(ROOT, "packages/shared/src/i18n/locales/en/setup-guides.json"), "utf8"),
    JSON.stringify(SETUP_URLS),
    SHOPIFY_ALL_ORDERS_REASON,
    shopifyAppToml(BASE, shopifyShop),
    // The server surfaces (domain, mail sender, model keys...) and their variables.
    ...[{}, { BASE_URL: BASE }].map((env) => JSON.stringify(serverSetup(env))),
  ].join("\n")
  return { text, values }
}

/** The setup facts a prompt states: pages, scopes, env variables, config changes. */
function promptFacts(text: string): {
  urls: string[]
  scopes: string[]
  envVars: string[]
  configChanges: string[]
  labels: string[]
} {
  const urls = [
    ...text.matchAll(
      /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|dev|google|io|net|org)(?:\/[^\s`'")<>,]*)?/gi,
    ),
  ]
    .map((m) => m[0].replace(/[.:;]+$/, ""))
    .filter((u) => !/^your-store\./.test(u))
  const scopes = [...text.matchAll(/\b(?:read|write)_[a-z_]+\b/g)].map((m) => m[0])
  const envVars = [...text.matchAll(/\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/g)].map((m) => m[0])
  const configChanges = [...text.matchAll(/`(\{[^`]*\})`/g)].flatMap((m) => {
    try {
      return [JSON.stringify(JSON.parse(m[1] as string))]
    } catch {
      return [m[1] as string]
    }
  })
  const labels = LABELS.filter((l) => text.includes(l))
  return { urls, scopes, envVars, configChanges, labels }
}

describe("the in-product setup prompts restate nothing the definitions lack", () => {
  const defs = definitions()
  for (const { file, text } of PROMPTS) {
    it(file, () => {
      const f = promptFacts(text)
      const strip = (u: string) => u.replace(/^https?:\/\//, "")
      const known = (fact: string) => defs.text.includes(fact) || fact in NOT_SETUP_FACTS
      expect({
        urls: f.urls.filter((u) => !known(strip(u))),
        scopes: f.scopes.filter((s) => !known(s)),
        envVars: f.envVars.filter((v) => !known(v)),
        // A config change the agent makes is a step value, never prompt text.
        configChanges: f.configChanges.filter((c) => !defs.values.has(c)),
        labels: f.labels.filter((l) => !defs.text.includes(l)),
      }).toEqual({ urls: [], scopes: [], envVars: [], configChanges: [], labels: [] })
    })
  }

  it("every non-setup fact is still named by a setup text, and is not a definition", () => {
    const all = PROMPTS.map((p) => p.text).join("\n")
    expect(Object.keys(NOT_SETUP_FACTS).filter((f) => !all.includes(f))).toEqual([])
    expect(Object.keys(NOT_SETUP_FACTS).filter((f) => defs.text.includes(f))).toEqual([])
  })

  it("catches a fact that lives only in a prompt", () => {
    const f = promptFacts(
      'Open https://example.com/only-here, add `read_secret_things`, set ONLY_IN_PROMPT, then `{ "apps": [{ "name": "x" }] }`.',
    )
    expect(f.urls).toContain("https://example.com/only-here")
    expect(f.scopes).toContain("read_secret_things")
    expect(f.envVars).toContain("ONLY_IN_PROMPT")
    expect(f.configChanges).toEqual(['{"apps":[{"name":"x"}]}'])
    const defs = definitions()
    expect(defs.values.has(f.configChanges[0] as string)).toBe(false)
  })

  it("the full-order-history change the agent makes is in the guide, for both surfaces", () => {
    const [tool, change] = shopifyFullOrderHistoryValues("app")
    expect(tool).toBe("kernel__config_apps")
    expect(JSON.parse(change as string)).toEqual({
      apps: [{ name: "shopify", enable: true, settings: { fullOrderHistory: true } }],
    })
    expect(shopifyFullOrderHistoryValues("agent")).toContain("liaison config apply")
    const dash = allGuides().find((g) => g.name === "shopifyDashboard:agent")?.guide
    const step = dash?.steps.find((s) => s.id === "fullOrderHistorySetting")
    expect(step?.who).toBe("agent")
    expect(step?.values?.[0]).toContain("fullOrderHistory: true")
  })
})

// --- the mailbox question: one pair of sentences on every surface ---------------

describe("standard or private mailbox says the same everywhere", () => {
  const flat = (t: string) => t.replace(/\s+/g, " ")
  const surfaces = {
    "in-product setup prompt": readFileSync(
      path.join(import.meta.dir, "../agent/prompts/kernel/setup-guide.md"),
      "utf8",
    ),
    "setup skill": readFileSync(path.join(ROOT, ".claude/skills/setup-liaison/SKILL.md"), "utf8"),
  }
  for (const [name, text] of Object.entries(surfaces)) {
    it(name, () => {
      expect(flat(text)).toContain(MAILBOX_MODE_CHOICE.standard)
      expect(flat(text)).toContain(MAILBOX_MODE_CHOICE.private)
    })
  }
  it("the in-app choice (Settings > Mail and the connect page)", () => {
    const mail = JSON.parse(
      readFileSync(path.join(ROOT, "packages/shared/src/i18n/locales/en/mail.json"), "utf8"),
    ) as { encryption: { transparentHelp: string; privateHelp: string } }
    expect(mail.encryption.transparentHelp).toContain(MAILBOX_MODE_CHOICE.standard)
    expect(mail.encryption.privateHelp).toContain(MAILBOX_MODE_CHOICE.private)
  })
})
