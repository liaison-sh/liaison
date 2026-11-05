// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * How ANY app connection is set up, computed from its manifest declaration and
 * this server's BASE_URL: the one source the in-app client card
 * (secret-requests/guides.ts), `liaison guide <app>/<connection>`,
 * `liaison connect` and the generated setup reference all read.
 *
 * Google and Shopify connections have their own computed guides (plan.ts):
 * `family` says which guide a surface shows. Every other connection gets its
 * manifest `setupGuide` plus the values the code fixes and a person must copy:
 * the redirect URI, the scopes, the webhook URLs, the fields to fill.
 *
 * Pure: no env, no database. Callers pass the base URL and the declarations.
 */
import { CONNECTIONS_CALLBACK_PATH } from "./paths"

/**
 * One setup step, the shape every definition uses (manifest `setupGuide.steps`,
 * the server surfaces, the computed lines). A manifest may still give a step as
 * a plain string: it reads as a HUMAN step with no page (`normalizeSetupStep`).
 */
export interface SetupStep {
  /** `human`: a console click or a browser consent; `agent`: a command or file edit. */
  who: "human" | "agent"
  text: string
  /** The page the step happens on, opened directly (never a menu path alone). */
  url?: string
  /** Where a HUMAN step without a page happens: `liaison` (a card or form in Liaison)
   *  or `own` (the person's own system: their DNS provider, terminal or computer). */
  place?: "liaison" | "own"
  /** Minutes of the person's own time. */
  minutes?: number
  /** Values to copy exactly. */
  values?: string[]
}

/** A manifest step: the structured form, or a plain string (a HUMAN step). */
export type SetupStepInput = string | SetupStep

export function normalizeSetupStep(step: SetupStepInput): SetupStep {
  return typeof step === "string" ? { who: "human", text: step } : step
}

/** A step as one markdown string, for surfaces that show plain steps (the
 *  client card, the settings popover): the text, its page, its values. */
export function setupStepMarkdown(step: SetupStep): string {
  const parts = [step.text]
  if (step.url) parts.push(`Open: <${step.url}>`)
  for (const v of step.values ?? []) parts.push(`\`${v}\``)
  return parts.join("\n\n")
}

/** The part of a manifest connection the guide reads. */
export interface ConnectionDecl {
  type: "oauth2" | "credentials"
  purpose?: string
  optional?: boolean
  authorizationUrl?: string
  scopes?: string[]
  /** Authorize parameters read from app settings (oauth-manifest-knobs.ts). */
  authorizeConfigParams?: Record<string, { configKey: string }>
  credentialFields?: Array<{ name: string; label: string; type: string; required?: boolean }>
  setupGuide?: { summary?: string; steps?: SetupStepInput[]; docsUrl?: string }
}

/** Which guide a connection gets. */
export type ConnectionFamily = "google" | "shopify" | "imap" | "app"

export interface ConnectionSetup {
  app: string
  connection: string
  type: "oauth2" | "credentials"
  family: ConnectionFamily
  purpose?: string
  optional: boolean
  summary?: string
  /** The manifest's own steps (what the person does at the provider). */
  steps: SetupStep[]
  docsUrl?: string
  /** oauth2: the redirect URI to register at the provider, exactly. */
  redirectUri?: string
  /** oauth2: the scopes (permissions) Liaison asks for. */
  scopes?: string[]
  /** oauth2: app settings the connect reads (a provider configuration's id, which
   *  then carries the permissions instead of `scopes`); set before connecting. */
  appSettings?: string[]
  /** The provider (or the person's system) calls these URLs on this server. */
  webhooks: Array<{ endpoint: string; url: string }>
  /** credentials: the fields to fill, `secret` for a password field, `optional` when it may stay empty. */
  fields?: Array<{ name: string; label: string; secret: boolean; optional?: true }>
  /** The provider must reach this server or refuses a non-https redirect. */
  needsPublicHttps: boolean
  /** BASE_URL is https on a host other than localhost / a loopback address. */
  baseUrlPublicHttps: boolean
  /** The command that prints this guide (and the connect command, for oauth2). */
  guideCommand: string
}

