// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What the person who runs the server sets up, outside any workspace: the
 * domain and https, outbound mail and its sender records, Google sign-in, the
 * OAuth clients the server provides, push, storage, keys and backups.
 *
 * One definition per surface, read by every surface that guides it: the
 * in-product agent's `kernel__setup_state` (`server`: which are done), the
 * `liaison guide server` and `liaison setup state` commands, and the generated
 * setup reference (docs/reference/setup.md). Each step says who does it: a
 * `human` step happens in a provider's console or a browser (the coding agent
 * relays it word for word and waits), an `agent` step is a command or an edit
 * of deploy/.env the coding agent runs itself.
 *
 * Pure: it reads only the env-like record it is given and never returns a
 * secret, only whether one is set.
 */
import { GMAIL_PUSH_PUBLISHER } from "@liaison/shared"
import type { SetupStep } from "./connection-setup"
import { isPublicHttps } from "./connection-setup"
import { CONNECTIONS_CALLBACK_PATH, SIGN_IN_CALLBACK_PATH } from "./paths"

/** The env values a check reads (strings as the process sees them). */
export type ServerEnv = Readonly<Record<string, unknown>>

/** A server step: the same shape as a connection's (connection-setup.ts). */
export type ServerStep = SetupStep

export const SERVER_SURFACE_IDS = [
  "domain",
  "email",
  "modelKeys",
  "backups",
  "signInGoogle",
  "instanceClients",
  "drivePicker",
  "webPush",
  "phonePush",
  "objectStorage",
  "webSearch",
] as const
export type ServerSurfaceId = (typeof SERVER_SURFACE_IDS)[number]

export interface ServerSurface {
  id: ServerSurfaceId
  title: string
  optional: boolean
  /** The deploy/.env variables it sets. */
  env: string[]
  /** true / false from the env; null when the server cannot see it (backups). */
  done: boolean | null
  /** Why, without any secret value. */
  detail: string
  steps: ServerStep[]
  /** How the coding agent proves it works once set. */
  verify: string
}

const set = (e: ServerEnv, name: string) => {
  const v = e[name]
  return v !== undefined && v !== "" && v !== false
}
const allSet = (e: ServerEnv, names: string[]) => names.every((n) => set(e, n))

/** The bare address of a `Name <addr>` sender. */
export function senderAddress(from: string): string {
  const m = /<([^>]+)>/.exec(from)
  return (m ? m[1] : from).trim()
}
const PLACEHOLDER_SENDER_DOMAINS = new Set(["liaison.example.com", "liaison.app", "example.com"])

const RESTART =
  "Restart the app so it reads deploy/.env: `docker compose -f deploy/docker-compose.yml up -d app`."

