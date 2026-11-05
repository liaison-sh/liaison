// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * THE FIRST RUN: the agent opens a new workspace's setup with its first admin.
 *
 * When an administrator signs in to a workspace that is brand new (not a demo,
 * no message anybody wrote yet, no kickoff posted), their personal agent's
 * conversation gets one card, headed "Set up your space": what is set up and
 * what is left (setup-state.ts, read from rows), the demo offer, and, when the
 * workspace has no model key the agent could answer with, the key card. The
 * conversation is pinned for that admin. With a key, the agent's own first
 * turn follows the card; without one, saving the key wakes it through the
 * secret card's existing path (secret-requests/announce.ts).
 *
 * Nothing here is a flag: "due" is derived from rows every time, and the posted
 * card is itself what makes it not due any more. An existing workspace (it has
 * messages) never gets one, so a deploy kicks off nobody.
 *
 * The sign-in path calls `startSetupKickoff` and never waits for it: it returns
 * at once, every failure is logged and swallowed, and a workspace found not due
 * is remembered in this process so a token refresh costs one Set lookup.
 */
import { orgKernelSettingsSchema, resolveLocale } from "@liaison/shared"
import { sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows } from "~/db"
import { advisoryXactLock } from "~/db/advisory-lock"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { organizations, users } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { getOrgKernelSettings } from "~/lib/settings"
import { hasUsableModelKey } from "~/modules/agent/credits/credit-meter"
import { getOrCreatePersonalAgentId } from "~/modules/agent/directory/personal-agent"
import { isDemoOrgId } from "~/modules/demo/demo-org"
import { serverT } from "~/modules/i18n/server-i18n"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { computeSetupState, type SetupState } from "~/modules/provisioning/setup-state"
import { createSecretRequest } from "~/modules/secret-requests/service"
import { sendMessage } from "~/modules/threads/message"
import { createOrGetAgentDm } from "~/modules/threads/thread"
import { updateThreadState } from "~/modules/threads/thread-state"

const log = rootLogger.child({ module: "setup-kickoff" })

/** The job that posts the card (and starts the agent's first turn). */
export const SETUP_KICKOFF_JOB = "setup-kickoff"

/** `metadata.type` of the card's row: the replayed event and the web row key on it. */
export const SETUP_KICKOFF_TYPE = "setup-kickoff"

export interface SetupKickoffPayload {
  orgId: string
  /** The administrator whose sign-in found the workspace due. */
  userId: string
}

/** What the card's row carries in `metadata` (read by the web row). */
export interface SetupKickoffMetadata {
  type: typeof SETUP_KICKOFF_TYPE
  agentId: string
  state: SetupState
  /** The demo to offer, or null when the deployment turned the offer off. */
  demoUrl: string | null
  /** The key card, when the workspace has no model key the agent could use. */
  secretRequestId?: string
}

/** Unset: on, except under NODE_ENV=test (lib/env.ts). */
export function setupKickoffEnabled(): boolean {
  return env.LIAISON_SETUP_KICKOFF ?? env.NODE_ENV !== "test"
}

/**
 * The demo the card offers, or null when it is turned off. Never this very
 * deployment: a real workspace on the demo box would be sent to a door that
 * opens a second, throwaway workspace on the box it is already on.
 */
export function demoOfferUrl(): string | null {
  if (env.LIAISON_DEMO_URL === "off") return null
  if (sameHost(env.LIAISON_DEMO_URL, env.BASE_URL)) return null
  return env.LIAISON_DEMO_URL
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase()
  } catch {
    return false
  }
}

/**
 * Is a kickoff due in this workspace? Not a demo, created within
 * LIAISON_SETUP_KICKOFF_ORG_MAX_AGE_DAYS (an org that works on mail and tickets
 * alone writes no chat message, so "no message" alone would greet it as new),
 * nobody has written a message (imported messages carry an external reference
 * and do not count), and no kickoff card was posted. Reads rows only.
 */
