// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Provider setup guides as structured steps: Google (an OAuth client in Google
 * Cloud, or the instance's client marked Trusted by a Workspace admin), Shopify
 * (an app made in the Shopify Dev Dashboard, or with the Shopify CLI) and a
 * mailbox over IMAP with an app password. The agent, the client card, the
 * `liaison guide` command and the setup skill all print these same steps. A card renders them with its own `t()`, the agent reads them
 * through a kernel tool rendered with `serverT`; both get the same steps.
 *
 * Every string comes from the `setup-guides` i18n namespace. Every value a person
 * copies (a redirect URI, a scope, an API name, a command) is in `values`, taken
 * from the computed setup values, never typed into the copy.
 */

/** The guides this module builds, one per feature: each has a time (setup-timings.ts
 *  `guideEstimate`), so a surface says how long a guide takes before its first step. */
export const SETUP_GUIDE_IDS = [
  "google",
  "googleTrusted",
  "shopify",
  "shopifyDashboard",
  "imap",
] as const
export type SetupGuideId = (typeof SETUP_GUIDE_IDS)[number]

/** One step of a guide. `values` are the exact strings to copy, in order. */
export interface SetupGuideStep {
  id: string
  title: string
  body: string
  values?: string[]
  /** Pages the step happens on, opened from the guide (label: what the page is).
   *  Every HUMAN step done in a provider's console has one (a guard test checks). */
  links?: Array<{ label: string; url: string }>
  /** The setup works without this step. */
  optional?: boolean
  /** Who does it: `human` (the default: a console, a browser, a card) or `agent`
   *  (the agent does it with a tool or a command; the person only approves). */
  who?: "human" | "agent"
  /** Where a HUMAN step without a console page happens: `liaison` (a card or form
   *  in Liaison) or `own` (the person's own terminal or computer). */
  place?: "liaison" | "own"
  /** Minutes of the person's own time. Every HUMAN step has it (a guard test checks);
   *  the agent says it before the step. */
  minutes?: number
}

/** Where a guide is read: `app` (the in-product agent and its cards: kernel tools)
 *  or `agent` (a coding agent with the `liaison` CLI: config apply, commands). The
 *  same values, the same steps; only how an AGENT step is carried out differs. */
export type SetupSurface = "app" | "agent"

/**
 * The mailbox question every setup surface asks for a person's own mailbox
 * (the in-product agent, the setup skill, `liaison connect --for`), with the
 * one sentence on each answer. The in-app choice says the same in its i18n
 * strings (`mail.encryption.transparentHelp` / `privateHelp`).
 */
export const MAILBOX_MODE_CHOICE = {
  question: "Standard or private mailbox?",
  standard: "Standard (transparent) mailboxes are read server-side and routines run unattended.",
  private:
    "For security, routines and agents can't read private mail while you're offline: those runs wait for you (Run now).",
} as const

/** The consoles the guides open, as direct pages (never a menu path alone). */
export const SETUP_URLS = {
  googleProjectCreate: "https://console.cloud.google.com/projectcreate",
  googleApiLibrary: "https://console.cloud.google.com/apis/library",
  googleAudience: "https://console.cloud.google.com/auth/audience",
  googleBranding: "https://console.cloud.google.com/auth/branding",
  googleDataAccess: "https://console.cloud.google.com/auth/scopes",
  googleClients: "https://console.cloud.google.com/auth/clients",
  googlePubSubTopics: "https://console.cloud.google.com/cloudpubsub/topic/list",
  googleAdminAppAccess: "https://admin.google.com/ac/owl/list?tab=configuredApps",
  /** API controls, where "Trust internal, domain-owned apps" is ticked. */
  googleAdminApiControls: "https://admin.google.com/ac/owl",
  shopifyDevDashboard: "https://dev.shopify.com/dashboard",
  shopifyPartnerDashboard: "https://partners.shopify.com",
  shopifyCliInstall: "https://shopify.dev/docs/api/shopify-cli",
  appleAccount: "https://account.apple.com/account/manage",
  fastmailSecurity: "https://app.fastmail.com/settings/security",
} as const

/** The page of one Google API in the API Library, where its Enable button is, with
 *  the Cloud project preselected when its id is known (no project picker to get wrong). */
export function googleApiUrl(apiId: string, projectId?: string): string {
  return googleConsoleUrl(`${SETUP_URLS.googleApiLibrary}/${apiId}`, projectId)
}

/** A Google Cloud console page with the Cloud project preselected when its id is
 *  known, so every page opens on the right project (no project picker to get wrong). */
export function googleConsoleUrl(url: string, projectId?: string): string {
  if (!projectId) return url
  return `${url}${url.includes("?") ? "&" : "?"}project=${encodeURIComponent(projectId)}`
}

/** The domain to authorize on the consent screen for a server address: the host's
 *  registrable part (liaison.acme.com -> acme.com; liaison.acme.co.uk -> acme.co.uk). */
