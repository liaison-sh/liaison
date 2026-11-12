// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `liaison guide <google|shopify|imap|server|<app>/<connection>> [--email <addr>]
 * [--org <slug>] [--locale en|fr] [--json]`: the connection guide the in-product
 * agent gives, for a terminal or a setup skill. Read only.
 *
 * It computes the same values and path through the same functions the agent's
 * tools use (`modules/connection-guides/plan.ts`) and prints the same
 * shared-builder steps, as text or as JSON (`--json`: path, account type,
 * statement, values and steps). Nothing it prints is secret: client IDs are
 * public, secrets are never read.
 *
 * - google: the address's account type and connect path (trusted, consent,
 *   consumer_imap, own_client, imap, ask) with its steps.
 * - shopify: the Shopify Dev Dashboard steps, with this server's URLs, scopes
 *   and API version (or "connect" when a client already exists).
 * - imap: the app-password steps and servers of the address's provider, or of
 *   every known provider without an address.
 * - server: what the person who runs the server sets up (domain, mail sender
 *   records, Google sign-in, server OAuth clients, push, storage, keys,
 *   backups), each with its state read from this server's env
 *   (connection-guides/server-setup.ts, also behind `kernel__setup_state`).
 * - <app>/<connection>: any connection of an app that is on, with the steps its
 *   client card shows (connection-guides/connection-setup.ts): the manifest's
 *   steps, the redirect URI, the scopes, the webhook URLs and how the values
 *   reach Liaison. A Google, Shopify or IMAP connection prints that guide.
 */

import {
  IMAP_PROVIDERS,
  type ImapProvider,
  imapPasswordGuide,
  MAIL_ACCOUNT_TYPES,
  type MailAccountType,
  resolveLocale,
  type SetupGuide,
  SHOPIFY_APP_TOML,
  type ShippedLocale,
} from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel } from "~/apps/tickets/schema-refs"
import { resolveOrgId } from "~/cli/lib/resolve-org-id"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { detectMailAccountType, type MxResolver } from "~/modules/connection-guides/account-type"
import {
  type ConnectionSetup,
  connectionSetupExtraSteps,
} from "~/modules/connection-guides/connection-setup"
import {
  appConnectionSetup,
  googleConnectPlan,
  orgConnections,
  resolveGoogleSetupValues,
  shopifyCliPlan,
  shopifyDashboardPlan,
  translator,
} from "~/modules/connection-guides/plan"
import { renderServerSurface, serverSetup } from "~/modules/connection-guides/server-setup"

export const GUIDE_PROVIDERS = ["google", "shopify", "imap"] as const
export type GuideProvider = (typeof GUIDE_PROVIDERS)[number]

export const GUIDE_USAGE =
  "usage: liaison guide <google|shopify|imap|server|<app>/<connection>> [--email <addr>] [--account-type <type>] [--project <id>] [--feature <app>] [--cli] [--org <slug>] [--locale en|fr] [--json]"

export interface RunGuideArgs {
  provider: string | undefined
  email?: string
  /** The person's word on who hosts the mailbox, over what the domain shows. */
  accountType?: string
  /** Google: the Cloud project's id (API page links preselect it). */
  project?: string
  /** Google: the one feature (app) being set up. */
  feature?: string
  /** Shopify: the Shopify CLI steps (a coding agent) instead of the Dev Dashboard. */
  cli?: boolean
  orgSlug?: string
  locale?: string
  json?: boolean
}

export interface GuideDeps {
  ensureAppsForOrg: (orgId: string) => Promise<void>
  /** STDOUT (the guide). */
  out: (text: string) => void
  /** STDERR (errors). */
  err: (text: string) => void
  /** The MX lookup (tests inject one). */
  resolver?: MxResolver
}

const defaultDeps: GuideDeps = {
  ensureAppsForOrg,
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(`${text}\n`),
}

/** A guide as numbered text: title, then each step with its values indented. */
export function renderGuideText(guide: SetupGuide): string[] {
  const lines = [guide.title, ""]
  for (const [i, step] of guide.steps.entries()) {
    const notes = [
      ...(step.optional ? ["optional"] : []),
      ...(step.who !== "agent" && step.minutes ? [`about ${step.minutes} min`] : []),
    ]
    lines.push(`${i + 1}. ${step.title}${notes.length ? ` (${notes.join(", ")})` : ""}`)
    if (step.body) lines.push(`   ${step.body}`)
    for (const link of step.links ?? []) lines.push(`   ${link.label}: ${link.url}`)
    for (const v of step.values ?? []) {
      for (const [j, line] of v.split("\n").entries())
        lines.push(`${j === 0 ? "   > " : "     "}${line}`)
    }
    lines.push("")
  }
  return lines
}

async function orgDefaultLocale(orgId: string): Promise<string | null> {
  return withPrivilegedDb(orgId, "cli-guide-locale", async (tx) => {
    const rows = extractRows<{ default_locale: string }>(
      await tx.execute(
        drizzleSql`SELECT default_locale FROM ${kernelRel("organizations")} WHERE id = ${orgId}::uuid`,
      ),
    )
    return rows[0]?.default_locale ?? null
  })
}

/** What `liaison guide` prints, as data: the JSON form, and the text lines. */
export interface GuideReport {
  json: Record<string, unknown>
  text: string[]
}

/** The guide of one provider for an org, computed like the agent's tools. */
export async function buildGuide(
  provider: GuideProvider,
  orgId: string,
  locale: ShippedLocale,
  email: string | undefined,
  resolver?: MxResolver,
  accountType?: MailAccountType,
  options: { project?: string; feature?: string; cli?: boolean } = {},
): Promise<{ ok: true; report: GuideReport } | { ok: false; message: string }> {
  const t = translator(locale)
  if (provider === "google") {
    const values = await resolveGoogleSetupValues(orgId, {
      ...(options.project ? { projectId: options.project } : {}),
      // The address being connected is the admin's own during setup: the consent
      // screen's support email.
      ...(email ? { supportEmail: email } : {}),
      ...(options.feature ? { feature: options.feature } : {}),
    })
    const plan = await googleConnectPlan(
      values,
      t,
      { email, ...(accountType ? { accountType } : {}) },
      { resolver },
    )
    const text: string[] = [
      `path: ${plan.path}${plan.accountType ? ` (account type: ${plan.accountType})` : ""}`,
      "",
    ]
    if (plan.statement) text.push(plan.statement, "")
    if (plan.guide) text.push(...renderGuideText(plan.guide))
    else if (plan.path === "ask") {
      text.push(
        email
          ? "The address's domain did not answer: say who hosts the mailbox (Google Workspace, personal Gmail, Microsoft 365, another), or run `liaison guide imap`."
          : "Pass --email <addr> for the path of that address.",
      )
    }
    if (plan.imap && plan.imap.guide !== plan.guide) text.push(...renderGuideText(plan.imap.guide))
    const drivePickerUrl = `${values.baseUrl}/settings/apps/google-drive`
    if (plan.driveMode === "full") {
      text.push("", "Google Drive: full (Liaison reads the whole Drive once connected).")
    } else if (plan.driveMode === "picked") {
      text.push(
        "",
        "Google Drive: picked (drive.file). With an account that is not on Google Workspace the person chooses which Drive files Liaison can see; a Google Workspace account can share the whole Drive.",
        `The Google Picker runs in Liaison, not here: after connecting, choose the files at ${drivePickerUrl} (or on the agent's picker card).`,
      )
      text.push(
        "The Google Picker needs its API key and project number in the google-drive app's config: `apps: [{ name: google-drive, config: { pickerApiKey, pickerAppId } }]` with `liaison config apply`.",
      )
    }
    return {
      ok: true,
      report: {
        json: {
          provider,
          ...plan,
          ...(plan.driveMode === "picked"
            ? { drivePicker: { url: drivePickerUrl, configKeys: ["pickerApiKey", "pickerAppId"] } }
            : {}),
          values,
        },
        text,
      },
    }
  }
  if (provider === "shopify" && options.cli) {
    const plan = await shopifyCliPlan(orgId, t)
    if ("error" in plan) {
      return {
        ok: false,
        message:
          plan.error.code === "shopify_not_installed"
            ? "the Shopify app is not on in this org: turn it on (config `apps`), then run this again"
            : plan.error.message,
      }
    }
    return {
      ok: true,
      report: {
        json: { provider, cli: true, guide: plan.guide, toml: plan.toml },
        text: [
          ...renderGuideText(plan.guide),
          `Write this as ${SHOPIFY_APP_TOML} in an empty folder (step 1):`,
          "",
          plan.toml,
        ],
      },
    }
  }
  if (provider === "shopify") {
    const plan = await shopifyDashboardPlan(orgId, t, "agent")
    if ("error" in plan) {
      return {
        ok: false,
        message:
          plan.error.code === "shopify_not_installed"
            ? "the Shopify app is not on in this org: turn it on (config `apps`), then run this again"
            : plan.error.message,
      }
    }
    return {
      ok: true,
      report: {
        json: { provider, values: plan.values, guide: plan.guide },
        text: [
          `client: ${plan.values.clientSource}`,
          "",
          ...renderGuideText(plan.guide),
          "A coding agent with a shell can use the Shopify CLI instead: `liaison guide shopify --cli` prints its steps and the shopify.app.toml generated for this server; never edit its scopes or URLs by hand.",
        ],
      },
    }
  }
  // imap
  const detected = email ? await detectMailAccountType(email, { resolver }) : null
  const providers: ImapProvider[] = detected?.imapProvider
    ? [detected.imapProvider]
    : (Object.keys(IMAP_PROVIDERS) as ImapProvider[])
  const guides = providers.map((p) => ({
    provider: p,
    settings: IMAP_PROVIDERS[p],
    guide: imapPasswordGuide(p, t),
  }))
  const text: string[] = []
  if (detected) text.push(`account type: ${detected.accountType}`, "")
  for (const g of guides) text.push(...renderGuideText(g.guide))
  if (detected && !detected.imapProvider) {
    text.push(
      "This provider is not in the known list: ask it for its IMAP and SMTP servers and an app password.",
    )
  }
  return {
    ok: true,
    report: {
      json: {
        provider,
        ...(detected ? { accountType: detected.accountType } : {}),
        imap: guides,
      },
      text,
    },
  }
}

