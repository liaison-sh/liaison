// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `setup_state`: what is left to set up in this workspace, as the agent reads
// it. The checklist is derived from rows (provisioning/setup-state.ts) and
// never rides in the system prompt; the agent asks for it when the setup
// conversation needs it, and the result's hint sends it to the setup-guide
// skill. Any member may read it; `canConfigure` says whether this person can
// act on it (an administrator), so the agent proposes steps only to them.
import { z } from "zod"
import { withPrivilegedDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { toolRegistry } from "~/modules/apps/app-registries"
import { holdsAdminScope } from "~/modules/auth/admin-second-factor"
import { type ServerSurfaceId, serverSetup } from "~/modules/connection-guides/server-setup"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import {
  type ConnectionNextStep,
  computeSetupState,
  type SetupState,
} from "~/modules/provisioning/setup-state"
import { usesGoogleIntegrationClient } from "~/modules/secret-requests/targets"

/** The kernel-tool ctx fields this handler reads. */
interface SetupStateCtx {
  orgId: string
  userId: string
}

export type SetupStateResult = SetupState & {
  canConfigure: boolean
  /** What to do next, in words: an unfinished connection the person may have
   *  asked for comes before the checklist's next item. */
  nextAction: string
  /** What the person who runs the server sets up (connection-guides/server-setup.ts),
   *  the same list `liaison guide server` prints with its steps. Not changeable
   *  from a workspace. `done` null: the server cannot see it (backups). */
  server: Array<{ id: ServerSurfaceId; title: string; optional: boolean; done: boolean | null }>
}

/**
 * The exact call that carries one OAuth connection forward, from its next
 * step. Named, so a weak model continues the connection it was asked for
 * instead of moving on to the checklist's next item.
 */
export function connectionSetupCall(
  app: string,
  connection: string,
  next: ConnectionNextStep,
  /** `turn_on`: what turns the switched-off connection on (setup-state.ts). */
  turnOn?: string,
): string {
  const connectCard = `post its Connect card (kernel__request_secret kind oauth_connect, app ${app}, connection ${connection})`
  if (next === "connected") return "nothing: it is connected"
  if (next === "consent_card") return connectCard
  // Switched off for the workspace (Gmail mailboxes off): its Connect card is
  // refused until it is on, so turning it on comes first.
  if (next === "turn_on") {
    return `turn it on first, it is switched off for the workspace: ${turnOn ?? "an admin turns it on in the app's settings"}`
  }
  if (app === "shopify" && connection === "shop") {
    return "read the shopify-setup skill and call kernel__shopify_app_toml"
  }
  if (usesGoogleIntegrationClient(app, connection) || app === "google-drive") {
    return "call kernel__google_setup and walk its guide"
  }
  return `ask for its OAuth client (kernel__request_secret kind oauth_client, app ${app}, connection ${connection}), then ${connectCard}`
}

/** The next action: what is left of the features the person chose (connections
 *  first, when the person asked for them), then the checklist; the rest is a menu. */
export function setupNextAction(state: SetupState): string {
  const plan = state.features
  const wanted = new Set(plan.left.flatMap((s) => (s.unavailable ? [] : s.refs)))
  const oauth = new Set(state.connections.map((c) => `${c.app}/${c.connection}`))
  const open = state.connections.filter(
    (c) => !c.connected && wanted.has(`${c.app}/${c.connection}`),
  )
  const ask =
    plan.chosen === null
      ? `First ask which features the person wants (the basics are a fine answer) and record the answer with kernel__config_setup { setup: { features: [...] } }; until then only the basics (${plan.counted.join(", ")}) count as left. `
      : ""
  const others = plan.left.filter(
    (s) => s.item || s.unavailable || !s.refs.some((r) => oauth.has(r)),
  )
  const otherText = others.length
    ? ` Also left of what they chose: ${others
        .map((s) =>
          s.item
            ? `${s.feature} (the ${s.item} checklist item)`
            : s.unavailable
              ? `${s.feature} (its app is off: turn it on first with kernel__config_apps)`
              : `${s.feature} (connect ${s.refs.join(" or ")}${s.done ? `; already connected: ${s.done.join(", ")}` : ""})`,
        )
        .join("; ")}.`
    : ""
  // A chosen feature partly done says what is done, so it never reads as untouched.
  const partial = new Map<string, string[]>()
  for (const s of plan.left) if (s.done) partial.set(s.feature, s.done)
  const partialText = partial.size
    ? ` Partly done already: ${[...partial].map(([f, d]) => `${f} (${d.join(", ")} connected)`).join("; ")}.`
    : ""
  const menu = plan.menu.length
    ? ` Everything else is a menu, offered only when the person asks what else they can add, each with its time and never as a to-do: ${plan.menu
        .map(
          (m) =>
            `${m.label}${m.done ? ` (partly done: ${m.done.join(", ")} connected; left: ${(m.open ?? []).map((refs) => refs.join(" or ")).join("; ")})` : ""}${m.minutes ? ` (${m.minutes[0]} to ${m.minutes[1]} min)` : ""}`,
        )
        .join("; ")}.`
    : ""
  // The two opt-ins are asked once, after the basics, and any answer ends it.
  const team = state.items.some((i) => i.key === "liaisonTeam" && !i.done)
    ? state.next
      ? " The liaisonTeam item (sharing with the Liaison team) is asked only after the basics, once, never as a blocker."
      : " Ask the liaisonTeam item now, once, as the setup guide says (two yes/no questions, default no), then record the answer with kernel__config_liaisonTeam: either answer closes it."
    : ""
  const checklist = state.next
    ? `the checklist's next item (${state.next})`
    : "anything else (every required item is done)"
  if (open.length === 0) {
    const base = state.next ? `Next checklist item: ${state.next}.` : "Every required item is done."
    return `${ask}${base}${partialText}${otherText}${team}${menu}`
  }
  const list = open
    .map(
      (c) =>
        `${c.app}/${c.connection}: ${connectionSetupCall(c.app, c.connection, c.next, c.turnOn)}`,
    )
    .join("; ")
  return `${ask}Chosen but not connected yet: ${list}. If the person asked for one of these in this conversation, finish connecting that one first, before ${checklist}: never drop a goal the person named. The others wait until the person asks for them: never propose or set one up on your own (a ticket inbox, another mailbox), and never make up an address for one. A Connect or secret card is posted only for a connection the person asked for: when they asked for something else (an app already on, another setting), answer that, and at most ask whether they also want to connect one, as a question, never as a card.${partialText}${otherText}${team}${menu}`
}

export async function handleSetupState(
  _params: unknown,
  ctx: SetupStateCtx,
): Promise<SetupStateResult> {
  // The person's own granted scopes, not the turn's: whether they can set the
  // workspace up is a fact about them.
  const perms = await withPrivilegedDb(ctx.orgId, "setup-state-tool-perms", (tx) =>
    loadEffectivePermissions(tx, ctx.userId, ctx.orgId),
  )
  const state = await computeSetupState(ctx.orgId)
  return {
    ...state,
    canConfigure: holdsAdminScope(ctx.orgId, perms.scopes),
    nextAction: setupNextAction(state),
    server: serverSetup(env).map(({ id, title, optional, done }) => ({
      id,
      title,
      optional,
      done,
    })),
  }
}

export function registerSetupStateTool(orgId: string): void {
  toolRegistry.set([orgId, "kernel", "setup_state"], {
    appName: "kernel",
    name: "setup_state",
    deferLoading: true,
    description:
      "What is set up in this workspace and what is left of the features the person chose (setup.features), with the other features as a menu with times; read from the workspace itself.",
    // Org-level facts with no names in them: any member may read them.
    requiredScopes: ["kernel:threads:read"],
    readOnly: true,
    params: z.object({}),
    handler: handleSetupState,
  })
}