export function googleAuthorizedDomain(baseUrl: string): string {
  let host: string
  try {
    host = new URL(baseUrl).hostname
  } catch {
    return ""
  }
  const labels = host.split(".")
  if (labels.length <= 2 || /^\d+$/.test(labels[labels.length - 1] as string)) return host
  const last = labels[labels.length - 1] as string
  const second = labels[labels.length - 2] as string
  // A two-letter country code under a short second level (co.uk, com.au, co.jp).
  const take = last.length === 2 && second.length <= 3 && labels.length > 2 ? 3 : 2
  return labels.slice(-take).join(".")
}

export interface SetupGuide {
  title: string
  steps: SetupGuideStep[]
}

/** A translator: the web `t()` or the api `serverT` bound to a locale. */
export type SetupGuideTranslate = (
  key: string,
  params?: Record<string, string | number | boolean>,
) => string

/** The Google service account Gmail publishes push notifications as. */
export const GMAIL_PUSH_PUBLISHER = "gmail-api-push@system.gserviceaccount.com"

/** Where a connection's OAuth client comes from: the workspace's own, one the
 *  instance provides for every workspace, or none yet. */
export type OAuthClientSource = "org" | "instance" | "none"

/** One Google connection of an app that is on, and the scopes it asks for. */
export interface GoogleSetupConnection {
  app: string
  connection: string
  scopes: string[]
  /** Uses the workspace's Google client (Gmail, Calendar). Otherwise the client is
   *  entered for this connection on its own; the same Cloud client can be reused. */
  workspaceClient: boolean
  /** Its client today. "instance": nobody creates one, the person only connects. */
  clientSource: OAuthClientSource
  /** An account of this connection was connected with the workspace's current
   *  client: its APIs and scopes are known to work in that client's project. */
  clientProven?: boolean
}

/** The values a Google setup needs, computed from the deployment and its apps. */
export interface GoogleSetupValues {
  baseUrl: string
  /** Where every app connection returns after consent. */
  connectionsRedirectUri: string
  /** Google sign-in to Liaison itself: set by whoever runs the server, never per workspace. */
  signIn: { enabled: boolean; redirectUri: string }
  /** The URIs to register on the OAuth client: the connections callback and the
   *  sign-in callback. One Web client serves Sign in with Google and every Google
   *  connection (scopes are asked per consent, not per client), so both are on it
   *  by default. */
  redirectUris: string[]
  /** The Google Cloud project's id, when the person gave it: every console link
   *  opens with that project selected. */
  projectId?: string
  /** The address of the person setting Google up (an admin), when known: the
   *  consent screen's user support and developer contact email. */
  supportEmail?: string
  /** The feature being set up (an app: mail, calendar, google-drive...): the APIs
   *  and scopes are that app's alone, the other apps' APIs an optional aside. */
  feature?: string
  /** The APIs of the other apps that are on, when a feature is set up: offered as
   *  "while you are on this page" (optional), never part of the step. */
  alsoApis?: Array<{ id: string; name: string }>
  /** The union of the Google scopes of the apps that are on, leaving out the
   *  connections whose client the instance provides (unless every one is). */
  scopes: string[]
  /** The Google APIs those scopes need turned on. */
  apis: Array<{ id: string; name: string }>
  /** Scopes no known API covers (a newer app): name them, do not guess. */
  unmappedScopes: string[]
  connections: GoogleSetupConnection[]
  /** Optional Gmail push. `endpoint` is null when the Mail app is off;
   *  `instanceTopic` is true when the instance provides a shared Pub/Sub topic
   *  (then nobody sets push up). */
  gmailPush: { publisher: string; endpoint: string | null; instanceTopic: boolean }
  /** True when every Google connection that is on has an instance client: the
   *  person creates nothing in Google Cloud and only connects. */
  instanceClientOnly: boolean
  /** True when every Google connection that is on already has a client, the
   *  workspace's own or the instance's: nothing is left to create in Google
   *  Cloud, the guide keeps only what remains (connect, optional push). */
  clientReady: boolean
  /** True when the workspace's own client was never used for some connection
   *  that is on (e.g. set up for Gmail, Calendar turned on later): its APIs and
   *  scopes (listed in `apis` / `scopes`) must be checked in that client's
   *  project before connecting. Nothing is created. */
  verifyApis: boolean
  /** Google connections that take a client of their own (not the workspace's Google
   *  client: Drive, YouTube, Ads...) and have none, while the workspace's own Google
   *  client is set. Left out of the steps: they are set up only when the person asks
   *  for one, on its own client card, and can reuse the same project and client. */
  separateClients?: Array<{ app: string; connection: string; scopes: string[]; apis: string[] }>
  /** The client of each Google connection family, wherever the apps are on or not:
   *  `workspace` (Gmail in Mail and Tickets, Google Calendar) and `drive`. */
  clients: GoogleClients
}

/** The Google connection families that each take one client. */
export type GoogleClientFamily = "workspace" | "drive"