/** Every server surface, computed from the env. */
export function serverSetup(e: ServerEnv): ServerSurface[] {
  const base = String(e.BASE_URL ?? "").replace(/\/+$/, "")
  const host = (() => {
    try {
      return new URL(base).host
    } catch {
      return "<your-domain>"
    }
  })()
  const publicHttps = isPublicHttps(base)
  const from = String(e.SYSTEM_EMAIL_FROM || e.EMAIL_FROM || "")
  const fromAddr = senderAddress(from)
  const fromDomain = fromAddr.includes("@") ? fromAddr.split("@")[1]!.toLowerCase() : ""
  const sendDomain = fromDomain && !PLACEHOLDER_SENDER_DOMAINS.has(fromDomain) ? fromDomain : ""
  const transport = set(e, "RESEND_API_KEY") ? "resend" : set(e, "SMTP_HOST") ? "smtp" : "none"
  const d = sendDomain || "<your-domain>"

  const surfaces: ServerSurface[] = [
    {
      id: "domain",
      title: "Domain and https",
      optional: false,
      env: ["BASE_URL", "ALLOWED_ORIGINS"],
      done: publicHttps,
      detail: publicHttps
        ? `BASE_URL is ${base}`
        : `BASE_URL is ${base || "unset"}: not a public https address (a local trial; Shopify, Meta and webhooks need one)`,
      steps: [
        {
          who: "human",
          minutes: 2,
          place: "own",
          text: "Choose the address people will use, for example liaison.your-company.com. At your DNS provider, add an A record for that name pointing to this server's public IP address (or a CNAME to its host name).",
        },
        {
          who: "agent",
          text: "Set BASE_URL and ALLOWED_ORIGINS in deploy/.env to that https address, without a trailing slash.",
          values: [
            `BASE_URL=https://${publicHttps ? host : "<your-domain>"}`,
            `ALLOWED_ORIGINS=https://${publicHttps ? host : "<your-domain>"}`,
          ],
        },
        {
          who: "agent",
          text: "Put https in front of the app: Caddy on the server (automatic certificates) or a Cloudflare Tunnel, as in docs/runbooks/production-bootstrap.md, section TLS + DNS.",
        },
      ],
      verify: `curl -fsS ${publicHttps ? base : "https://<your-domain>"}/healthz answers ok from another machine.`,
    },
    {
      id: "email",
      title: "Outbound mail and the sender domain",
      optional: false,
      env: [
        "RESEND_API_KEY",
        "SMTP_HOST",
        "SMTP_PORT",
        "SMTP_USER",
        "SMTP_PASS",
        "SMTP_SECURE",
        "EMAIL_FROM",
        "SYSTEM_EMAIL_FROM",
      ],
      done: transport !== "none" && sendDomain !== "",
      detail:
        transport === "none"
          ? "no mail transport: sign-in codes and invitations are only logged, so nobody else can sign in"
          : sendDomain
            ? `sends through ${transport} as ${fromAddr}`
            : `sends through ${transport} from a placeholder sender (${fromAddr || "unset"}): set EMAIL_FROM on a domain you own`,
      steps: [
        {
          who: "human",
          minutes: 2,
          text: "Pick a mail provider. With Resend: sign up, open Domains, click Add Domain and enter the domain you send from (a subdomain such as mail.your-company.com is fine). Any SMTP provider (Postmark, Mailgun, Amazon SES, Brevo, your own server) works the same way through its domain page.",
          url: "https://resend.com/domains",
        },
        {
          who: "human",
          minutes: 2,
          place: "own",
          text: `At your DNS provider, create exactly the records the mail provider shows for ${d}: the SPF (TXT) record and the DKIM records it generates. Then add a DMARC record (TXT on _dmarc.${d}). Back in the provider, click Verify and wait until the domain shows Verified.`,
          values: [`_dmarc.${d}  TXT  "v=DMARC1; p=none; rua=mailto:postmaster@${d}"`],
        },
        {
          who: "human",
          minutes: 1,
          text: "Create a sending API key (Resend: API Keys, Create API Key, permission Sending access) or the SMTP user and password, and put it in the secrets file, never in the chat.",
          url: "https://resend.com/api-keys",
        },
        {
          who: "agent",
          text: `Set the transport and the sender in deploy/.env: RESEND_API_KEY (or SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS; port 465 also needs SMTP_SECURE=true), and EMAIL_FROM on that domain. Remove LIAISON_CONSOLE_EMAIL_BODIES. ${RESTART}`,
          values: [`EMAIL_FROM=Your Company <noreply@${d}>`],
        },
      ],
      verify:
        "Sign in at BASE_URL with the owner's address: the code arrives in the inbox (not spam) within a minute, and the message headers show spf=pass and dkim=pass.",
    },
    {
      id: "modelKeys",
      title: "Model keys",
      optional: false,
      env: [
        "OPENROUTER_API_KEY",
        "LIAISON_ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GOOGLE_API_KEY",
        "MISTRAL_API_KEY",
      ],
      done:
        [
          "OPENROUTER_API_KEY",
          "LIAISON_ANTHROPIC_API_KEY",
          "OPENAI_API_KEY",
          "GOOGLE_API_KEY",
          "MISTRAL_API_KEY",
        ].some((n) => set(e, n)) || null,
      detail:
        "Each workspace brings its own key (config `byok`, checked by `liaison setup state` as aiKey); a server key here is the fallback for workspaces without one.",
      steps: [
        {
          who: "human",
          minutes: 1,
          text: "Create an OpenRouter key (one key reaches every model): open the keys page, click Create Key, name it, and put it in the secrets file.",
          url: "https://openrouter.ai/settings/keys",
        },
        {
          who: "agent",
          text: 'Give it to the workspace in the config (`byok: { openrouter: { apiKey: "${OPENROUTER_API_KEY}" } }`) and run `liaison config apply`. Only a server shared by several workspaces sets OPENROUTER_API_KEY in deploy/.env as the fallback.',
        },
      ],
      verify:
        "The `config apply` report shows byok.openrouter validated, and `liaison agent ask` gets an answer.",
    },
    {
      id: "backups",
      title: "Backups",
      optional: false,
      env: [],
      done: null,
      detail:
        "The server cannot see whether a backup job runs: check the cron line and the newest archive.",
      steps: [
        {
          who: "agent",
          text: "Add a nightly cron line on the host that runs deploy/backup.sh and keeps two weeks, then copy each archive off the machine (docs/admin/backups.md).",
          values: [
            "15 3 * * * cd /opt/liaison && ./deploy/backup.sh --keep 14 >>/var/log/liaison-backup.log 2>&1",
          ],
        },
        {
          who: "human",
          minutes: 1,
          place: "own",
          text: "Keep a copy of deploy/.env (the keys) somewhere safe outside the server: without ENCRYPTION_KEY a backup cannot be read.",
        },
      ],
      verify: "Run ./deploy/backup.sh once by hand: it prints the archive path and exits 0.",
    },
    {
      id: "signInGoogle",
      title: "Sign in with Google",
      optional: true,
      env: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
      done: allSet(e, ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"]),
      detail: allSet(e, ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"])
        ? "on (invited people only)"
        : "off: people sign in with an emailed code",
      steps: [
        {
          who: "human",
          minutes: 1,
          text: "If the project has no consent screen yet, Google asks for one first: on Branding, an app name and a support email. Then open Audience and say what User type it shows (a screenshot of the page is fine): Internal when the project belongs to your company's Google Workspace and everyone who signs in has an address there (no Google review, nothing to mark Trusted); External only otherwise. Sign-in uses only openid, email and profile, which need no Google review.",
          url: "https://console.cloud.google.com/auth/audience",
        },
        {
          who: "human",
          minutes: 2,
          text: "Open Clients, click Create client, choose Web application, name it Liaison. Under Authorized redirect URIs click Add URI twice and paste both values below: one client serves Sign in with Google and every Google connection (Gmail, Calendar, Drive, Ads), since Google asks for each permission when an account connects, not per client. Click Create, then Download JSON and give the agent the downloaded file's path.",
          url: "https://console.cloud.google.com/auth/clients",
          values: [
            `${base || "https://<your-domain>"}${SIGN_IN_CALLBACK_PATH}`,
            `${base || "https://<your-domain>"}${CONNECTIONS_CALLBACK_PATH}`,
          ],
        },
        {
          who: "agent",
          text: `Read client_id and client_secret from the downloaded JSON (check its redirect_uris list both values), write them to the secrets file without printing them, then delete the download. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in deploy/.env. The same pair is the workspace's Google client: give it in the config (a google: block on the mailbox or inbox), or as GMAIL_OAUTH_* on a server shared by several workspaces. When the audience is Internal, also set GOOGLE_OAUTH_INTERNAL_DOMAINS to the Workspace domain. ${RESTART}`,
        },
      ],
      verify:
        "The sign-in page shows Continue with Google, and an invited person signs in with it.",
    },
    {
      id: "instanceClients",
      title: "OAuth clients the server provides to every workspace",
      optional: true,
      env: [
        "GMAIL_OAUTH_CLIENT_ID",
        "GMAIL_OAUTH_CLIENT_SECRET",
        "GOOGLE_DRIVE_OAUTH_CLIENT_ID",
        "GOOGLE_DRIVE_OAUTH_CLIENT_SECRET",
        "GOOGLE_MARKETING_OAUTH_CLIENT_ID",
        "GOOGLE_MARKETING_OAUTH_CLIENT_SECRET",
        "SHOPIFY_APP_CLIENT_ID",
        "SHOPIFY_APP_CLIENT_SECRET",
        "GOOGLE_OAUTH_RESTRICTED_SCOPES_VERIFIED",
        "GOOGLE_OAUTH_INTERNAL_DOMAINS",
        "GMAIL_PUBSUB_TOPIC",
      ],
      done: [
        "GMAIL_OAUTH_CLIENT_ID",
        "GOOGLE_DRIVE_OAUTH_CLIENT_ID",
        "GOOGLE_MARKETING_OAUTH_CLIENT_ID",
        "SHOPIFY_APP_CLIENT_ID",
      ].some((n) => set(e, n)),
      detail:
        "Only for a server shared by several workspaces: a single company gives its own clients in the workspace config instead (liaison guide google / shopify).",
      steps: [
        {
          who: "agent",
          text: "Print the values each client needs: `liaison guide google` (redirect URI, scopes, APIs, Gmail push topic) and `liaison guide shopify` (app URL, redirect URL, scopes, API version). The redirect URI of every one of them is the value below.",
          values: [`${base || "https://<your-domain>"}${CONNECTIONS_CALLBACK_PATH}`],
        },
        {
          who: "human",
          minutes: 10,
          text: "Create each client as those guides say (Google: the Clients page below; Shopify: https://dev.shopify.com/dashboard), and put each ID and secret pair in the secrets file.",
          url: "https://console.cloud.google.com/auth/clients",
        },
        {
          who: "agent",
          text: `Set the pairs in deploy/.env (GMAIL_OAUTH_*, GOOGLE_DRIVE_OAUTH_*, GOOGLE_MARKETING_OAUTH_*, SHOPIFY_APP_*). GMAIL_PUBSUB_TOPIC is the topic Gmail push publishes to (the topic grants ${GMAIL_PUSH_PUBLISHER} Pub/Sub Publisher). Set GOOGLE_OAUTH_RESTRICTED_SCOPES_VERIFIED=true only once Google has verified the Google clients for restricted scopes. When the clients' audience is Internal (their project belongs to your Google Workspace), set GOOGLE_OAUTH_INTERNAL_DOMAINS to that Workspace's domain: its addresses then connect with no Trusted mark. One Web client may serve all the Google pairs and Sign in with Google. ${RESTART}`,
        },
      ],
      verify: "`liaison setup state` shows those connections with client `instance`.",
    },
    {
      id: "drivePicker",
      title: "Google Picker (choose Drive files one by one)",
      optional: true,
      env: ["GOOGLE_PICKER_API_KEY", "GOOGLE_CLOUD_PROJECT_NUMBER"],
      done: allSet(e, ["GOOGLE_PICKER_API_KEY", "GOOGLE_CLOUD_PROJECT_NUMBER"]),
      detail:
        "Needed only when Drive connects with drive.file (a personal Google account, or an unverified client): `liaison guide google --email <address>` says so.",
      steps: [
        {
          who: "human",
          minutes: 1,
          text: "In the Google Cloud project of the Drive client, open the Google Picker API page and click Enable.",
          url: "https://console.cloud.google.com/apis/library/picker.googleapis.com",
        },
        {
          who: "human",
          minutes: 3,
          text: "Open Credentials, click Create credentials, API key. Edit the key: under Application restrictions choose Websites and add the value below; under API restrictions choose Restrict key and select Google Picker API. Save and copy the key.",
          url: "https://console.cloud.google.com/apis/credentials",
          values: [`${host}/*`],
        },
        {
          who: "human",
          minutes: 1,
          text: "Copy the Project number (a number, not the project ID) from the project's Dashboard, Project info card.",
          url: "https://console.cloud.google.com/home/dashboard",
        },
        {
          who: "agent",
          text: `Set GOOGLE_PICKER_API_KEY and GOOGLE_CLOUD_PROJECT_NUMBER in deploy/.env. ${RESTART}`,
        },
      ],
      verify: "`liaison guide google --json` reports drivePicker.configured true.",
    },
    {
      id: "webPush",
      title: "Browser notifications",
      optional: true,
      env: ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"],
      done: allSet(e, ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]),
      detail: "Without them browser notifications stay off.",
      steps: [
        {
          who: "agent",
          text: `Generate the key pair once with \`bunx web-push generate-vapid-keys\` and set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (a mailto: contact) in deploy/.env. Keep the pair: a new one cancels every browser subscription. ${RESTART}`,
          values: [`VAPID_SUBJECT=mailto:admin@${sendDomain || "<your-domain>"}`],
        },
      ],
      verify:
        "In the web app, allow notifications when the browser asks; a mention from a colleague then shows a browser notification.",
    },
    {
      id: "phonePush",
      title: "Phone push (iOS, Android)",
      optional: true,
      env: [
        "APNS_KEY_PATH",
        "APNS_KEY_ID",
        "APNS_TEAM_ID",
        "APNS_BUNDLE_ID",
        "FCM_PROJECT_ID",
        "FCM_SERVICE_ACCOUNT_PATH",
      ],
      done: allSet(e, ["APNS_KEY_PATH", "APNS_KEY_ID", "APNS_TEAM_ID", "APNS_BUNDLE_ID"]),
      detail:
        "The published iOS app's push key belongs to the team that publishes it: a self-hosted server cannot get it, so the published phone app works on your server without push notifications. Push needs your own build of the app, signed by your Apple team. Android push is not available yet.",
      steps: [
        {
          who: "human",
          minutes: 10,
          text: "Only with your own build of the iOS app: in Apple Developer, Keys, create a key with Apple Push Notifications service (APNs), download the .p8 file and note its Key ID and your Team ID.",
          url: "https://developer.apple.com/account/resources/authkeys/list",
        },
        {
          who: "agent",
          text: `Put the .p8 under data/apns/ and set APNS_KEY_PATH=/var/lib/liaison/apns/AuthKey_<KEYID>.p8, APNS_KEY_ID, APNS_TEAM_ID and APNS_BUNDLE_ID (your build's bundle id) in deploy/.env. ${RESTART}`,
        },
      ],
      verify: "The boot log no longer says iOS push is off.",
    },
    {
      id: "objectStorage",
      title: "File storage",
      optional: true,
      env: [
        "OBJECT_STORAGE_ENDPOINT",
        "OBJECT_STORAGE_REGION",
        "OBJECT_STORAGE_BUCKET",
        "OBJECT_STORAGE_ACCESS_KEY",
        "OBJECT_STORAGE_SECRET_KEY",
        "OBJECT_STORAGE_FORCE_PATH_STYLE",
        "OBJECT_STORAGE_BROWSER_DIRECT",
      ],
      done: true,
      detail: String(e.OBJECT_STORAGE_ENDPOINT ?? "").includes("objectstore:")
        ? "the bundled store on this server (backed up by deploy/backup.sh)"
        : `an external store (${String(e.OBJECT_STORAGE_ENDPOINT ?? "unset")})`,
      steps: [
        {
          who: "human",
          minutes: 10,
          text: "Only to keep files outside the server (Cloudflare R2 shown; Amazon S3 is the same): in the Cloudflare dashboard open R2, click Create bucket, name it. Then Manage API tokens, Create API token, permission Object Read & Write, limited to that bucket; copy the Access Key ID, the Secret Access Key and the S3 endpoint.",
          url: "https://dash.cloudflare.com/?to=/:account/r2/overview",
        },
        {
          who: "agent",
          text: `Set OBJECT_STORAGE_ENDPOINT (the S3 endpoint), OBJECT_STORAGE_REGION=auto, OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_ACCESS_KEY and OBJECT_STORAGE_SECRET_KEY in deploy/.env; for direct browser uploads also OBJECT_STORAGE_BROWSER_DIRECT=true and the bucket CORS rule of docs/runbooks/production-bootstrap.md. ${RESTART}`,
        },
      ],
      verify: "Upload a file in the web app and open it again.",
    },
    {
      id: "webSearch",
      title: "Web search for the agents",
      optional: true,
      env: ["EXA_API_KEY"],
      done: set(e, "EXA_API_KEY"),
      detail: set(e, "EXA_API_KEY")
        ? "a server key is set"
        : "no server key: agents search the web only in workspaces that bring their own Exa key",
      steps: [
        {
          who: "human",
          minutes: 1,
          text: "Create an Exa API key on the dashboard's API keys page and put it in the secrets file.",
          url: "https://dashboard.exa.ai/api-keys",
        },
        { who: "agent", text: `Set EXA_API_KEY in deploy/.env. ${RESTART}` },
      ],
      verify: "`liaison agent ask` with a question about a public web page cites the page.",
    },
  ]
  return surfaces
}

/** A surface's steps as numbered text lines (the CLI and the generated reference). */
export function renderServerSurface(s: ServerSurface): string[] {
  const state = s.done === null ? "not checked by the server" : s.done ? "done" : "to do"
  const lines = [`${s.title}${s.optional ? " (optional)" : ""}: ${state}. ${s.detail}`]
  for (const [i, step] of s.steps.entries()) {
    lines.push(`  ${i + 1}. [${step.who === "human" ? "HUMAN" : "AGENT"}] ${step.text}`)
    if (step.url) lines.push(`     Open: ${step.url}`)
    for (const v of step.values ?? []) lines.push(`     > ${v}`)
  }
  lines.push(`  Verify: ${s.verify}`, "")
  return lines
}
