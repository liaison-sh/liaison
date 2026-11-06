// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Guided provider setup as agent tools (deferred, kernel skill `google-setup`):
//
// - `google_setup`: the redirect URIs, scopes and APIs a Google OAuth client
//   needs, computed from this server and the workspace's apps, with the
//   step-by-step guide in the person's language (and, for a mailbox that is not
//   Google, the app-password steps). The agent quotes these values, never its own.
// - `shopify_app_toml`: the shopify.app.toml generated from the Shopify app's
//   manifest, handed to the person as a file in this conversation, with the
//   Shopify CLI steps.
//
// Neither carries a secret: client secrets go through `request_secret`.
import {
  googleSetupGuide,
  IMAP_PROVIDERS,
  type ImapProvider,
  MAIL_ACCOUNT_TYPES,
  type MailAccountType,
  resolveLocale,
  type ShippedLocale,
  shopifySetupGuide,
} from "@liaison/shared"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { type DriveMode, pickerConfigured } from "~/apps/google-drive/drive-mode"
import { DRIVE_APP, DRIVE_CONNECTION, drivePickerState } from "~/apps/google-drive/picker"
import { createPickOrigin } from "~/apps/google-drive/picker-announce"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { organizations, users } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { captureActingAgentId } from "~/modules/agent/runtime/run-context"
import { SINK_KERNEL_MESSAGES } from "~/modules/agent/scopes/scope-taint"
import { resolveAgentAuthorLabel } from "~/modules/agent/tools/chat-tools"
import { handleFilesUploadUrl } from "~/modules/agent/tools/file-tools"
import {
  handleMailboxSetup,
  type MailboxSetupParams,
} from "~/modules/agent/tools/mailbox-setup-tool"
import { connectionConfigRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { type OAuthClientSource, resolveOAuthClient } from "~/modules/apps/connections/oauth-client"
import { connectionTurnedOff } from "~/modules/apps/connections/oauth-client-config"
import type { MxResolver } from "~/modules/connection-guides/account-type"
import type { computeGoogleSetupValues } from "~/modules/connection-guides/google"
import { CONNECTIONS_CALLBACK_PATH } from "~/modules/connection-guides/paths"
import {
  type GoogleConnectPlan,
  googleConnectPlan,
  resolveGoogleSetupValues,
  shopifyDashboardPlan,
  shopifyOptedInProtectedScopes,
  translator,
} from "~/modules/connection-guides/plan"
import {
  SHOPIFY_APP_TOML_HANDED_FILENAME,
  shopifyAppToml,
} from "~/modules/connection-guides/shopify-app-toml"
import { attachFilesToParent } from "~/modules/files/attach"
import { publishMessageAttachments, sendMessage } from "~/modules/threads/message"

/** The kernel-tool ctx fields these handlers read. */
interface SetupGuideCtx {
  orgId: string
  userId: string
  db: RlsClient
  agentExecutionThreadId?: string
  actorType?: "user" | "agent" | "mcp"
  scopes?: string[]
}

/** The person's language: their own choice, else the workspace default. */
async function localeFor(orgId: string, userId: string): Promise<ShippedLocale> {
  return (await personFor(orgId, userId)).locale
}

/** The person's language and address (the address: the Google consent screen's
 *  support email when they set Google up). */
async function personFor(
  orgId: string,
  userId: string,
): Promise<{ locale: ShippedLocale; email?: string }> {
  return await withPrivilegedDb(orgId, "setup-guide-locale", async (tx) => {
    const [person] = await tx
      .select({ locale: users.locale, email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    const [org] = await tx
      .select({ defaultLocale: organizations.defaultLocale })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1)
    return {
      locale: resolveLocale(person?.locale, org?.defaultLocale),
      ...(person?.email ? { email: person.email } : {}),
    }
  })
}

const IMAP_PROVIDER_IDS = Object.keys(IMAP_PROVIDERS) as [ImapProvider, ...ImapProvider[]]

/** The IMAP form card for a person's own mailbox: the exact call, so no model has to find it. */
function imapCard(email?: string): string {
  return `the IMAP form card, alone in its message (kernel__request_secret kind connection_credentials, app mail, connection imap, mode personal${email ? `, identifier ${email}` : ""}; mode org instead only for a mailbox the organization shares)`
}

/**
 * The order of the cards: one per message. A weak model posted the IMAP card,
 * the Drive Connect card and the picker in one message (live walk,
 * 2026-10-30), and the person was left with three cards at once.
 */
export const ONE_CARD_PER_MESSAGE =
  "One card per message, in this order: the mailbox card; only once it says connected, in a later message, Google Drive."

/** The sentence `nextStep` leads with for a path. */
function pathStep(plan: GoogleConnectPlan): string {
  switch (plan.path) {
    case "trusted":
      return "Path trusted: this server's Google client has not passed Google's verification, so a Google Workspace super admin marks it Trusted first. Your message now does only this: say that in one sentence and ask whether the person is a super admin of their Google Workspace, or whether it is already done (step admin). Post no Connect card and turn nothing on in this message. Then one step per message: if they are not a super admin, give them the step's value, the message for their admin, copied as it is in a quote block (never retype or reword the client IDs); if they are, walk steps open to trust; once they say Trusted is done, the Connect card (kernel__request_secret kind oauth_connect). If the person reports Error 400 admin_policy_enforced or Access blocked, this Trusted step is what is missing or not applied yet: say so and start at step admin."
    case "consent":
      return `Path consent: nothing to create or approve beforehand. Post the Connect card (kernel__request_secret kind oauth_connect). ${ONE_CARD_PER_MESSAGE}`
    case "consumer_imap":
      return `Path consumer_imap: a personal Gmail account cannot use this server's Google client for Gmail. Say \`statement\` first, in your own message, word for word in meaning, and ask whether to connect over IMAP now. If yes, walk \`imap.guide\` one step per message, then ${imapCard(plan.email)}. ${ONE_CARD_PER_MESSAGE} Never post a Gmail Connect card for this address, and never offer mail forwarding. Google Drive connects in picked mode, as \`drive.nextStep\` says, after the mailbox.`
    case "own_client":
      return "Path own_client: no Google client exists yet; walk the guide below to create one."
    case "imap":
      return plan.imap && !plan.imap.settings.passwordWorks
        ? "Path imap: this mailbox cannot connect with a password; say what `imap.guide` says, plainly."
        : plan.imap
          ? `Path imap: not a Google mailbox. Walk \`imap.guide\` one step per message, then ${imapCard(plan.email)}. ${ONE_CARD_PER_MESSAGE} If the person says the mailbox is on Google Workspace (mail can pass a filtering service first), call this again with accountType google_workspace.`
          : "Path imap: the address's mail servers are not Google's and not a provider Liaison knows. Your message now asks the person who hosts this mailbox (Google Workspace, Outlook or Microsoft 365, iCloud, Fastmail, or another) and does nothing else. Never assume Google Workspace yourself: call this again with accountType google_workspace only after the person says so (mail can pass a filtering service first), otherwise with imapProvider."
    case "ask":
      return plan.email
        ? "Path ask: the address's domain did not answer. Ask the person who hosts the mailbox (Google Workspace, personal Gmail, Microsoft 365, or another), then call this again with the matching accountType."
        : "Path ask: no address given. Ask which address to connect (or use the person's own), then call this again with email."
  }
}

type GoogleSetupParams = {
  imapProvider?: ImapProvider
  email?: string
  accountType?: MailAccountType
  projectId?: string
  feature?: string
}

export async function handleGoogleSetup(
  params: GoogleSetupParams,
  ctx: Pick<SetupGuideCtx, "orgId" | "userId">,
  /** Tests inject the MX lookup. */
  options: { resolver?: MxResolver } = {},
) {
  const person = await personFor(ctx.orgId, ctx.userId)
  const t = translator(person.locale)
  const values = await resolveGoogleSetupValues(ctx.orgId, {
    ...(params.projectId ? { projectId: params.projectId } : {}),
    ...(person.email ? { supportEmail: person.email } : {}),
    ...(params.feature ? { feature: params.feature } : {}),
  })
  const plan = await googleConnectPlan(values, t, params, options)
  // The Google Cloud client steps apply only where no address rules them out:
  // no client yet, the workspace's own, a verified instance client, or no address.
  const googleCloud =
    plan.path === "own_client" || plan.path === "consent" || (plan.path === "ask" && !params.email)
  const guide = googleSetupGuide(values, t)
  const remaining = remainingInGoogleCloud(guide)
  // A connection the workspace switched off (Gmail mailboxes) refuses its
  // Connect card whatever the client: it is turned on first.
  const switchedOff: string[] = []
  if (plan.path !== "consumer_imap" && plan.path !== "imap") {
    for (const c of values.connections) {
      const off = await connectionTurnedOff(ctx.orgId, c.app, c.connection)
      // On the trusted path the switch waits for the Trusted step: a weak model
      // read "turn it on, then post the Connect card" as the first move and
      // skipped the admin step altogether.
      if (off) {
        switchedOff.push(
          plan.path === "trusted"
            ? `Not in this message: once the person says Trusted is done, and before the Connect card, ${off.turnOn}`
            : off.turnOn,
        )
      }
    }
  }
  // Without an address, the agent asks for it first; what the clients allow follows.
  const steps = googleCloud
    ? [
        plan.path === "ask" ? pathStep(plan) : "",
        remainingStep(remaining),
        ...switchedOff,
        googleNextStep(values),
        separateClientsStep(values),
      ]
    : [pathStep(plan), ...switchedOff]
  const driveOn = values.connections.some(
    (c) => c.app === DRIVE_APP && c.connection === DRIVE_CONNECTION,
  )
  const drive =
    driveOn && plan.driveMode
      ? {
          mode: plan.driveMode,
          pickerConfigured: pickerConfigured(env),
          nextStep: driveSetupStep(plan.driveMode, pickerConfigured(env), plan.email),
        }
      : undefined
  return {
    // First, in words a weak model cannot skip: what the person still does in
    // Google Cloud before any Connect card, or that nothing is left there.
    ...(googleCloud ? { remainingInGoogleCloud: remaining } : {}),
    accountType: plan.accountType,
    path: plan.path,
    // Said before any setup step, when the address is a personal Gmail account.
    ...(plan.statement ? { statement: plan.statement } : {}),
    nextStep: steps.filter((p) => p !== "").join(" "),
    values,
    guide: plan.guide,
    ...(plan.imap ? { imap: plan.imap } : {}),
    // Google Drive for this address, when the Drive app is on: the whole Drive
    // (full) or the files the person picks (picked).
    ...(drive ? { drive } : {}),
  }
}

/** What the agent does to connect Google Drive for an address, by mode. */
export function driveSetupStep(mode: DriveMode, configured: boolean, email?: string): string {
  // The card carries the address: it decides the scopes asked and which Google
  // account the consent opens on, so the mode said here is the mode connected.
  const card = `the Drive Connect card (kernel__request_secret kind oauth_connect, app google-drive, connection drive${email ? `, identifier ${email}` : ""})`
  if (mode === "full") {
    return `Google Drive: mode full, Liaison reads the whole Drive once connected (${card}, alone in its message, after any mailbox card is connected). Never talk about picking files.`
  }
  const connect = `Not in the same message as a mailbox card: Drive comes after the mailbox is connected. Say first, in one plain sentence: with an account that is not on Google Workspace, the person chooses which Drive files Liaison can see; a Google Workspace account can share the whole Drive. Then ${card}, alone in its message. Only once it says connected, in a later message, call kernel__drive_picker: it shows the card where they pick files and folders.`
  return configured
    ? `Google Drive: mode picked. ${connect}`
    : `Google Drive: mode picked, but the Google Picker is not set up on this server, so the person cannot choose files yet. Tell them an admin sets GOOGLE_PICKER_API_KEY and GOOGLE_CLOUD_PROJECT_NUMBER on the server; until then Liaison sees only files it creates. ${connect}`
}

type DrivePickerParams = Record<string, never>

/** The person's Drive accounts as the agent sees them (no token). */
export async function handleDrivePicker(
  _params: DrivePickerParams,
  ctx: Pick<SetupGuideCtx, "orgId" | "userId" | "scopes" | "agentExecutionThreadId">,
) {
  const state = await drivePickerState({
    orgId: ctx.orgId,
    userId: ctx.userId,
    scopes: ctx.scopes ?? [],
  })
  const accounts = state.accounts.map((a) => ({
    accountId: a.id,
    account: a.identifier,
    owner: a.ownerType,
    mode: a.mode,
    pickedCount: a.picked.length,
    // Name and Drive id: google-drive__read takes the id, no search needed.
    picked: a.picked.slice(0, 20).map((p) => ({ name: p.name, driveFileId: p.id })),
    inKnowledge: a.sync?.documents ?? 0,
    syncStatus: a.sync?.status ?? null,
    // Picked files Knowledge does not import (no text form), by name and type.
    notInKnowledge: a.notImported.slice(0, 20).map((n) => `${n.name} (${n.type})`),
    ...(a.sync?.lastError ? { syncNote: a.sync.lastError } : {}),
  }))
  const picked = accounts.filter((a) => a.mode === "picked")
  let nextStep: string
  let card: "shown" | "none" = "none"
  if (accounts.length === 0) {
    nextStep =
      "No Google Drive is connected for this person. To connect one, call kernel__google_setup with their address and follow its drive.nextStep."
  } else if (picked.length === 0) {
    nextStep =
      "Drive is connected in full mode: Liaison sees the whole Drive, there is nothing to pick. When a file is not found, search again with other words or ask for its exact name."
  } else if (!state.pickerConfigured) {
    nextStep =
      "Drive is connected in picked mode, but the Google Picker is not set up on this server: say an admin sets GOOGLE_PICKER_API_KEY and GOOGLE_CLOUD_PROJECT_NUMBER. Until then Liaison sees only the files already picked and the files it created."
  } else {
    card = "shown"
    nextStep =
      "The picker card is shown under this call. When the file the person means is already in picked, read it with google-drive__read and its driveFileId instead. Otherwise, in one sentence, ask them to choose the files or folders there (Choose files), and end your turn: when they pick, a line in this conversation names the files and you carry on from it. Liaison sees only what they pick: a file added to Drive later is picked too, from this card or Settings. A file you cannot find may simply not be picked yet: say so and point to this card, never that it does not exist. Files in notInKnowledge are readable through Drive but not imported into Knowledge (no text form): say so when the person expects them there."
  }
  // A card in a conversation announces its picks there (picker-announce.ts),
  // and lists them as "picked here" by its origin and conversation.
  const origin =
    card === "shown" && ctx.agentExecutionThreadId
      ? await createPickOrigin({
          orgId: ctx.orgId,
          userId: ctx.userId,
          threadId: ctx.agentExecutionThreadId,
          agentId: captureActingAgentId(),
        })
      : undefined
  return {
    pickerConfigured: state.pickerConfigured,
    accounts,
    card,
    ...(origin && ctx.agentExecutionThreadId
      ? { origin, threadId: ctx.agentExecutionThreadId }
      : {}),
    nextStep,
  }
}

/**
 * What the person still does in Google Cloud, from the guide's own steps: each
 * step but those done in Liaison (connecting, picking shared drives) and the optional ones, with the exact
 * values to enter. Empty: nothing is left in Google Cloud.
 */
export function remainingInGoogleCloud(guide: {
  steps: Array<{
    id: string
    title: string
    values?: string[]
    optional?: boolean
    place?: "liaison" | "own"
  }>
}): string[] {
  // A step done in Liaison (connecting, the secret, picking shared drives) is
  // not left in Google Cloud.
  return guide.steps
    .filter((s) => s.place !== "liaison" && s.id !== "connect" && s.id !== "secret" && !s.optional)
    .map((s) => (s.values && s.values.length > 0 ? `${s.title}: ${s.values.join(", ")}` : s.title))
}

/** The sentence that leads `nextStep`: the remaining Google Cloud steps, or that there are none. */
function remainingStep(remaining: readonly string[]): string {
  if (remaining.length === 0) {
    return "Nothing is left to do in Google Cloud for the connections that are on: the person only connects."
  }
  return `Still to do in Google Cloud, BEFORE connecting (remainingInGoogleCloud): ${remaining.map((r, i) => `${i + 1}) ${r}`).join("; ")}. Tell the person to do these, one per message, before any Connect card. Never say nothing is left to do in Google Cloud.`
}

/** Connections left out of the steps because they take their own client (Drive, YouTube). */
function separateClientsStep(values: ReturnType<typeof computeGoogleSetupValues>): string {
  const separate = values.separateClients ?? []
  if (separate.length === 0) return ""
  return `Not part of this setup: ${separate.map((c) => `${c.app}/${c.connection}`).join(", ")} take a client of their own. Only if the person asks for one: in the same Google Cloud project, turn on its APIs (${[...new Set(separate.flatMap((c) => c.apis))].join(", ") || "none"}) and add its scopes, then its client card (kernel__request_secret kind oauth_client with that app and connection; the workspace's existing client ID and secret can be reused there).`
}

/** What the agent does next, from where each Google connection's client comes from. */
function googleNextStep(values: ReturnType<typeof computeGoogleSetupValues>): string {
  if (values.connections.length === 0) {
    return "No Google app is on: turn on the app the person needs first (kernel__config_apps)."
  }
  if (values.instanceClientOnly) {
    return "This server provides the Google client for every Google connection that is on: nothing is created in Google Cloud (no project, consent screen, client or Pub/Sub). The person only connects, with the Connect card. Only if they ask to use their own client, walk them through it (an org client overrides the instance's)."
  }
  if (values.clientReady && values.verifyApis) {
    const proven = new Set(
      values.connections
        .filter((c) => c.clientSource === "org" && c.clientProven)
        .flatMap((c) => c.scopes),
    )
    const unused = values.connections.filter(
      (c) => c.clientSource === "org" && !c.clientProven && c.scopes.some((s) => !proven.has(s)),
    )
    return `The workspace already has its own Google client, so no project, consent screen or client is created. But no account of ${unused.map((c) => `${c.app}/${c.connection}`).join(", ")} was connected with it yet: first have the person check, in that client's existing project, the guide's apis step (turn on ${values.apis.map((a) => a.name).join(", ") || "the APIs listed"}) and dataAccess step (add the scopes listed), one per message. Then the Connect card (kernel__request_secret kind oauth_connect). Quote the API names and scopes exactly as given.`
  }
  if (values.clientReady) {
    const name = (c: { app: string; connection: string }) => `${c.app}/${c.connection}`
    const own = values.connections.filter((c) => c.clientSource === "org").map(name)
    const server = values.connections.filter((c) => c.clientSource === "instance").map(name)
    return `The Google connections of this setup already have a client (the workspace's own for ${own.join(", ")}${server.length > 0 ? `; the server's for ${server.join(", ")}` : ""}): nothing is created in Google Cloud, so do not walk the project, consent screen, scopes or client steps again. The person only connects, with the Connect card (kernel__request_secret kind oauth_connect). Only if a connect fails because the client is wrong, ask for a new client with kind google_integration_client.`
  }
  const covered = values.connections.filter((c) => c.clientSource === "instance")
  const own = values.connections.filter((c) => c.clientSource === "org")
  const parts: string[] = []
  if (covered.length > 0) {
    parts.push(
      `The server provides the client for ${covered.map((c) => `${c.app}/${c.connection}`).join(", ")}: those only connect.`,
    )
  }
  if (own.length > 0) {
    parts.push(
      `The workspace already has its own client for ${own.map((c) => `${c.app}/${c.connection}`).join(", ")}.`,
    )
  }
  parts.push(
    "Walk the guide one step at a time for the rest: its scopes and APIs cover only the connections that still need a client. The client ID and secret go through kernel__request_secret.",
  )
  return parts.join(" ")
}

export async function handleShopifySetup(ctx: Pick<SetupGuideCtx, "orgId" | "userId">) {
  const t = translator(await localeFor(ctx.orgId, ctx.userId))
  const plan = await shopifyDashboardPlan(ctx.orgId, t)
  if ("error" in plan) return plan
  const nextStep =
    plan.values.clientSource === "instance"
      ? "This server provides the Shopify app: nothing to create. Post the Connect card (kernel__request_secret kind oauth_connect, app shopify, connection shop): the person enters their myshopify.com domain and approves."
      : plan.values.clientSource === "org"
        ? "The workspace already has its own Shopify app client: nothing to create. Post the Connect card (kernel__request_secret kind oauth_connect, app shopify, connection shop)."
        : "The person creates the store's own app in the Shopify Dev Dashboard, in the browser (no terminal). Walk `guide.steps` in order, one step per message, waiting for each to be done; never fold two steps into one message. Each step's `links` are the pages to open and its `values` go in your message in full, each on its own line in a code block: never summarise one as 'the required scopes'. Your message now is step open alone, unless the person already said the app is created. Step fullOrderHistory only if Release failed on read_all_orders; when Release went through, read_all_orders is granted, so say nothing about it. Step distribution, on its own: a message of its own (the choice is permanent). Step credentials only once the person says the app is installed: kernel__request_secret kind oauth_client (app shopify, connection shop), never in the chat. Step fullOrderHistorySetting is yours (who: agent) when read_all_orders is granted: propose its values with the tool it names (the person approves the card), then step connect: the Connect card (kernel__request_secret kind oauth_connect, app shopify, connection shop, mode org)."
  return { ...plan, nextStep }
}

export type ShopifyAppTomlResult =
  | {
      /** The instance provides the Shopify app: no file, the person only connects. */
      clientSource: "instance"
      file: null
      guide: ReturnType<typeof shopifySetupGuide>
      nextStep: string
    }
  | {
      /** Where the client comes from today: the workspace's own, or none yet. */
      clientSource: Exclude<OAuthClientSource, "instance">
      fileId: string
      filename: string
      /** True when the file is posted in this conversation for the person to download. */
      posted: boolean
      callbackUrl: string
      guide: ReturnType<typeof shopifySetupGuide>
      nextStep: string
    }
  | { error: { code: string; message: string; status?: 400; retryable?: boolean } }

/**
 * What the agent says after the file is posted. With the client ID filled in,
 * the next message is fixed: replace the file, deploy, then install. A weak
 * model otherwise jumps straight to the client card and the app is never
 * deployed or installed, so the store's connect fails.
 */
export function shopifyTomlNextStep(hasClientId: boolean): string {
  if (hasClientId) {
    return "The file is posted again with the client ID filled in. Your next message tells the person exactly this, and asks for nothing else: 1) replace their shopify.app.toml with this new file (same folder, same name: linking can overwrite the URLs); 2) run `shopify app deploy` in that folder; 3) tell you when the deploy is done. Do NOT post the client card or the Connect card in this message. After the deploy, one step per message: request Read all orders (the fullOrderHistory step: its value is the answer to paste in Shopify's form; do not wait for Shopify's approval), then custom distribution and install on the store (the distribution step). Only once they say the app is installed on the store, ask for the client ID and secret with kernel__request_secret kind oauth_client (app shopify, connection shop), then post the Connect card."
  }
  return "The file is posted in this conversation. Walk the person through the guide one step at a time; when they give you the client ID the CLI wrote, call this again with clientId. Right after the deploy, have them request Read all orders (the fullOrderHistory step: its value is the answer to paste in Shopify's form) and go on without waiting for Shopify's approval; once they say it is approved, turn on fullOrderHistory, call this again so the file lists read_all_orders, have them run `shopify app deploy`, then post the Connect card again (shopify-setup skill). Client ID and secret go through kernel__request_secret, never the chat."
}

export async function handleShopifyAppToml(
  params: { clientId?: string },
  ctx: SetupGuideCtx,
): Promise<ShopifyAppTomlResult> {
  const connection = connectionConfigRegistry.get([ctx.orgId, "shopify", "shop"])
  if (!connection) {
    return {
      error: {
        code: "shopify_not_installed",
        message:
          "The Shopify app is not on in this workspace. Turn it on first (kernel__config_apps), then call this again.",
        status: 400,
        retryable: true,
      },
    }
  }
  const callbackUrl = `${env.BASE_URL.replace(/\/+$/, "")}${CONNECTIONS_CALLBACK_PATH}`
  const client = await resolveOAuthClient(ctx.orgId, "shopify:shop")
  if (client.source === "instance") {
    // An org client always overrides the instance's, so a person who wants their
    // own app saves its client through the client card; no file is needed for that.
    const t = translator(await localeFor(ctx.orgId, ctx.userId))
    return {
      clientSource: "instance",
      file: null,
      guide: shopifySetupGuide(
        {
          clientSource: "instance",
          callbackUrl,
          hasClientId: true,
          handedFilename: SHOPIFY_APP_TOML_HANDED_FILENAME,
        },
        t,
      ),
      nextStep:
        "This server provides the Shopify app, so there is no app to create and no file to hand over: the person just connects their store with the Connect card (their myshopify.com domain, then approve). Only if they ask to use their own Shopify app, tell them to save its client ID and secret through kernel__request_secret; it then replaces the server's.",
    }
  }
  // A protected scope the org opted in to (full order history) is listed too:
  // Shopify grants only the scopes the released configuration names.
  const protectedScopes = await shopifyOptedInProtectedScopes(ctx.orgId, connection)
  const toml = shopifyAppToml(env.BASE_URL, connection, {
    clientId: params.clientId,
    protectedScopes,
  })
  const stored = await handleFilesUploadUrl(
    {
      filename: SHOPIFY_APP_TOML_HANDED_FILENAME,
      mimeType: "application/toml",
      contentBase64: Buffer.from(toml, "utf8").toString("base64"),
    },
    { orgId: ctx.orgId, userId: ctx.userId, db: ctx.db, actorType: "agent" },
  )
  if ("error" in stored) return stored
  if (!("fileId" in stored)) {
    return { error: { code: "file_not_stored", message: "The file could not be stored." } }
  }

  // Hand it over in the conversation the turn answers: a message of its own that
  // carries the file, posted as the agent. The file holds no workspace data, so
  // the message needs no scope to be read.
  let posted = false
  const threadId = ctx.agentExecutionThreadId
  if (threadId) {
    const message = await sendMessage(ctx.db, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      threadId,
      content: SHOPIFY_APP_TOML_HANDED_FILENAME,
      authorType: "agent",
      agentAuthorLabel: await resolveAgentAuthorLabel(ctx),
      requiredScopes: [],
    })
    if (message) {
      await attachFilesToParent(
        {
          sourceFileIds: [stored.fileId],
          target: { app: "kernel", entityType: "message", entityId: message.id },
        },
        {
          rlsTx: ctx.db,
          privileged: (reason, fn) => withPrivilegedDb(ctx.orgId, reason, fn),
          orgId: ctx.orgId,
          userId: ctx.userId,
          actorType: "agent",
          scopes: ["kernel:threads:write"],
        },
      )
      await publishMessageAttachments(ctx.db, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        threadId,
        messageId: message.id,
      })
      posted = true
    }
  }

  const t = translator(await localeFor(ctx.orgId, ctx.userId))
  return {
    clientSource: client.source,
    fileId: stored.fileId,
    filename: SHOPIFY_APP_TOML_HANDED_FILENAME,
    posted,
    callbackUrl,
    guide: shopifySetupGuide(
      {
        clientSource: client.source,
        callbackUrl,
        hasClientId: Boolean(params.clientId),
        handedFilename: SHOPIFY_APP_TOML_HANDED_FILENAME,
      },
      t,
    ),
    nextStep: posted
      ? shopifyTomlNextStep(Boolean(params.clientId))
      : `Not in a conversation: attach fileId ${stored.fileId} to a message with a send tool's attachments. The person saves it as shopify.app.toml.`,
  }
}