/** Where a Google connection family's client comes from, and what Google lets it do. */
export interface GoogleClientInfo {
  source: OAuthClientSource
  /** The instance client's id when `source` is "instance". A client id is public
   *  (it is in every authorize URL); the secret never leaves the server. */
  instanceClientId?: string
  /** The instance client passed Google's verification for restricted scopes
   *  (Gmail, Drive), so a personal Gmail account can consent to it. Always false
   *  for a workspace's own client: its owner knows what it is. */
  restrictedVerified: boolean
  /** The instance client's consent screen has Audience Internal, in these Google
   *  Workspace domains (GOOGLE_OAUTH_INTERNAL_DOMAINS): an address there connects
   *  with no Trusted marking and no verification. */
  internalDomains?: string[]
}

export type GoogleClients = Record<GoogleClientFamily, GoogleClientInfo>

/** What kind of mailbox an address is, from its domain (and its MX records). */
export const MAIL_ACCOUNT_TYPES = [
  "google_consumer",
  "google_workspace",
  "microsoft",
  "other",
  "unknown",
] as const
export type MailAccountType = (typeof MAIL_ACCOUNT_TYPES)[number]

/**
 * How an address connects, from its account type and the Gmail client:
 * - `trusted`: a Google Workspace address and an External instance client Google
 *   has not verified: a Workspace super admin marks the client Trusted, then Connect.
 * - `consent`: the workspace's own client, a verified instance client, or an
 *   instance client whose audience is Internal to the address's Workspace domain
 *   (an internal, domain-owned app: Google asks for no Trusted mark): Connect.
 * - `consumer_imap`: a personal Gmail address and an unverified instance client:
 *   Google refuses that client for Gmail, so the mailbox connects over IMAP.
 * - `own_client`: no client at all: the person creates one in Google Cloud.
 * - `imap`: not a Google mailbox: IMAP with an app password (Outlook cannot).
 * - `ask`: the type is not known (no address, or its domain did not answer):
 *   ask the person who hosts the mailbox.
 */
export type GoogleConnectPath =
  | "trusted"
  | "consent"
  | "consumer_imap"
  | "own_client"
  | "imap"
  | "ask"

/** The connect path of an address (`accountType` null: no address given). */
export function googleConnectPath(
  accountType: MailAccountType | null,
  client: GoogleClientInfo,
  email?: string,
): GoogleConnectPath {
  if (accountType === "microsoft" || accountType === "other") return "imap"
  if (accountType === "unknown") return "ask"
  if (client.source === "none") return "own_client"
  if (client.source === "org" || client.restrictedVerified) return "consent"
  if (accountType === "google_workspace") {
    return googleClientInternalTo(client, email) ? "consent" : "trusted"
  }
  if (accountType === "google_consumer") return "consumer_imap"
  return "ask"
}

/** The client's audience is Internal to the address's Workspace domain. */
export function googleClientInternalTo(client: GoogleClientInfo, email?: string): boolean {
  const domain = email?.split("@")[1]?.trim().toLowerCase()
  if (!domain) return false
  return (client.internalDomains ?? []).some((d) => d.trim().toLowerCase() === domain)
}

/**
 * How Google Drive connects for an address, from its account type and the Drive
 * client:
 * - `full`: the whole Drive (`drive.readonly`): the workspace's own client, a
 *   verified instance client, no client yet (the person creates one), or a Google
 *   Workspace address (its admin marks the instance client Trusted).
 * - `picked`: `drive.file` only: the person chooses in the Google Picker which
 *   files and folders Liaison sees (a personal Google account, or an address
 *   whose type is not known, on an instance client Google has not verified).
 */
export type GoogleDriveMode = "full" | "picked"

export function googleDriveMode(
  accountType: MailAccountType | null,
  client: GoogleClientInfo,
): GoogleDriveMode {
  if (client.source !== "instance" || client.restrictedVerified) return "full"
  return accountType === "google_workspace" ? "full" : "picked"
}

const G = "setup-guides.google"