/** One connection's guide as text: the manifest's steps, then the computed ones. */
export function renderConnectionSetup(setup: ConnectionSetup): string[] {
  const lines = [
    `${setup.app}/${setup.connection}${setup.purpose ? `: ${setup.purpose}` : ""} (${setup.type}${setup.optional ? ", optional" : ""})`,
    "",
  ]
  if (setup.summary) lines.push(setup.summary, "")
  const steps = [...setup.steps, ...connectionSetupExtraSteps(setup, "cli")]
  for (const [i, step] of steps.entries()) {
    const who =
      step.who === "human" ? `HUMAN${step.minutes ? `, ${step.minutes} min` : ""}` : "AGENT"
    lines.push(`${i + 1}. [${who}] ${step.text}`)
    if (step.url) lines.push(`   Open: ${step.url}`)
    for (const v of step.values ?? []) lines.push(`   > ${v}`)
  }
  if (setup.docsUrl) lines.push("", `Provider docs: ${setup.docsUrl}`)
  return lines
}

export function createGuide(deps: GuideDeps = defaultDeps) {
  return async function runGuide(args: RunGuideArgs): Promise<{ exitCode: number }> {
    if (args.provider === "server") {
      const surfaces = serverSetup(env)
      if (args.json) deps.out(`${JSON.stringify({ server: surfaces }, null, 2)}\n`)
      else deps.out(`${surfaces.flatMap(renderServerSurface).join("\n").trimEnd()}\n`)
      return { exitCode: 0 }
    }
    if (args.provider?.includes("/")) return runConnectionGuide(args)
    const provider = GUIDE_PROVIDERS.find((p) => p === args.provider)
    if (!provider) {
      deps.err(GUIDE_USAGE)
      return { exitCode: 2 }
    }
    const accountType = MAIL_ACCOUNT_TYPES.find((type) => type === args.accountType)
    if (args.accountType !== undefined && !accountType) {
      deps.err(
        `guide: --account-type must be one of ${MAIL_ACCOUNT_TYPES.join(", ")}\n${GUIDE_USAGE}`,
      )
      return { exitCode: 2 }
    }
    if (args.project !== undefined && !/^[a-z][a-z0-9-]{4,62}$/.test(args.project)) {
      deps.err(
        `guide: --project must be a Google Cloud project ID (e.g. liaison-123456)\n${GUIDE_USAGE}`,
      )
      return { exitCode: 2 }
    }
    if (args.locale !== undefined && !["en", "fr"].includes(args.locale)) {
      deps.err(`guide: --locale must be en or fr\n${GUIDE_USAGE}`)
      return { exitCode: 2 }
    }
    const resolved = await resolveOrgId(
      args.orgSlug,
      "multiple orgs exist — pass --org <slug> to disambiguate",
    )
    if (!resolved.ok) {
      deps.err(`guide: ${resolved.message}`)
      return { exitCode: 2 }
    }
    await deps.ensureAppsForOrg(resolved.orgId)
    const locale = resolveLocale(args.locale ?? null, await orgDefaultLocale(resolved.orgId))
    const built = await buildGuide(
      provider,
      resolved.orgId,
      locale,
      args.email,
      deps.resolver,
      accountType,
      {
        ...(args.project ? { project: args.project } : {}),
        ...(args.feature ? { feature: args.feature } : {}),
        ...(args.cli ? { cli: true } : {}),
      },
    )
    if (!built.ok) {
      deps.err(`guide: ${built.message}`)
      return { exitCode: 1 }
    }
    if (args.json) deps.out(`${JSON.stringify(built.report.json, null, 2)}\n`)
    else deps.out(`${built.report.text.join("\n").trimEnd()}\n`)
    return { exitCode: 0 }
  }
  /** `liaison guide <app>/<connection>`. */
  async function runConnectionGuide(args: RunGuideArgs): Promise<{ exitCode: number }> {
    const [app = "", connection = ""] = (args.provider ?? "").split("/", 2)
    const resolved = await resolveOrgId(
      args.orgSlug,
      "multiple orgs exist — pass --org <slug> to disambiguate",
    )
    if (!resolved.ok) {
      deps.err(`guide: ${resolved.message}`)
      return { exitCode: 2 }
    }
    await deps.ensureAppsForOrg(resolved.orgId)
    const setup = await appConnectionSetup(resolved.orgId, app, connection)
    if (!setup) {
      const known = orgConnections(resolved.orgId).map(([a, c]) => `${a}/${c}`)
      deps.err(
        `guide: no connection '${app}/${connection}' in the apps that are on. Known: ${known.join(", ") || "none (turn an app on first)"}`,
      )
      return { exitCode: 2 }
    }
    if (setup.family !== "app") {
      return createGuide(deps)({ ...args, provider: setup.family })
    }
    if (args.json) {
      deps.out(
        `${JSON.stringify({ ...setup, extraSteps: connectionSetupExtraSteps(setup, "cli") }, null, 2)}\n`,
      )
    } else deps.out(`${renderConnectionSetup(setup).join("\n").trimEnd()}\n`)
    return { exitCode: 0 }
  }
}

const productionGuide = createGuide()

export function runGuide(args: RunGuideArgs): Promise<{ exitCode: number }> {
  return productionGuide(args)
}