export async function isSetupKickoffDue(orgId: string): Promise<boolean> {
  if (await isDemoOrgId(orgId)) return false
  const k = drizzleSql.raw(schemaRef("kernel"))
  const maxAgeDays = env.LIAISON_SETUP_KICKOFF_ORG_MAX_AGE_DAYS
  return withPrivilegedDb(orgId, "setup-kickoff-due", async (tx) => {
    // Cheapest first, each probe only when the one before passed: an
    // established or busy org answers on its creation date or its first message.
    const [org] = extractRows<{ fresh: boolean }>(
      await tx.execute(drizzleSql`
        SELECT created_at > now() - make_interval(days => ${maxAgeDays}::int) AS fresh
        FROM ${k}.organizations WHERE id = ${orgId}::uuid`),
    )
    if (!org?.fresh) return false
    const [written] = extractRows<{ yes: boolean }>(
      await tx.execute(drizzleSql`
        SELECT EXISTS (
          SELECT 1 FROM ${k}.messages
          WHERE org_id = ${orgId}::uuid AND author_type = 'user' AND external_ref IS NULL
        ) AS yes`),
    )
    if (written?.yes) return false
    const [posted] = extractRows<{ yes: boolean }>(
      await tx.execute(drizzleSql`
        SELECT EXISTS (
          SELECT 1 FROM ${k}.messages
          WHERE org_id = ${orgId}::uuid AND (metadata ->> 'type') = ${SETUP_KICKOFF_TYPE}
        ) AS yes`),
    )
    return !posted?.yes
  })
}

/** Workspaces this process found not due (or already kicked off): never probed again. */
const settledOrgs = new Set<string>()

async function enqueueSetupKickoff(payload: SetupKickoffPayload): Promise<void> {
  await enqueueAppJob("kernel", SETUP_KICKOFF_JOB, payload, {
    jobId: `${SETUP_KICKOFF_JOB}:${payload.orgId}`,
    // Once: the job posts a card and may start a paid turn.
    attempts: 1,
  })
}

const deps = { isDue: isSetupKickoffDue, enqueue: enqueueSetupKickoff }

export interface SetupKickoffSession {
  orgId: string
  userId: string
  /** The session holds an administrative scope. */
  admin: boolean
}

async function maybeStartSetupKickoff(session: SetupKickoffSession): Promise<void> {
  if (!session.admin || !setupKickoffEnabled()) return
  if (settledOrgs.has(session.orgId)) return
  if (!(await deps.isDue(session.orgId))) {
    settledOrgs.add(session.orgId)
    return
  }
  await deps.enqueue({ orgId: session.orgId, userId: session.userId })
  settledOrgs.add(session.orgId)
}

/**
 * Called by `createSession` for a full session (not a second-factor enrolment,
 * not a device-flow session): returns at once and never throws.
 */
export function startSetupKickoff(session: SetupKickoffSession): void {
  void Promise.resolve()
    .then(() => maybeStartSetupKickoff(session))
    .catch((err) => {
      log.error({ err, orgId: session.orgId }, "setup kickoff: the sign-in check failed")
    })
}

/** Open (or find) the admin's one conversation with their personal agent, pinned for them. */
export async function openSetupConversation(
  tx: Parameters<Parameters<typeof withRlsContext>[1]>[0],
  args: { orgId: string; userId: string; agentId: string },
): Promise<string> {
  const dm = await createOrGetAgentDm(tx, args)
  if (!dm) throw new Error(`setup kickoff: no conversation with agent ${args.agentId}`)
  // The person's own pin (user_thread_state), not the org-wide one: a thread
  // pinned for the whole org is workspace furniture, never a conversation.
  await updateThreadState(tx, {
    orgId: args.orgId,
    userId: args.userId,
    threadId: dm.id,
    isPinned: true,
  })
  return dm.id
}

function demoHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export interface SetupKickoffResult {
  posted: boolean
  threadId?: string
  messageId?: string
  turnStarted?: boolean
}

/**
 * The job: re-check under a per-workspace lock, post the card in the admin's
 * pinned agent conversation, then start the agent's first turn when it can
 * answer. Runs once per workspace whatever the number of sign-ins.
 */