export function googleSetupGuide(values: GoogleSetupValues, t: SetupGuideTranslate): SetupGuide {
  if (values.instanceClientOnly) {
    return {
      title: t(`${G}.title`),
      steps: [
        {
          id: "connect",
          minutes: 1,
          title: t(`${G}.connect.title`),
          body: t(`${G}.connect.body`),
          place: "liaison",
        },
        ...sharedDrivesSteps(values, t),
      ],
    }
  }
  if (values.clientReady) {
    // The workspace has its own client: no project, consent screen or client to
    // create again. What remains: the APIs and scopes of a connection the client
    // was never used for (in its existing project), connecting, and Gmail push
    // when it is not set up.
    const steps: SetupGuideStep[] = values.verifyApis
      ? [
          {
            id: "apis",
            minutes: 1,
            title: t(`${G}.apis.title`),
            body: t(`${G}.apis.body`),
            values: values.apis.map((a) => a.name),
            links: apiLinks(values, t),
          },
          ...optionalStep(alsoApisStep(values, t)),
          {
            id: "dataAccess",
            minutes: 1,
            title: t(`${G}.dataAccess.title`),
            body: t(`${G}.dataAccess.body`),
            values: [...values.scopes],
            links: [
              {
                label: t(`${G}.links.dataAccess`),
                url: googleConsoleUrl(SETUP_URLS.googleDataAccess, values.projectId),
              },
            ],
          },
        ]
      : []
    steps.push({
      id: "connect",
      minutes: 1,
      title: t(`${G}.connect.title`),
      body: t(`${G}.connect.bodyOwnClient`),
      place: "liaison",
    })
    steps.push(...sharedDrivesSteps(values, t))
    const push = pushStep(values, t)
    if (push) steps.push(push)
    return { title: t(`${G}.title`), steps }
  }
  const apiNames = values.apis.map((a) => a.name)
  const steps: SetupGuideStep[] = [
    {
      id: "project",
      minutes: 1,
      title: t(`${G}.project.title`),
      body: t(`${G}.project.body`),
      links: [{ label: t(`${G}.links.project`), url: SETUP_URLS.googleProjectCreate }],
    },
    apiNames.length > 0
      ? {
          id: "apis",
          minutes: 1,
          title: t(`${G}.apis.title`),
          body: t(`${G}.apis.body`),
          values: apiNames,
          links: apiLinks(values, t),
        }
      : // Nothing to do in Google Cloud: the agent turns an app on first.
        {
          id: "apis",
          title: t(`${G}.apis.title`),
          body: t(`${G}.apis.none`),
          values: [],
          who: "agent",
        },
    ...optionalStep(alsoApisStep(values, t)),
    {
      id: "audience",
      minutes: 1,
      title: t(`${G}.audience.title`),
      body: t(`${G}.audience.body`),
      links: [
        {
          label: t(`${G}.links.audience`),
          url: googleConsoleUrl(SETUP_URLS.googleAudience, values.projectId),
        },
      ],
    },
    {
      id: "branding",
      minutes: 2,
      title: t(`${G}.branding.title`),
      // Ready values for every field: the app name, the support and developer
      // contact email (the admin's own address), the authorized domain.
      body: values.supportEmail ? t(`${G}.branding.body`) : t(`${G}.branding.bodyNoEmail`),
      values: [
        "Liaison",
        ...(values.supportEmail ? [values.supportEmail] : []),
        googleAuthorizedDomain(values.baseUrl),
      ].filter(Boolean),
      links: [
        {
          label: t(`${G}.links.branding`),
          url: googleConsoleUrl(SETUP_URLS.googleBranding, values.projectId),
        },
      ],
    },
    {
      id: "dataAccess",
      minutes: 1,
      title: t(`${G}.dataAccess.title`),
      body: t(`${G}.dataAccess.body`),
      values: [...values.scopes],
      links: [
        {
          label: t(`${G}.links.dataAccess`),
          url: googleConsoleUrl(SETUP_URLS.googleDataAccess, values.projectId),
        },
      ],
    },
    {
      id: "client",
      minutes: 2,
      title: t(`${G}.client.title`),
      body: t(`${G}.client.body`),
      values: [...values.redirectUris],
      links: [
        {
          label: t(`${G}.links.clients`),
          url: googleConsoleUrl(SETUP_URLS.googleClients, values.projectId),
        },
      ],
    },
    {
      id: "secret",
      minutes: 1,
      title: t(`${G}.secret.title`),
      body: t(`${G}.secret.body`),
      place: "liaison",
    },
    ...sharedDrivesSteps(values, t),
  ]
  const push = pushStep(values, t)
  if (push) steps.push(push)
  return { title: t(`${G}.title`), steps }
}

/** Each API of the guide on its own API Library page (the Enable button is there). */
function apiLinks(
  values: GoogleSetupValues,
  t: SetupGuideTranslate,
): Array<{ label: string; url: string }> {
  return values.apis.length > 0
    ? values.apis.map((a) => ({ label: a.name, url: googleApiUrl(a.id, values.projectId) }))
    : [
        {
          label: t(`${G}.links.apiLibrary`),
          url: googleConsoleUrl(SETUP_URLS.googleApiLibrary, values.projectId),
        },
      ]
}

/**
 * Google Drive is on: an organization's Drive connection shares only the shared
 * drives an admin picks, never anyone's My Drive, and Google lists only the
 * drives the connecting account is a member of.
 */
function sharedDrivesSteps(values: GoogleSetupValues, t: SetupGuideTranslate): SetupGuideStep[] {
  if (!values.connections.some((c) => c.app === "google-drive")) return []
  return [
    {
      id: "sharedDrives",
      minutes: 1,
      title: t(`${G}.sharedDrives.title`),
      body: t(`${G}.sharedDrives.body`),
      place: "liaison",
    },
  ]
}

/** "While you are on this page": the other apps' APIs, optional, when one feature
 *  is set up. Never part of the feature's own step. */
function alsoApisStep(values: GoogleSetupValues, t: SetupGuideTranslate): SetupGuideStep | null {
  const also = values.alsoApis ?? []
  if (also.length === 0) return null
  return {
    id: "alsoApis",
    minutes: 1,
    title: t(`${G}.alsoApis.title`),
    body: t(`${G}.alsoApis.body`),
    values: also.map((a) => a.name),
    links: also.map((a) => ({ label: a.name, url: googleApiUrl(a.id, values.projectId) })),
    optional: true,
  }
}

function optionalStep(step: SetupGuideStep | null): SetupGuideStep[] {
  return step ? [step] : []
}

