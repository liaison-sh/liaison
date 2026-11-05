// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Config sections as agent tools: `config_<section>` changes one section of
 * the org's configuration, the same data `liaison config apply` takes, through
 * the SAME section runner (`modules/provisioning/config-sections.ts`). No
 * handler here touches a provisioner: each one only plans and applies through
 * the runner.
 *
 * A write tool is gated and never auto-approved. At stage time its preflight
 * validates the input (secrets and server-disk fields are refused with what to
 * do instead) and plans it; the plan's hash and lines are pinned on the
 * approval. At execute time the handler acts as the APPROVER (never the
 * requester, never the delegated union): it checks every scope the data needs
 * against them, refuses a change that would lock the org out of its own
 * administration, takes the section's lease, re-plans, and refuses when the
 * plan differs from the approved one. A direct call by a person who holds the
 * scopes runs the same path as that person.
 *
 * Read tools: `config_export` (the current config, secrets as hints) and
 * `config_plan` (what a proposed change would do, not gated).
 */
import { createHash } from "node:crypto"
import { findRefTokens, GOOGLE_OAUTH_CLIENT_ID_SUFFIX } from "@liaison/shared"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { ConfigError } from "~/cli/config/parse"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { withSystemDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { loadRequesterContext } from "~/modules/approvals/event-data"
import { type ApprovalSummarizer, toolRegistry } from "~/modules/apps/app-registries"
import { registerApprovalSummarizer } from "~/modules/apps/approval-summarizers"
import { appIsOn, recordAppOn } from "~/modules/apps/enabled-apps"
import { checkRoleChangeKeepsAdmins } from "~/modules/provisioning/config-admin-guard"
import { exportOrgConfig } from "~/modules/provisioning/config-export"
import {
  ConfigLeaseBusyError,
  ConfigLeaseLostError,
  withConfigLease,
} from "~/modules/provisioning/config-lease"
import {
  missingScopes,
  requiredScopesForChange,
} from "~/modules/provisioning/config-section-scopes"
import {
  applySections,
  buildActorProvisionContext,
  type PlannedSection,
  type ProvisionActor,
  planSections,
} from "~/modules/provisioning/config-sections"
import {
  CONFIG_TOOL_SECTIONS,
  type ConfigToolSection,
  isConfigToolSection,
  parseSectionInput,
  SECTION_EXAMPLES,
  sectionJsonSchema,
  sectionShapeHint,
  stripSecretsFromResult,
} from "~/modules/provisioning/config-tool-input"
import { pendingWithCards } from "~/modules/secret-requests/pending-cards"

const log = rootLogger.child({ module: "config-tools" })

/** What the kernel runtime hands a config tool handler (a subset of AppContext). */
export interface ConfigToolCtx {
  orgId: string
  userId: string
  /** The person who approved this call; null for a direct call. */
  approverUserId?: string | null
  scopes?: string[]
  dimensionGrants?: Record<string, string[]>
}

const SECTION_LABEL: Record<ConfigToolSection, string> = {
  setup: "the features chosen for the setup",
  roles: "roles and their scopes",
  email: "the email sender identity",
  users: "people invited to the org",
  mail: "Mail app mailboxes",
  tickets: "ticket inboxes and ticket settings",
  apps: "apps, their config and connections",
  apiConnectors: "API connections (adapters)",
  knowledge: "knowledge collections and documents",
  agents: "role agents",
  invoicing: "invoicing issuers, tax regimes and e-invoicing",
  liaisonTeam: "sharing with the Liaison team",
}

/** sha256 of the canonical plan: what the approval binds. */
export function planHash(planned: PlannedSection[]): string {
  const canonical = JSON.stringify(
    planned.map((p) => ({ section: p.key, actions: p.plan.actions })),
  )
  return createHash("sha256").update(canonical).digest("hex")
}

function planLines(planned: PlannedSection[]): string[] {
  return planned.flatMap((p) => p.plan.actions)
}

async function orgIdentity(orgId: string): Promise<{ slug: string; name: string }> {
  const [org] = await withSystemDb("config-tool-org", (db) =>
    db
      .select({ slug: organizations.slug, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
  )
  if (!org) throw new Error(`config tool: org ${orgId} not found`)
  return org
}

/**
 * The person a config call acts as. An approved call acts as the approver with
 * their own persisted permissions, NOT the requester and NOT the union the
 * approval path hands handlers: the approver's click is the authority. A direct
 * call acts as the caller.
 */
export async function resolveConfigActor(ctx: ConfigToolCtx): Promise<ProvisionActor> {
  if (ctx.approverUserId) {
    const approver = await loadRequesterContext(
      ctx.orgId,
      ctx.approverUserId,
      "config-tool-approver",
    )
    return {
      userId: approver.userId,
      scopes: approver.scopes,
      dimensionGrants: approver.dimensionGrants,
    }
  }
  const caller = await loadRequesterContext(ctx.orgId, ctx.userId, "config-tool-caller")
  return {
    userId: ctx.userId,
    scopes: ctx.scopes ?? caller.scopes,
    dimensionGrants:
      ctx.dimensionGrants && Object.keys(ctx.dimensionGrants).length > 0
        ? ctx.dimensionGrants
        : caller.dimensionGrants,
  }
}

interface SectionParams {
  data: unknown
  planHash?: string
}

function sectionParams(section: ConfigToolSection, params: unknown): SectionParams {
  const record = typeof params === "object" && params !== null ? params : {}
  const data = section in record ? Reflect.get(record, section) : undefined
  const hash = Reflect.get(record, "planHash")
  return { data, ...(typeof hash === "string" ? { planHash: hash } : {}) }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function parse(
  section: ConfigToolSection,
  data: unknown,
  orgId: string,
): Promise<{ config: ProvisioningConfig } | { error: string }> {
  const parsed = parseSectionInput(section, data, await orgIdentity(orgId))
  return parsed.ok ? { config: parsed.config } : { error: parsed.error }
}

/**
 * A refused input: a 400 the model can act on (retryable: the next call with
 * the data fixed succeeds), never a 500 tool_error. It names the expected keys
 * and entry shapes, and an example, so a guessed shape is fixed in one step.
 */
export function inputRefusal(
  section: ConfigToolSection,
  error: string,
): { error: { code: string; message: string; status: 400; retryable: true } } {
  return {
    error: {
      code: "invalid_config",
      message:
        `${error}. kernel__config_${section} takes { ${section}: ${sectionShapeHint(section)} } ` +
        `(? marks an optional key). Example: ${JSON.stringify({ [section]: SECTION_EXAMPLES[section] })}`,
      status: 400,
      retryable: true,
    },
  }
}

/**
 * A legal identifier (a SIREN or SIRET) whose checksum fails. Final: the
 * number is wrong, and only the person knows the right one. Retrying with
 * another number is how a made-up identifier gets a valid checksum.
 */
const LEGAL_CHECKSUM =
  /\b(siren|siret)\b[^:]*: must be a \d+-digit (?:SIREN|SIRET) with a valid checksum/i

function legalChecksumRefusal(error: string): {
  error: { code: string; message: string; status: 400; retryable: false }
} {
  return {
    error: {
      code: "invalid_legal_identifier",
      message:
        `${error}. Nothing was saved. This number is not the company's: ask the person to type their exact ${LEGAL_CHECKSUM.exec(error)?.[1]?.toUpperCase() ?? "identifier"} in a message. ` +
        "Never try another number: a number that passes the checksum can belong to a real company. Call this tool again only with the value the person gives you.",
      status: 400,
      retryable: false,
    },
  }
}

/**
 * A Google client id that is not one (it does not end in the Google suffix):
 * typically another app's client id taken from the conversation, such as the
 * Shopify app's. Final for this value: retrying with another id from the
 * conversation repeats the mistake; only the id the person copies from their
 * Google Cloud client is right.
 */
function googleClientIdRefusal(error: string): {
  error: { code: string; message: string; status: 400; retryable: false }
} {
  return {
    error: {
      code: "invalid_google_client_id",
      message:
        `${error}. Nothing was saved. This value is not a Google OAuth client id (an id from another app, such as a Shopify app's client id, is never one). ` +
        `Leave google out of this call: the person enters the Google client ID and secret themselves on the card from kernel__request_secret kind google_integration_client. ` +
        `Only pass google.clientId when the person typed an id ending in "${GOOGLE_OAUTH_CLIENT_ID_SUFFIX}".`,
      status: 400,
      retryable: false,
    },
  }
}

/**
 * The refusal for input that does not parse; a bad legal identifier's and a
 * non-Google client id's are final, each with its own code.
 */
function refuseInput(section: ConfigToolSection, error: string) {
  if (section === "invoicing" && LEGAL_CHECKSUM.test(error)) return legalChecksumRefusal(error)
  if (/\.google\.clientId: /.test(error) && error.includes(GOOGLE_OAUTH_CLIENT_ID_SUFFIX)) {
    return googleClientIdRefusal(error)
  }
  return inputRefusal(section, error)
}

/** A plan refused on the data's meaning (an app that does not exist): retryable, no shape. */
function configRefusal(message: string): {
  error: { code: string; message: string; status: 400; retryable: true }
} {
  return { error: { code: "invalid_config", message, status: 400, retryable: true } }
}

/**
 * A refusal no re-approval of the same call can pass (the approved plan no
 * longer matches, or there is none): `final`, so the approval closes instead
 * of going back to pending (run-approved-handler, decide).
 */
function finalRefusal(
  code: string,
  message: string,
  plan?: string[],
): {
  error: { code: string; message: string; status: 409; final: true; body?: { plan: string[] } }
} {
  // The new plan rides as the error body, which reaches the agent with the message.
  return { error: { code, message, status: 409, final: true, ...(plan ? { body: { plan } } : {}) } }
}

/**
 * What a mailbox or inbox with saved credentials really is: saved, not synced.
 * `connected: true` in the section result means the connection row exists;
 * the first sync runs later in the background and can still fail (a wrong
 * host or password). Said in words, so the agent does not call it live.
 */
function syncState(section: ConfigToolSection, result: unknown): string | null {
  if (section !== "mail" && section !== "tickets") return null
  const entries = (() => {
    if (typeof result !== "object" || result === null) return []
    const list = Reflect.get(result, section === "mail" ? "mailboxes" : "inboxes")
    return Array.isArray(list) ? list : []
  })()
  const saved = entries
    .filter((e) => typeof e === "object" && e !== null && Reflect.get(e, "connected") === true)
    .map((e) => String(Reflect.get(e, "address") ?? ""))
  if (saved.length === 0) return null
  return `${saved.join(", ")}: credentials saved; first sync pending. The sync runs in the background and can still fail (a wrong host or password): never call a mailbox connected or live until the app's account list shows it synced without an error.`
}

/** STAGE-TIME: validate and plan as the requester; pin the plan on the approval. */
function configSectionPreflight(section: ConfigToolSection) {
  return async (params: unknown, ctx: ConfigToolCtx): Promise<unknown> => {
    const { data } = sectionParams(section, params)
    const parsed = await parse(section, data, ctx.orgId)
    if ("error" in parsed) return refuseInput(section, parsed.error)
    try {
      const actor = await resolveConfigActor({ ...ctx, approverUserId: null })
      const pctx = buildActorProvisionContext({ orgId: ctx.orgId, actor })
      const planned = await planSections(pctx, parsed.config, [section])
      return {
        ok: true,
        pinnedParams: { planHash: planHash(planned) },
      }
    } catch (err) {
      // The data names something the org lacks: a 400 the next call can fix.
      if (err instanceof ConfigError) return configRefusal(err.message)
      throw err
    }
  }
}

/** EXECUTE: the one handler body every config_<section> tool runs. */
function configSectionHandler(section: ConfigToolSection) {
  return async (params: unknown, ctx: ConfigToolCtx): Promise<unknown> => {
    const { data, planHash: approvedHash } = sectionParams(section, params)
    const parsed = await parse(section, data, ctx.orgId)
    if ("error" in parsed) return refuseInput(section, parsed.error)
    if (!approvedHash) {
      return finalRefusal(
        "invalid_request",
        `config_${section} carries no approved plan: call kernel__config_${section} again with the data itself`,
      )
    }
    const actor = await resolveConfigActor(ctx)
    // Every scope the change needs (for roles, revoked ones too), checked
    // before the first write.
    const missing = missingScopes(
      await requiredScopesForChange(ctx.orgId, section, parsed.config),
      actor.scopes,
    )
    if (missing.length > 0) {
      return {
        error: `missing scope: ${missing.join(", ")} (the person approving must hold every scope this change needs)`,
      }
    }
    try {
      return await withConfigLease(ctx.orgId, section, async (lease) => {
        const pctx = buildActorProvisionContext({ orgId: ctx.orgId, actor })
        const planned = await planSections(pctx, parsed.config, [section])
        if (planHash(planned) !== approvedHash) {
          return finalRefusal(
            "plan_changed",
            "the plan changed since approval; propose again",
            planLines(planned),
          )
        }
        // Inside the lease and after the re-plan: judged on the state this
        // change will actually be applied to, which no other config change can
        // alter until it is done.
        if (section === "roles") {
          const refusal = await checkRoleChangeKeepsAdmins(
            ctx.orgId,
            actor.userId,
            parsed.config.roles ?? [],
          )
          if (refusal) return { error: refusal }
        }
        const report = stripSecretsFromResult(
          await applySections(pctx, parsed.config, [section], {
            planned,
            beforeApply: () => lease.assertHeld(),
          }),
        )
        // Each secret or consent still missing names the exact request_secret
        // call that asks the person for it through a card: an OAuth client
        // card before its consent card (modules/secret-requests/pending-cards.ts).
        const pending = await pendingWithCards(ctx.orgId, report.pending)
        const needsSecret = pending.some((p) => "askWith" in p)
        const state = syncState(section, report.sections[section])
        return {
          section,
          plan: planLines(planned),
          changed: report.changed,
          unchanged: report.unchanged,
          // Said in words where the plan diffs against the stored rows (`changes` set),
          // so a weak model never reports a change that did not happen.
          ...(report.changed.length === 0 &&
          report.pending.length === 0 &&
          planned.every((p) => p.plan.changes !== undefined)
            ? {
                note: `Nothing changed: ${SECTION_LABEL[section]} already were as asked. Never tell the person it is now enabled, set or fixed.`,
              }
            : {}),
          pending,
          result: report.sections[section] ?? null,
          ...(state ? { state } : {}),
          ...(needsSecret
            ? {
                next: "Some entries wait on the person: for each pending item, in order, call its askWith tool with its params (a card where the person types a secret or signs in at the provider; you never see either). When the conversation says a card was saved or connected, call this tool again.",
              }
            : {}),
        }
      })
    } catch (err) {
      if (
        err instanceof ConfigError ||
        err instanceof ConfigLeaseBusyError ||
        err instanceof ConfigLeaseLostError
      ) {
        return { error: err.message }
      }
      log.error({ err, orgId: ctx.orgId, section }, "config tool apply failed")
      return { error: `config_${section} failed: ${errorText(err)}` }
    }
  }
}

/**
 * The approval card: the plan, computed here from the call's DATA as the
 * requester, never read from a param (a param is the caller's to set).
 */
function configSectionSummarizer(section: ConfigToolSection): ApprovalSummarizer {
  return async (raw, ctx) => {
    let lines: string[]
    try {
      const { data } = sectionParams(section, raw)
      const parsed = await parse(section, data, ctx.orgId)
      if ("error" in parsed) {
        lines = [`This change is invalid: ${parsed.error}`]
      } else {
        const actor = await resolveConfigActor({ orgId: ctx.orgId, userId: ctx.userId })
        const pctx = buildActorProvisionContext({ orgId: ctx.orgId, actor })
        lines = planLines(await planSections(pctx, parsed.config, [section]))
      }
    } catch (err) {
      lines = [`The plan could not be computed: ${errorText(err)}`]
    }
    // The card shows what the change does: an entry it leaves as it is is not a line to approve.
    const changes = lines.filter((l) => !UNCHANGED_LINE.test(l))
    const real = changes.length > 0 ? changes : lines
    const shown = real.length > 8 ? [...real.slice(0, 7), `and ${real.length - 7} more`] : real
    return {
      kind: "config",
      title: `Change ${SECTION_LABEL[section]}`,
      lines: shown.length > 0 ? shown : ["This change has nothing to do."],
      impact: "internal",
    }
  }
}

/** A plan line for an entry the change leaves as it is (`app 'tickets' unchanged`). */
const UNCHANGED_LINE = / unchanged$/

/** What a call that changes nothing says, to the agent and through it to the person. */
function noChangeNote(section: ConfigToolSection): string {
  return (
    `Nothing changes: ${SECTION_LABEL[section]} already are as asked (every entry of this call is already in that state), so no approval was asked of the person and nothing was written. ` +
    "Reply now with tellThePerson, in your own words: never tell the person it is now enabled, set or fixed. " +
    "This request is done: do not call another tool for it, and post no card (no kernel__request_secret, no connect or secret card) the person did not ask for in their latest message. " +
    "If something related is left to do (an app of this call not connected yet), you may ASK the person whether they want it, as a question at the end of your reply, and act only once they say yes. " +
    "Doing it again cannot fix an error they see: say plainly that you do not know the fix."
  )
}

/** A name a person reads for an app (`google-drive` → `Google drive`). */
function appLabel(name: string): string {
  const words = name.replace(/[-_]+/g, " ")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The plain sentence a call that changes nothing leads with, for the person:
 * "Tickets is already on. Nothing to change." An app entry naming only its
 * switch says which way it already is; any other entry is "already set as asked".
 */
export function noChangeSentence(section: ConfigToolSection, config: ProvisioningConfig): string {
  if (section === "apps") {
    const parts = (config.apps ?? []).map((app) => {
      const onlySwitch = Object.keys(app).every((k) => k === "name" || k === "enable")
      const label = appLabel(app.name)
      if (!onlySwitch) return `${label} is already set as asked`
      return app.enable === false ? `${label} is already off` : `${label} is already on`
    })
    if (parts.length > 0) return `${parts.join("; ")}. Nothing to change.`
  }
  const label = SECTION_LABEL[section]
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} already are as asked. Nothing to change.`
}

/**
 * BEFORE ANY GATE: a call whose plan changes nothing (every entry already in
 * the requested state: an app already on, a setting already equal) answers at
 * once with `changed: false`, and no card asks a person to approve it. Only a
 * plan that diffs against the stored rows can say so (`changes` is set): one
 * that echoes its params goes on to the card. An apps entry with a connection
 * goes on too: its apply names the cards that connect it.
 */
export async function configNoChange(
  section: ConfigToolSection,
  params: unknown,
  ctx: { orgId: string; userId: string; scopes?: readonly string[] },
): Promise<{
  tellThePerson: string
  section: ConfigToolSection
  changed: false
  plan: string[]
  note: string
  next: string
} | null> {
  if (ctx.userId === "system") return null
  const { data } = sectionParams(section, params)
  const parsed = await parse(section, data, ctx.orgId)
  // A refused input is the preflight's to answer, with its own words.
  if ("error" in parsed) return null
  if (section === "apps" && (parsed.config.apps ?? []).some((a) => a.connection)) return null
  let planned: PlannedSection[]
  try {
    const actor = await resolveConfigActor({
      orgId: ctx.orgId,
      userId: ctx.userId,
      ...(ctx.scopes ? { scopes: [...ctx.scopes] } : {}),
      approverUserId: null,
    })
    planned = await planSections(
      buildActorProvisionContext({ orgId: ctx.orgId, actor }),
      parsed.config,
      [section],
    )
  } catch (err) {
    if (err instanceof ConfigError) return null
    throw err
  }
  if (planned.length === 0 || planned.some((p) => p.plan.changes !== 0)) return null
  if (section === "apps") {
    // An app on but missing from the curation list is recorded there: nobody sees it.
    for (const app of parsed.config.apps ?? []) {
      if (app.enable !== false && (await appIsOn(ctx.orgId, app.name))) {
        await recordAppOn(ctx.orgId, app.name)
      }
    }
  }
  // Leads with the sentence for the person, and its only next step is that
  // reply: a no-op is a finished request, never a cue to resume another goal.
  return {
    tellThePerson: noChangeSentence(section, parsed.config),
    section,
    changed: false,
    plan: planLines(planned),
    note: noChangeNote(section),
    next: "Reply to the person with tellThePerson. Nothing else is needed for this request.",
  }
}

/** A call naming an earlier step's result (`@ref:`) has no data to plan yet. */
function refuseReference(params: unknown): unknown | null {
  return findRefTokens(params).length > 0
    ? {
        error:
          "this tool can't take a reference to an earlier step; call it after that step completes",
      }
    : null
}

async function handleConfigPlan(params: unknown, ctx: ConfigToolCtx): Promise<unknown> {
  const sections =
    typeof params === "object" && params !== null ? Reflect.get(params, "sections") : undefined
  if (typeof sections !== "object" || sections === null || Array.isArray(sections)) {
    return {
      error: {
        code: "invalid_config",
        message: `sections must be an object keyed by section name (${CONFIG_TOOL_SECTIONS.join(", ")}), e.g. { "roles": [...] }`,
        status: 400,
        retryable: true,
      },
    }
  }
  const actor = await resolveConfigActor({ ...ctx, approverUserId: null })
  const out: Array<{ section: string; plan: string[]; changes: number | null; planHash: string }> =
    []
  for (const [name, data] of Object.entries(sections)) {
    if (!isConfigToolSection(name)) {
      return {
        error: {
          code: "invalid_config",
          message: `unknown section '${name}' (one of ${CONFIG_TOOL_SECTIONS.join(", ")})`,
          status: 400,
          retryable: true,
        },
      }
    }
    const parsed = await parse(name, data, ctx.orgId)
    if ("error" in parsed) return refuseInput(name, parsed.error)
    const missing = missingScopes(
      await requiredScopesForChange(ctx.orgId, name, parsed.config),
      actor.scopes,
    )
    if (missing.length > 0) return { error: `missing scope: ${missing.join(", ")}` }
    try {
      const pctx = buildActorProvisionContext({ orgId: ctx.orgId, actor })
      const planned = await planSections(pctx, parsed.config, [name])
      out.push({
        section: name,
        plan: planLines(planned),
        changes: planned[0]?.plan.changes ?? null,
        planHash: planHash(planned),
      })
    } catch (err) {
      if (err instanceof ConfigError) return configRefusal(err.message)
      throw err
    }
  }
  return { plans: out }
}

async function handleConfigExport(_params: unknown, ctx: ConfigToolCtx): Promise<unknown> {
  const actor = await resolveConfigActor({ ...ctx, approverUserId: null })
  return exportOrgConfig(ctx.orgId, actor)
}

function sectionParamsSchema(section: ConfigToolSection) {
  return z.object({
    // The model reads the section's real shape (its JSON schema, carried as
    // metadata); the value is validated by the handler's parse, whose refusal
    // names a secret field's card instead of an unknown key.
    [section]: z.unknown().meta({
      ...sectionJsonSchema(section),
      description: `The "${section}" section, exactly as in a liaison config file (kernel__config_export shows the current one). Secrets are left out: they go through kernel__request_secret.`,
    }),
    planHash: z.string().optional().describe("Set by the server when the change is proposed."),
  })
}

/** The section a `config_<section>` tool name names. */
function sectionOfTool(name: string): ConfigToolSection {
  const section = name.slice("config_".length)
  if (!isConfigToolSection(section)) throw new Error(`not a config section tool: ${name}`)
  return section
}

export function registerConfigTools(orgId: string): void {
  // Literal names, descriptions and scopes: the reference docs read them from
  // here (scripts/docs/gen-reference.ts); config-tools.test.ts pins the scopes
  // to SECTION_BASE_SCOPE and the descriptions to 240 characters.
  for (const t of [
    {
      name: "config_roles",
      description:
        "Change roles and their scopes: the roles section of liaison config apply. Read kernel__config_export first. Gated. Secrets go through kernel__request_secret, files as uploaded file ids.",
      requiredScopes: ["kernel:roles:admin"],
    },
    {
      name: "config_setup",
      description:
        "Record which features the person chose to set up (setup.features): setup state counts only these as left, the rest is a menu. Read kernel__setup_state first. Gated.",
      requiredScopes: ["kernel:org:admin"],
    },
    {
      name: "config_email",
      description:
        "Change the email sender identity: the email section of liaison config apply. Read kernel__config_export first. Gated. Secrets go through kernel__request_secret, files as uploaded file ids.",
      requiredScopes: ["kernel:org:admin"],
    },
    {
      name: "config_users",
      description:
        "Change people invited to the org: the users section of liaison config apply. Read kernel__config_export first. Gated. Secrets go through kernel__request_secret, files as uploaded file ids.",
      requiredScopes: ["kernel:users:admin"],
    },
    {
      name: "config_mail",
      description:
        "Change Mail app mailboxes: the mail section of liaison config apply. Read kernel__config_export first. Gated. Secrets go through kernel__request_secret, files as uploaded file ids.",
      requiredScopes: ["mail:accounts:admin"],
    },
    {
      name: "config_tickets",
      description:
        "Change ticket inboxes and ticket settings: the tickets section of liaison config apply. Read kernel__config_export first. Gated. Secrets go through kernel__request_secret, files as uploaded file ids.",
      requiredScopes: ["tickets:inboxes:admin"],
    },
    {
      name: "config_apps",
      description:
        "Change apps, their config, settings and connections: the apps section of liaison config apply. Read kernel__config_export first. Gated. Secrets go through kernel__request_secret, files as uploaded file ids.",
      requiredScopes: ["kernel:apps:admin"],
    },
    {
      name: "config_apiConnectors",
      description:
        "Change API connections as a liaison config apply section. To connect one system (a CRM, ERP, any HTTP API) use api-connector__connector_adapter_save: it checks the adapter and lists every issue. Gated.",
      requiredScopes: ["api-connector:admin"],
    },
    {
      name: "config_knowledge",
      description:
        "Change knowledge collections and documents: the knowledge section of liaison config apply. Read kernel__config_export first. Gated. Secrets go through kernel__request_secret, files as uploaded file ids.",
      requiredScopes: ["knowledge:documents:create"],
    },
    {
      name: "config_agents",
      description:
        "Change role agents: the agents section of liaison config apply. Read kernel__config_export first. Gated. Secrets go through kernel__request_secret, files as uploaded file ids.",
      requiredScopes: ["kernel:agents:admin"],
    },
    {
      name: "config_invoicing",
      description:
        "Change invoicing issuers, tax regimes and e-invoicing (the invoicing section of liaison config apply). Gated. An issuer's legal identity (SIREN, VAT, IBAN, address) only as the person gave it: ask, never invent.",
      requiredScopes: ["invoicing:settings:write"],
    },
    {
      name: "config_liaisonTeam",
      description:
        "Record whether this server registers with the Liaison team and may forward bug reports (liaisonTeam: register, forwardBugReports). Ask the person first; both default to no. Read kernel__setup_state first. Gated.",
      requiredScopes: ["kernel:org:admin"],
    },
  ]) {
    const section = sectionOfTool(t.name)
    toolRegistry.set([orgId, "kernel", t.name], {
      appName: "kernel",
      name: t.name,
      deferLoading: true,
      description: t.description,
      requiredScopes: t.requiredScopes,
      // Organization configuration is administrative: decided by the admin-grade scope.
      approveScope: "kernel:approve",
      trustBoundary: "user",
      gated: true,
      noAutoApprove: true,
      approvalImpact: "internal",
      // The approval binds the plan hash the preflight pins; a caller's value is dropped.
      pinnedParams: ["planHash"],
      // A reference has no data yet; a change that changes nothing answers at once, with no card.
      refuseBeforeGate: async (params, ctx) =>
        refuseReference(params) ?? (await configNoChange(section, params, ctx)),
      params: sectionParamsSchema(section),
      preflight: configSectionPreflight(section),
      handler: configSectionHandler(section),
    })
    registerApprovalSummarizer(orgId, "kernel", t.name, configSectionSummarizer(section))
  }
  toolRegistry.set([orgId, "kernel", "config_plan"], {
    appName: "kernel",
    name: "config_plan",
    deferLoading: true,
    description:
      "Show what a proposed config change would do, section by section, without changing anything. Same data as the kernel__config_<section> tools.",
    requiredScopes: ["kernel:org:admin"],
    readOnly: true,
    params: z.object({
      sections: z
        .record(z.string(), z.unknown())
        .describe("Section name to its data, e.g. { roles: [...] }."),
    }),
    handler: handleConfigPlan,
  })
  toolRegistry.set([orgId, "kernel", "config_export"], {
    appName: "kernel",
    name: "config_export",
    deferLoading: true,
    description:
      "Read the org's current configuration in the liaison config apply format (roles, email, users, apps, agents, API connections, knowledge collections, invoicing issuers, Liaison team opt-ins). Secrets are never returned.",
    requiredScopes: ["kernel:org:admin"],
    readOnly: true,
    params: z.object({}),
    handler: handleConfigExport,
  })
}
