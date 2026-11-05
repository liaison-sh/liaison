// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Agents app registration — surfaces the `Agents` entry in the activity bar,
 * registers one page per agent at `/agents/:handle`. `/agents` itself is not a
 * screen: the sidebar IS the roster, so the bare path redirects to the
 * viewer's own agent (`legacyRedirectFor` in the shell).
 *
 * THERE ARE NO OTHER AGENT TAB TYPES (P4c-T39). The flat `/agent/skills`,
 * `/agent/routines`, `/agent/memories` screens and their detail tabs, plus
 * `/agent/profile/:id`, were one surface per artifact with no agent named on
 * them; they are tabs of an agent's page now. The shipped links still work:
 * `legacyRedirectFor()` in the shell rewrites every one of them.
 *
 * The agent app is NOT a chat surface: conversation lives in the chat dock and
 * the thread view. Legacy `/agent/chat/:id` links redirect to the thread.
 *
 * Stays a pure registration module: the only side effects are calls into the
 * framework registry. Domain stores are imported only as WS handler bindings
 * (T6.1 / T6.2 exports `onSkillUpdated`, `onRoutineStatus`,
 * `onRoutineRunCompleted`).
 */
import { type Component, lazy } from "solid-js"
import { registerApp } from "~/framework/define-app"
import { registerTabEntityAlias } from "~/modules/shell/tab-store"
import {
  AGENT_PAGE_TAB_TYPE,
  agentPageLabel,
  canonicalAgentPageEntityId,
} from "~/modules/threads/agent-directory"
import { AgentGlyph } from "~/ui/AgentGlyph"
import { onRoutineRunCompleted, onRoutineStatus } from "./routines-store"
import { onSkillUpdated } from "./skills-store"

const AgentSidebar = lazy(() => import("./AgentSidebar"))
const AgentPage = lazy(() => import("./AgentPage"))

/** The activity bar draws its icons at a fixed pixel size; the glyph sizes
 *  with its font, so the entry sets that size on the element itself. */
const AgentsIcon: Component<{ size?: number }> = () => AgentGlyph({ class: "text-[18px]" })

/** A tab opened from a URL carries only the handle: name it from the org's
 *  agent listing once that has loaded, and fall back to the handle itself.
 *  On a COLD deep load the listing has not arrived yet and this answers
 *  undefined; `loadAgentDirectory` re-labels the open tabs when it resolves
 *  (P4c FX-F3), so the generic "Agent" is a flash and not the final word. */
function resolveAgentLabel(entityId: string): string | undefined {
  return agentPageLabel(entityId)
}

export function registerAgentApp(): void {
  // ONE AGENT, ONE TAB. The page answers to `self` and to the personal
  // agent's handle; a legacy link written before the directory loaded carries
  // the first spelling and every other surface carries the second. The tab
  // store collapses them onto one instance rather than opening the same agent
  // twice (P4c FX-F3).
  registerTabEntityAlias(AGENT_PAGE_TAB_TYPE, canonicalAgentPageEntityId)

  registerApp({
    name: "agents",
    activityBar: {
      icon: AgentsIcon,
      label: "Agents",
      labelKey: "kernel.nav.agents",
      order: 900,
      position: "bottom",
      // THE APP OPENS ON AN AGENT, NEVER ON A LIST OF AGENTS. The sidebar is
      // already the roster, so a directory screen repeated it beside itself;
      // `self` is the viewer's own agent and the tab store re-keys it onto that
      // agent's handle the moment the directory can name it.
      tabAction: { type: "agent", entityId: "self", label: "Agents" },
    },
    tabTypes: {
      agent: {
        component: AgentPage as any,
        sidebar: AgentSidebar as any,
        icon: AgentsIcon,
        // `:entityId` is the agent's HANDLE, the way a person names an agent.
        urlPattern: "/agents/:entityId",
        defaultLabel: "Agent",
        defaultLabelKey: "kernel.nav.agent",
        resolveLabel: resolveAgentLabel,
        // P4c-T35: the page's tabs are sub routes (`/agents/:handle/skills`),
        // so the tab store must keep the deeper path instead of rewriting the
        // URL back to the base on every sync, exactly as Settings does.
        preserveSubRoutes: true,
        referenceable: false,
      },
    },
    // Server-side events are dispatched on the `kernel:<entity>` key with the
    // raw `action` (see `apps/api/.../routine-worker.ts` → `broadcastEphemeral`).
    // The agent app uses `__explicitKey: "kernel:<entity>"` since the events
    // are owned by the kernel namespace, not the "agent" app name.
    wsHandlers: {
      skill: {
        __explicitKey: "kernel:skill",
        handler: ((action: string, data: any) => {
          if (action === "updated") {
            onSkillUpdated({ type: "skill:updated", ...(data ?? {}) })
          }
        }) as any,
      },
      routine: {
        __explicitKey: "kernel:routine",
        handler: ((action: string, data: any) => {
          if (action === "status") {
            onRoutineStatus({ type: "routine:status", ...(data ?? {}) })
          } else if (action === "run_completed") {
            onRoutineRunCompleted({ type: "routine:run_completed", ...(data ?? {}) })
          }
        }) as any,
      },
    } as any,
  })
}