/** The optional Gmail push step, when the Mail app is on and the instance has no shared topic. */
function pushStep(values: GoogleSetupValues, t: SetupGuideTranslate): SetupGuideStep | null {
  if (!values.gmailPush.endpoint || values.gmailPush.instanceTopic) return null
  return {
    id: "push",
    minutes: 3,
    title: t(`${G}.push.title`),
    body: t(`${G}.push.body`),
    values: [values.gmailPush.publisher, values.gmailPush.endpoint],
    links: [
      {
        label: t(`${G}.links.pubsub`),
        url: googleConsoleUrl(SETUP_URLS.googlePubSubTopics, values.projectId),
      },
    ],
    optional: true,
  }
}

/** For a client Internal to the person's Workspace: no Trusted mark, only the admin
 *  check a Workspace that restricts Gmail or Drive access needs, named with its page. */
export function googleInternalTrustStep(t: SetupGuideTranslate): SetupGuideStep {
  return {
    id: "internalTrust",
    minutes: 2,
    title: t(`${G}.internalTrust.title`),
    body: t(`${G}.internalTrust.body`),
    links: [{ label: t(`${G}.links.apiControls`), url: SETUP_URLS.googleAdminApiControls }],
    optional: true,
  }
}

/** One client a Workspace admin marks Trusted, and what it connects. */
export interface GoogleTrustedClient {
  family: GoogleClientFamily
  clientId: string
}

/** What the Trusted guide needs: this server and the instance client(s) to trust. */
export interface GoogleTrustedValues {
  baseUrl: string
  /** One entry per distinct client id (Gmail and Drive may share one). */
  clients: GoogleTrustedClient[]
}

/** The instance clients a Workspace admin trusts: every family whose client is the
 *  instance's and not verified, one entry per distinct id. */
export function googleTrustedClients(clients: GoogleClients): GoogleTrustedClient[] {
  const out: GoogleTrustedClient[] = []
  for (const family of ["workspace", "drive"] as const) {
    const c = clients[family]
    if (c.source !== "instance" || !c.instanceClientId || c.restrictedVerified) continue
    if (out.some((o) => o.clientId === c.instanceClientId)) continue
    out.push({ family, clientId: c.instanceClientId })
  }
  return out
}

const GT = "setup-guides.googleTrusted"

/**
 * A Google Workspace super admin marks this server's Google client Trusted in the
 * Admin console: Google then treats it as internal to the domain (restricted
 * scopes allowed, no warning screen). Then the person connects.
 */
export function googleTrustedGuide(
  values: GoogleTrustedValues,
  t: SetupGuideTranslate,
): SetupGuide {
  const ids = values.clients.map((c) => c.clientId)
  const named = values.clients
    .map((c) => `${t(`${GT}.family.${c.family}`)}: ${c.clientId}`)
    .join("\n")
  const adminMessage = t(`${GT}.adminMessage`, { baseUrl: values.baseUrl, clients: named })
  const adminLink = { label: t(`${GT}.links.appAccess`), url: SETUP_URLS.googleAdminAppAccess }
  return {
    title: t(`${GT}.title`),
    steps: [
      {
        id: "admin",
        minutes: 1,
        title: t(`${GT}.admin.title`),
        body: t(`${GT}.admin.body`),
        values: [adminMessage],
        links: [adminLink],
      },
      {
        id: "open",
        minutes: 1,
        title: t(`${GT}.open.title`),
        body: t(`${GT}.open.body`),
        links: [adminLink],
      },
      {
        id: "add",
        minutes: 1,
        title: t(`${GT}.add.title`),
        body: ids.length > 1 ? t(`${GT}.add.bodyMany`) : t(`${GT}.add.body`),
        values: ids,
        links: [adminLink],
      },
      {
        id: "scope",
        minutes: 1,
        title: t(`${GT}.scope.title`),
        body: t(`${GT}.scope.body`),
        links: [adminLink],
      },
      {
        id: "trust",
        minutes: 1,
        title: t(`${GT}.trust.title`),
        body: t(`${GT}.trust.body`),
        links: [adminLink],
      },
      {
        id: "connect",
        minutes: 1,
        title: t(`${GT}.connect.title`),
        body: t(`${GT}.connect.body`),
        place: "liaison",
      },
    ],
  }
}

/** What a personal Gmail account gets, said before any setup when the instance's
 *  Google client is not verified for Gmail and Drive. */
export function googleConsumerStatement(t: SetupGuideTranslate): string {
  return t("setup-guides.googleConsumer.statement")
}

/** What the Shopify guide needs: the callback the app redirects to, and whether the
 *  file already carries the app's client id (then there is nothing to link). */
export interface ShopifySetupValues {
  /** Where the Shopify app's client comes from. "instance": there is nothing to
   *  create, the guide is the connect step alone. */
  clientSource: OAuthClientSource
  callbackUrl: string
  hasClientId: boolean
  /** The name the file is handed over under (a stored file cannot be named
   *  `shopify.app.toml`: `.app` is a blocked extension), saved as SHOPIFY_APP_TOML. */
  handedFilename: string
  /** Where the guide is read (default `app`): how the full-order-history setting is
   *  turned on (the `kernel__config_apps` change, or `liaison config apply`). */
  surface?: SetupSurface
}