const GOOGLE_AUTHORIZE_HOST = "accounts.google.com"
/** Gmail push and Calendar push are part of the Google guide (google.ts). */
const GOOGLE_GUIDE_WEBHOOKS = new Set(["mail/gmail-push", "calendar/google-push"])

function hostOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url.replace(/\{[^}]+\}/g, "x")).host
  } catch {
    return null
  }
}

export function connectionFamily(
  app: string,
  name: string,
  decl: ConnectionDecl,
): ConnectionFamily {
  const host = hostOf(decl.authorizationUrl)
  if (decl.type === "oauth2" && host === GOOGLE_AUTHORIZE_HOST) return "google"
  if (app === "shopify" || (decl.authorizationUrl ?? "").includes(".myshopify.com"))
    return "shopify"
  if (decl.type === "credentials" && name === "imap") return "imap"
  return "app"
}

/** Whether people other than this machine can reach BASE_URL over https. */
export function isPublicHttps(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl)
    if (u.protocol !== "https:") return false
    return !/^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/.test(u.hostname)
  } catch {
    return false
  }
}

/** The command a surface names for one connection's guide. */
export function guideCommandFor(app: string, connection: string, family: ConnectionFamily): string {
  if (family === "google") return "liaison guide google --email <address>"
  if (family === "shopify") return "liaison guide shopify"
  if (family === "imap") return "liaison guide imap --email <address>"
  return `liaison guide ${app}/${connection}`
}

export function connectionSetup(input: {
  /** The base of the webhook URLs a person registers (the org's). */
  baseUrl: string
  /** The base of the OAuth redirect URI, when not `baseUrl`. */
  redirectBaseUrl?: string
  /** The org's id (webhook URLs carry it); a placeholder in generated docs. */
  orgId: string
  app: string
  connection: string
  decl: ConnectionDecl
  /** The app's webhook endpoint names (manifest `webhooks` keys). */
  webhookEndpoints: string[]
}): ConnectionSetup {
  const { app, connection, decl } = input
  const base = input.baseUrl.replace(/\/+$/, "")
  const family = connectionFamily(app, connection, decl)
  const webhooks =
    family === "google"
      ? []
      : input.webhookEndpoints
          .filter((e) => !GOOGLE_GUIDE_WEBHOOKS.has(`${app}/${e}`))
          .map((endpoint) => ({
            endpoint,
            url: `${base}/webhooks/${input.orgId}/${app}/${endpoint}`,
          }))
  const oauth = decl.type === "oauth2"
  const providerHost = hostOf(decl.authorizationUrl)
  return {
    app,
    connection,
    type: decl.type,
    family,
    ...(decl.purpose ? { purpose: decl.purpose } : {}),
    optional: decl.optional === true,
    ...(decl.setupGuide?.summary ? { summary: decl.setupGuide.summary } : {}),
    steps: (decl.setupGuide?.steps ?? []).map(normalizeSetupStep),
    ...(decl.setupGuide?.docsUrl ? { docsUrl: decl.setupGuide.docsUrl } : {}),
    ...(oauth
      ? {
          redirectUri: `${(input.redirectBaseUrl ?? base).replace(/\/+$/, "")}${CONNECTIONS_CALLBACK_PATH}`,
        }
      : {}),
    ...(oauth ? { scopes: [...(decl.scopes ?? [])] } : {}),
    ...(oauth && decl.authorizeConfigParams
      ? { appSettings: Object.values(decl.authorizeConfigParams).map((p) => p.configKey) }
      : {}),
    webhooks,
    ...(decl.credentialFields
      ? {
          fields: decl.credentialFields.map((f) => ({
            name: f.name,
            label: f.label,
            secret: f.type === "password",
            ...(f.required === false ? { optional: true as const } : {}),
          })),
        }
      : {}),
    // Google accepts a localhost redirect; Meta and Shopify enforce https, and a
    // webhook sender must reach this server from the internet.
    needsPublicHttps:
      webhooks.length > 0 ||
      (oauth && providerHost !== null && providerHost !== GOOGLE_AUTHORIZE_HOST),
    baseUrlPublicHttps: isPublicHttps(base),
    guideCommand: guideCommandFor(app, connection, family),
  }
}