export async function runSetupKickoff(payload: SetupKickoffPayload): Promise<SetupKickoffResult> {
  const { orgId, userId } = payload
  const prep = await withPrivilegedDb(orgId, "setup-kickoff-prepare", async (tx) => {
    const [person] = await tx
      .select({ locale: users.locale, status: users.status, name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    const [org] = await tx
      .select({ defaultLocale: organizations.defaultLocale })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1)
    return {
      active: person?.status === "active",
      name: person?.name?.trim() || "User",
      locale: resolveLocale(person?.locale, org?.defaultLocale),
      agentId: await getOrCreatePersonalAgentId(tx, { orgId, userId }),
      perms: await loadEffectivePermissions(tx, userId, orgId),
      settings: await getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
    }
  })
  if (!prep.active) return { posted: false }
  const actor: UserContext = {
    actorType: "user",
    userId,
    orgId,
    scopes: prep.perms.scopes,
    dimensionGrants: prep.perms.dimensionGrants,
  }
  const canAnswer = await hasUsableModelKey(orgId, prep.settings)
  const state = await computeSetupState(orgId)
  const demoUrl = demoOfferUrl()
  const { locale, agentId } = prep

  const posted = await withRlsContext(actor, async (tx) => {
    // Two sign-ins racing, or the job enqueued twice: the second waits here and
    // then finds the first one's card.
    await tx.execute(advisoryXactLock(`${SETUP_KICKOFF_JOB}:${orgId}`))
    if (!(await isSetupKickoffDue(orgId))) return null
    const threadId = await openSetupConversation(tx, { orgId, userId, agentId })
    const secretRequestId = canAnswer
      ? undefined
      : (
          await createSecretRequest(tx, {
            orgId,
            threadId,
            requestedBy: userId,
            agentId,
            target: { kind: "byok", provider: "openrouter" },
          })
        ).id
    const metadata: SetupKickoffMetadata = {
      type: SETUP_KICKOFF_TYPE,
      agentId,
      state,
      demoUrl,
      ...(secretRequestId ? { secretRequestId } : {}),
    }
    const lines = [
      serverT(locale, "first-run.kickoff.title"),
      serverT(locale, "first-run.kickoff.intro"),
      ...(secretRequestId ? [serverT(locale, "first-run.kickoff.keyFirst")] : []),
      ...(demoUrl
        ? [
            `${serverT(locale, "first-run.kickoff.demoTitle")} ${serverT(locale, "first-run.kickoff.demoBody", { host: demoHost(demoUrl) })} ${demoUrl}`,
          ]
        : []),
    ]
    const message = await sendMessage(tx, {
      requiredScopes: [],
      orgId,
      userId,
      threadId,
      content: lines.join("\n\n"),
      // Posted by the admin's agent under its "{name}'s agent" identity (never
      // as the admin), so the conversation reads unread and leads them to it.
      authorType: "agent",
      agentId,
      agentAuthorLabel: `${prep.name}'s agent`,
      metadata,
    })
    if (!message) throw new Error("setup kickoff: the admin is not in their own agent conversation")
    return { threadId, messageId: message.id }
  })
  if (!posted) return { posted: false }
  log.info({ orgId, threadId: posted.threadId }, "setup kickoff posted")
  if (!canAnswer) return { posted: true, ...posted, turnStarted: false }

  const { invokeAgentForThread } = await import("~/modules/agent/runtime/agent-service")
  await invokeAgentForThread(
    posted.threadId,
    posted.messageId,
    {
      userId,
      orgId,
      scopes: prep.perms.scopes,
      dimensionGrants: prep.perms.dimensionGrants,
    },
    orgId,
    true, // background: a job-driven turn, nobody typed
    undefined, // budget: default
    undefined, // routineId: not a routine tick
    undefined, // seedDiscoveredTools: lean start
    false, // anchorHistory: the agent reads its conversation
    agentId,
  )
  return { posted: true, ...posted, turnStarted: true }
}

/** Test seams: swap the probe or the enqueue, and forget what this process settled. */
export const SetupKickoffTestAccess = {
  deps,
  settledOrgs,
  maybeStartSetupKickoff,
  reset(): void {
    settledOrgs.clear()
    deps.isDue = isSetupKickoffDue
    deps.enqueue = enqueueSetupKickoff
  },
}