/** The Shopify app's org setting that asks the store for `read_all_orders`. */
export const SHOPIFY_FULL_ORDER_HISTORY_SETTING = "fullOrderHistory"

/**
 * How the agent turns on full order history, per surface: the in-product agent
 * proposes a `kernel__config_apps` change (the person approves the card); a
 * coding agent puts it in the workspace config and runs `liaison config apply`.
 * The person never toggles it by hand: anything the config can write, the agent writes.
 */
export function shopifyFullOrderHistoryValues(surface: SetupSurface): string[] {
  if (surface === "agent") {
    return [
      `apps:\n  - name: shopify\n    enable: true\n    settings:\n      ${SHOPIFY_FULL_ORDER_HISTORY_SETTING}: true`,
      "liaison config apply",
    ]
  }
  return [
    "kernel__config_apps",
    JSON.stringify({
      apps: [
        { name: "shopify", enable: true, settings: { [SHOPIFY_FULL_ORDER_HISTORY_SETTING]: true } },
      ],
    }),
  ]
}

function fullOrderHistorySettingStep(
  surface: SetupSurface,
  t: SetupGuideTranslate,
): SetupGuideStep {
  return {
    id: "fullOrderHistorySetting",
    title: t(`${S}.fullOrderHistorySetting.title`),
    body: t(`${S}.fullOrderHistorySetting.${surface === "agent" ? "bodyAgent" : "bodyApp"}`),
    values: shopifyFullOrderHistoryValues(surface),
    who: "agent",
  }
}

/** The Shopify CLI login. Interactive (browser, account and organization prompts):
 *  the person runs it in their own terminal, never the agent. `--no-input` on a
 *  later command turns browser sign-in off, so the login comes first. */
export const SHOPIFY_CLI_LOGIN = "shopify auth login"

/** The only file name the Shopify CLI reads its configuration from. */
export const SHOPIFY_APP_TOML = "shopify.app.toml"

/**
 * The answer to Shopify's "Why does your app need access to orders older than 60
 * days?" when requesting Read all orders. Always English: Shopify's reviewers read it.
 */
export const SHOPIFY_ALL_ORDERS_REASON =
  "Liaison is a support, operations and invoicing workspace for the merchant's own store, installed only on their store (custom distribution). It needs the store's complete order history to: answer customer support requests about orders of any age (warranty claims, returns, repairs and order questions often concern purchases made months or years ago); issue credit notes, refunds and corrected invoices that must reference the original order, whatever its date, as accounting and tax rules require; import the merchant's past orders when they first set up the workspace, so customer histories and reports are complete from day one. Order data is used only inside the merchant's own workspace and is never shared with third parties."

const S = "setup-guides.shopify"

function shopifyConnectStep(t: SetupGuideTranslate): SetupGuideStep {
  return {
    id: "connect",
    minutes: 1,
    title: t(`${S}.connect.title`),
    body: t(`${S}.connect.body`),
    place: "liaison",
  }
}

function shopifyDistributionStep(t: SetupGuideTranslate): SetupGuideStep {
  return {
    id: "distribution",
    minutes: 2,
    title: t(`${S}.distribution.title`),
    body: t(`${S}.distribution.body`),
    links: [{ label: t(`${S}.links.devDashboard`), url: SETUP_URLS.shopifyDevDashboard }],
  }
}

function shopifyCredentialsStep(t: SetupGuideTranslate): SetupGuideStep {
  return {
    id: "credentials",
    minutes: 1,
    title: t(`${S}.credentials.title`),
    body: t(`${S}.credentials.body`),
    links: [{ label: t(`${S}.links.devDashboard`), url: SETUP_URLS.shopifyDevDashboard }],
  }
}

/** The Shopify CLI's deploy without its release prompt (a coding agent runs it). */
export const SHOPIFY_CLI_DEPLOY = "shopify app deploy --allow-updates"
/** Prints the app's SHOPIFY_API_KEY (client ID) and SHOPIFY_API_SECRET. */
export const SHOPIFY_CLI_ENV_SHOW = "shopify app env show"

/**
 * The Shopify app created with the Shopify CLI. On the `app` surface the person
 * runs every command (the in-product agent has no terminal). On the `agent`
 * surface (a coding agent with a shell) the agent writes the file, deploys and
 * reads the client back itself; the person runs only the interactive commands
 * (the login, and linking, which asks which organization and app).
 */