/** A computed line: a step with no page of its own (it happens on the page of
 *  the manifest steps before it, or in a command). */
export type SetupLine = SetupStep

/**
 * The computed steps of a connection, after its manifest steps: what to copy
 * into the provider's console and how Liaison receives the values. Plain text,
 * one step each; the client card and the CLI show the same lines (the CLI adds
 * how the values reach the config).
 */
export function connectionSetupExtraSteps(
  setup: ConnectionSetup,
  surface: "card" | "cli",
): SetupLine[] {
  const out: SetupLine[] = []
  const human = (text: string) => {
    out.push({ who: "human", text })
  }
  const agent = (text: string) => {
    out.push({ who: "agent", text })
  }
  if (setup.needsPublicHttps && !setup.baseUrlPublicHttps) {
    human(
      `This connection needs Liaison on a public https address, and this server's address (${setup.redirectUri ? setup.redirectUri.replace(CONNECTIONS_CALLBACK_PATH, "") : "BASE_URL"}) is not one: move the server to its domain first (or put an https tunnel in front of it and set BASE_URL to the tunnel's address).`,
    )
  }
  if (setup.redirectUri) {
    human(
      `In the provider's app settings, add this exact redirect URI (also called callback URL or Valid OAuth Redirect URI): ${setup.redirectUri}`,
    )
  }
  if (setup.scopes && setup.scopes.length > 0) {
    human(`Give the app these permissions (scopes), no more: ${setup.scopes.join(", ")}`)
  }
  if (setup.appSettings && setup.appSettings.length > 0) {
    const keys = setup.appSettings.join(", ")
    agent(
      surface === "cli"
        ? `Before connecting, set the ${setup.app} app setting ${keys} (the value the steps above copy): \`apps[].config\` in the config, then \`liaison config apply\`.`
        : `Before connecting, set the ${setup.app} app setting ${keys} (the value the steps above copy) with kernel__config_apps.`,
    )
  }
  for (const w of setup.webhooks) {
    human(
      `This server receives the app's \`${w.endpoint}\` webhook at ${w.url} (the steps above say who registers it).`,
    )
  }
  if (surface === "cli") {
    if (setup.type === "oauth2") {
      agent(
        `The owner pastes the app's client ID and client secret into deploy/.setup-secrets.env (never the chat); reference them as \${NAME} in the config: an \`apps\` entry { name: ${setup.app}, connection: { name: ${setup.connection}, oauthClient: { clientId, clientSecret } } } (repeat the app's entry once per connection), run \`liaison config apply\`, then \`liaison connect ${setup.app}/${setup.connection} --config <path>\` and open the URL it prints to approve.`,
      )
    } else if (setup.fields) {
      const names = setup.fields
        .map((f) => {
          const notes = [f.secret ? "secret" : "", f.optional ? "optional" : ""].filter(Boolean)
          return notes.length > 0 ? `${f.name} (${notes.join(", ")})` : f.name
        })
        .join(", ")
      agent(
        `The owner pastes the secret values into deploy/.setup-secrets.env (never the chat); put the values in the config: an \`apps\` entry { name: ${setup.app}, connection: { name: ${setup.connection}, credentials: { ${names} } } }, secrets as \${ENV} references to the secrets file, then run \`liaison config apply\` and \`liaison config verify --app ${setup.app}\`.`,
      )
    }
  }
  return out
}