export function registerSetupGuideTools(orgId: string): void {
  toolRegistry.set([orgId, "kernel", "google_setup"], {
    appName: "kernel",
    name: "google_setup",
    deferLoading: true,
    description:
      "How to connect a mailbox or Google: pass the address as email to get its account type and path (trusted, consent, consumer_imap, own_client, imap, ask) with the exact steps and values; imapProvider for app-password steps.",
    // Deployment facts and app names, no record of the workspace: any member may read them.
    requiredScopes: ["kernel:threads:read"],
    readOnly: true,
    params: z.object({
      imapProvider: z
        .enum(IMAP_PROVIDER_IDS)
        .optional()
        .describe(
          "A mailbox that is not connected with Google: its app-password steps and servers.",
        ),
      email: z
        .string()
        .email()
        .max(320)
        .optional()
        .describe(
          "The address to connect (the person's own when they mean theirs): decides the path.",
        ),
      accountType: z
        .enum(MAIL_ACCOUNT_TYPES)
        .optional()
        .describe(
          "Only when the person says who hosts the mailbox and it differs from the detected type.",
        ),
      projectId: z
        .string()
        .regex(/^[a-z][a-z0-9-]{4,62}$/)
        .optional()
        .describe(
          "The Google Cloud project's ID when the person gave it (or a screenshot shows it): every API page link opens with that project selected.",
        ),
      feature: z
        .string()
        .max(64)
        .optional()
        .describe(
          "The one app being set up (mail, tickets, calendar, google-drive, ads, social): only its APIs and scopes; the other apps' APIs come as an optional aside.",
        ),
    }),
    // The registry parsed params against `params` before the handler runs.
    handler: (params, ctx: SetupGuideCtx) => handleGoogleSetup(params as GoogleSetupParams, ctx),
  })

  toolRegistry.set([orgId, "kernel", "drive_picker"], {
    appName: "kernel",
    name: "drive_picker",
    deferLoading: true,
    description:
      "Show the card where the person picks the Google Drive files Liaison can see (Drive in picked mode), with their Drive mode and what is picked. Use when a file they name cannot be found.",
    // The caller's own Drive accounts (and the org's, for its admins): no other record.
    requiredScopes: ["kernel:threads:read"],
    readOnly: true,
    params: z.object({}),
    handler: (params, ctx: SetupGuideCtx) => handleDrivePicker(params as DrivePickerParams, ctx),
  })

  toolRegistry.set([orgId, "kernel", "mailbox_setup"], {
    appName: "kernel",
    name: "mailbox_setup",
    deferLoading: true,
    description:
      "Show the card for the person's own personal mailbox: set the mailbox password a private mailbox waits for, or, with private true and only when the person asks for it, make a transparent mailbox private (zero-access).",
    searchKeywords: ["boîte", "gmail", "imap", "connecter"],
    // The caller's own personal mailboxes only (owner_id = the caller): no other record.
    requiredScopes: ["kernel:threads:read"],
    readOnly: true,
    params: z.object({
      email: z
        .string()
        .email()
        .max(320)
        .optional()
        .describe("The mailbox address, when the person has several."),
      private: z
        .boolean()
        .optional()
        .describe(
          "True only when the person asked for a private mailbox only they can read. Never on your own initiative.",
        ),
    }),
    handler: (params, ctx: SetupGuideCtx) => handleMailboxSetup(params as MailboxSetupParams, ctx),
  })

  toolRegistry.set([orgId, "kernel", "shopify_setup"], {
    appName: "kernel",
    name: "shopify_setup",
    deferLoading: true,
    description:
      "The steps to create the store's Shopify app in the Shopify Dev Dashboard (browser, no terminal), with the exact URLs, scopes and API version for this server; when a client already exists, it says to connect.",
    // Deployment facts and the app manifest, no record of the workspace.
    requiredScopes: ["kernel:threads:read"],
    readOnly: true,
    params: z.object({}),
    handler: (_params, ctx: SetupGuideCtx) => handleShopifySetup(ctx),
  })

  toolRegistry.set([orgId, "kernel", "shopify_app_toml"], {
    appName: "kernel",
    name: "shopify_app_toml",
    deferLoading: true,
    description:
      "Post this server's shopify.app.toml with the Shopify CLI steps. A store gets only the scopes the file lists: call it again, then deploy and reconnect, after turning on full order history or when a scope is missing.",
    requiredScopes: ["kernel:threads:write"],
    // Posts the file in the conversation (kernel.messages + kernel.files). Built from
    // the app manifest and BASE_URL, it carries nothing of the turn but the client id.
    writesToTable: SINK_KERNEL_MESSAGES,
    contentParams: ["clientId"],
    params: z.object({
      clientId: z
        .string()
        .regex(/^[A-Za-z0-9_-]{8,128}$/)
        .optional()
        .describe(
          "The client_id the Shopify CLI wrote after `shopify app config link`: the file comes back with it filled in.",
        ),
    }),
    handler: (params, ctx: SetupGuideCtx) =>
      handleShopifyAppToml(params as { clientId?: string }, ctx),
  })
}