export function shopifySetupGuide(values: ShopifySetupValues, t: SetupGuideTranslate): SetupGuide {
  if (values.clientSource === "instance") {
    return { title: t(`${S}.title`), steps: [shopifyConnectStep(t)] }
  }
  const agent = values.surface === "agent"
  const steps: SetupGuideStep[] = [
    agent
      ? {
          id: "file",
          title: t(`${S}.file.title`),
          body: t(`${S}.file.bodyAgent`),
          values: [SHOPIFY_APP_TOML],
          who: "agent",
        }
      : {
          id: "file",
          minutes: 1,
          title: t(`${S}.file.title`),
          body: t(`${S}.file.body`, { filename: values.handedFilename }),
          values: [SHOPIFY_APP_TOML],
          place: "own",
        },
    {
      id: "cli",
      title: t(`${S}.cli.title`),
      body: agent ? t(`${S}.cli.bodyAgent`) : t(`${S}.cli.body`),
      values: ["npm install -g @shopify/cli@latest"],
      links: [{ label: t(`${S}.links.cliDocs`), url: SETUP_URLS.shopifyCliInstall }],
      ...(agent ? { who: "agent" as const } : { place: "own" as const, minutes: 2 }),
    },
    {
      id: "login",
      minutes: 1,
      title: t(`${S}.login.title`),
      body: t(`${S}.login.body`),
      values: [SHOPIFY_CLI_LOGIN],
      place: "own",
    },
  ]
  if (!values.hasClientId) {
    steps.push({
      id: "link",
      minutes: 1,
      title: t(`${S}.link.title`),
      body: agent ? t(`${S}.link.bodyAgent`) : t(`${S}.link.body`),
      values: ["shopify app config link"],
      place: "own",
    })
  }
  steps.push(
    agent
      ? {
          id: "deploy",
          title: t(`${S}.deploy.title`),
          body: t(`${S}.deploy.bodyAgent`, { callback: values.callbackUrl }),
          values: [SHOPIFY_CLI_DEPLOY],
          who: "agent",
        }
      : {
          id: "deploy",
          minutes: 1,
          title: t(`${S}.deploy.title`),
          body: t(`${S}.deploy.body`, { callback: values.callbackUrl }),
          values: ["shopify app deploy"],
          place: "own",
        },
    // Orders older than 60 days need read_all_orders, a protected scope Shopify grants
    // only after approving the app. Approval can take days, so it is requested right
    // after the release; the install and the connect work meanwhile (last 60 days).
    {
      id: "fullOrderHistory",
      minutes: 2,
      title: t(`${S}.fullOrderHistory.title`),
      body: t(`${S}.fullOrderHistory.body`),
      values: [SHOPIFY_ALL_ORDERS_REASON],
      links: [{ label: t(`${S}.links.partnerDashboard`), url: SETUP_URLS.shopifyPartnerDashboard }],
    },
    shopifyDistributionStep(t),
    agent
      ? {
          id: "credentials",
          title: t(`${S}.credentialsCli.title`),
          body: t(`${S}.credentialsCli.body`),
          values: [SHOPIFY_CLI_ENV_SHOW],
          who: "agent",
        }
      : shopifyCredentialsStep(t),
    fullOrderHistorySettingStep(values.surface ?? "app", t),
    shopifyConnectStep(t),
  )
  return { title: t(`${S}.title`), steps }
}

/** What the Shopify Dev Dashboard guide needs: the app's settings, from the same
 *  generator as shopify.app.toml so the two never drift. */
export interface ShopifyDashboardValues {
  /** Where the Shopify app's client comes from. "instance": connect only. */
  clientSource: OAuthClientSource
  appUrl: string
  /** The redirect URLs (Liaison's connection callback). */
  redirectUrls: string[]
  scopes: string[]
  /** Protected scopes (read_all_orders) listed with the scopes from the start: an
   *  app the store's own organization creates in the Dev Dashboard gets them
   *  without Shopify's review (only a Partner organization's app needs one). */
  protectedScopes?: string[]
  /** The webhooks API version. */
  apiVersion: string
  /** Where the guide is read (default `app`). */
  surface?: SetupSurface
}

const SD = "setup-guides.shopifyDashboard"

/**
 * The Shopify app created in the Shopify Dev Dashboard, in the browser: no
 * terminal. The default path; the Shopify CLI file (`shopifySetupGuide`) is the
 * alternative for a developer.
 */
export function shopifyDashboardGuide(
  values: ShopifyDashboardValues,
  t: SetupGuideTranslate,
): SetupGuide {
  if (values.clientSource === "instance") {
    return { title: t(`${SD}.title`), steps: [shopifyConnectStep(t)] }
  }
  const protectedScopes = values.protectedScopes ?? []
  const versionValues = [
    values.appUrl,
    ...values.redirectUrls,
    [...values.scopes, ...protectedScopes].join(","),
  ]
  versionValues.push(values.apiVersion)
  return {
    title: t(`${SD}.title`),
    steps: [
      {
        id: "open",
        minutes: 1,
        title: t(`${SD}.open.title`),
        body: t(`${SD}.open.body`),
        links: [{ label: t(`${S}.links.devDashboard`), url: SETUP_URLS.shopifyDevDashboard }],
      },
      {
        id: "version",
        minutes: 3,
        title: t(`${SD}.version.title`),
        body: t(`${SD}.version.body`),
        values: versionValues,
        links: [{ label: t(`${S}.links.devDashboard`), url: SETUP_URLS.shopifyDevDashboard }],
      },
      ...(protectedScopes.length > 0
        ? [
            {
              id: "fullOrderHistory",
              minutes: 2,
              title: t(`${SD}.fullOrderHistory.title`),
              body: t(`${SD}.fullOrderHistory.body`),
              values: [SHOPIFY_ALL_ORDERS_REASON],
              links: [
                {
                  label: t(`${S}.links.partnerDashboard`),
                  url: SETUP_URLS.shopifyPartnerDashboard,
                },
              ],
            },
          ]
        : []),
      shopifyDistributionStep(t),
      shopifyCredentialsStep(t),
      ...(protectedScopes.length > 0
        ? [fullOrderHistorySettingStep(values.surface ?? "app", t)]
        : []),
      shopifyConnectStep(t),
    ],
  }
}

/** Server settings of the common mailbox providers, and whether a password (an app
 *  password) can still sign in over IMAP. Microsoft turned password sign-in off for
 *  Outlook.com and Microsoft 365 mailboxes. */
export const IMAP_PROVIDERS = {
  gmail: {
    imapHost: "imap.gmail.com",
    imapPort: 993,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    passwordWorks: true,
  },
  outlook: {
    imapHost: "outlook.office365.com",
    imapPort: 993,
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    passwordWorks: false,
  },
  icloud: {
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    passwordWorks: true,
  },
  fastmail: {
    imapHost: "imap.fastmail.com",
    imapPort: 993,
    smtpHost: "smtp.fastmail.com",
    smtpPort: 465,
    passwordWorks: true,
  },
} as const

export type ImapProvider = keyof typeof IMAP_PROVIDERS

/** Google's pages for an app password: 2-Step Verification, then App passwords. */
export const GOOGLE_TWO_STEP_URL = "https://myaccount.google.com/signinoptions/twosv"
export const GOOGLE_APP_PASSWORDS_URL = "https://myaccount.google.com/apppasswords"

/** Addresses whose mailbox is a personal Gmail one, so its servers are known. */
export function isGmailAddress(address: string | null | undefined): boolean {
  return /@(gmail|googlemail)\.com$/i.test(String(address ?? "").trim())
}

/**
 * An app password as Google shows it ("abcd efgh ijkl mnop") with its spaces
 * taken out; any other password is returned unchanged.
 */
export function normalizeAppPassword(password: string): string {
  return /^[a-z]{4}( [a-z]{4}){3}$/i.test(password.trim()) ? password.replace(/\s+/g, "") : password
}

const M = "setup-guides.imap"

/** Where a provider's app password is created (Gmail has its own two steps). */
const IMAP_PASSWORD_PAGES: Partial<Record<ImapProvider, string>> = {
  icloud: SETUP_URLS.appleAccount,
  fastmail: SETUP_URLS.fastmailSecurity,
}

export function imapPasswordGuide(provider: ImapProvider, t: SetupGuideTranslate): SetupGuide {
  const p = IMAP_PROVIDERS[provider]
  const name = t(`${M}.${provider}.name`)
  const title = t(`${M}.title`, { provider: name })
  if (!p.passwordWorks) {
    return {
      title: t(`${M}.titleNoPassword`, { provider: name }),
      steps: [
        {
          id: "unsupported",
          title: t(`${M}.${provider}.name`),
          body: t(`${M}.${provider}.password`),
          // Nothing to do at the provider: the agent says it cannot connect.
          who: "agent",
        },
      ],
    }
  }
  if (provider === "gmail") {
    return {
      title,
      steps: [
        {
          id: "twoStep",
          minutes: 1,
          title: t(`${M}.gmail.twoStepTitle`),
          body: t(`${M}.gmail.twoStepBody`),
          links: [{ label: t(`${M}.gmail.twoStepLink`), url: GOOGLE_TWO_STEP_URL }],
        },
        {
          id: "password",
          minutes: 1,
          title: t(`${M}.gmail.passwordTitle`),
          body: t(`${M}.gmail.password`),
          links: [{ label: t(`${M}.gmail.passwordLink`), url: GOOGLE_APP_PASSWORDS_URL }],
        },
        {
          id: "card",
          minutes: 1,
          title: t(`${M}.cardTitle`),
          body: t(`${M}.gmail.cardBody`),
          place: "liaison",
          values: [`${p.imapHost}:${p.imapPort}`, `${p.smtpHost}:${p.smtpPort}`],
        },
      ],
    }
  }
  return {
    title,
    steps: [
      {
        id: "password",
        minutes: 1,
        title: t(`${M}.passwordTitle`),
        body: t(`${M}.${provider}.password`),
        links: IMAP_PASSWORD_PAGES[provider]
          ? [{ label: t(`${M}.${provider}.name`), url: IMAP_PASSWORD_PAGES[provider] as string }]
          : [],
      },
      {
        id: "servers",
        minutes: 1,
        title: t(`${M}.serversTitle`),
        body: t(`${M}.serversBody`),
        values: [`${p.imapHost}:${p.imapPort}`, `${p.smtpHost}:${p.smtpPort}`],
        place: "liaison",
      },
      {
        id: "card",
        minutes: 1,
        title: t(`${M}.cardTitle`),
        body: t(`${M}.cardBody`),
        place: "liaison",
      },
    ],
  }
}
