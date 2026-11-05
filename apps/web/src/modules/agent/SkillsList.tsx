// SPDX-License-Identifier: FSL-1.1-ALv2
import { Sparkles } from "lucide-solid"
import { type Component, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { namespaceRegistryKey } from "~/framework/app-registry"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"
import Chip from "./Chip"
import {
  loadSkills,
  type SkillRow,
  skillsForAgent,
  skillsStore,
  toggleAppSkill,
} from "./skills-store"

type SubTab = "built-in" | "org" | "personal"

/**
 * P4c-T36: the same list, filtered to ONE agent, is the agent page's Skills
 * tab. `ownerAgentId` switches the question from "what can I see" (deduped
 * across built-in, org and personal) to "what does this agent own", so the
 * provenance sub-tabs go away: every row has the same provenance.
 */
interface Props {
  /** Filter to the skills this agent owns, and read the per-agent cache. */
  ownerAgentId?: string
  /** Render the `New skill` action. The page's authority decides, never this
   *  component: there is no row yet to carry a `canWrite`. */
  canCreate?: boolean
  /** Handle a row click in place (the agent tab's master/detail) instead of
   *  opening the flat screen's own tab. */
  onSelect?: (skill: SkillRow) => void
  /** Handle `New skill` in place. */
  onNew?: () => void
  /** The row the master/detail pane is showing, so the list marks it. */
  selectedId?: string | null
}

/** Open the skill create surface as a tab (never a modal). */
function openCreateSkill(label: string) {
  openTab({
    type: namespaceRegistryKey("agents", "skill"),
    entityId: "new",
    label,
  })
}

const SkillsList: Component<Props> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [tab, setTab] = createSignal<SubTab>("personal")

  const scoped = () => props.ownerAgentId

  onMount(() => {
    const owner = scoped()
    void loadSkills(api as any, owner ? { ownerAgentId: owner } : undefined)
  })

  /** The flat screen hides its own New action from nobody; the agent tab
   *  renders it only when the page says this viewer may author for the agent. */
  const showNew = () => (scoped() ? props.canCreate === true : true)

  function onNew() {
    if (props.onNew) props.onNew()
    else openCreateSkill(i18n.t("kernel.agentUi.newSkillTab"))
  }

  const rows = createMemo<SkillRow[]>(() => {
    const owner = scoped()
    if (owner) return skillsForAgent(owner)
    const t = tab()
    return skillsStore.skills.filter((s) => {
      if (t === "built-in") return s.source === "app"
      if (t === "org") return s.source === "org"
      return s.source === "personal"
    })
  })

  // Built-in (app-shipped) skills grouped by owning app, for the provenance
  // grouping + per-skill enable/disable toggle (Component A §3.6 UI).
  const appGroups = createMemo<Array<{ appName: string; skills: SkillRow[] }>>(() => {
    const byApp = new Map<string, SkillRow[]>()
    for (const s of rows()) {
      if (s.source !== "app") continue
      const app = s.appName ?? "unknown"
      const list = byApp.get(app) ?? []
      list.push(s)
      byApp.set(app, list)
    }
    return Array.from(byApp.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([appName, skills]) => ({ appName, skills }))
  })

  /** THE AGENT-SCOPED LIST IS GROUPED BY PROVENANCE, when there is more than
   *  one provenance to tell apart: the skills the agent was shipped with read
   *  differently from the ones somebody wrote for it. One group draws no
   *  header, because a header over the whole list says nothing. */
  type ListItem = { header: string; id: string } | { skill: SkillRow }
  const listItems = createMemo<ListItem[]>(() => {
    const all = rows()
    if (!scoped()) return all.map((skill) => ({ skill }))
    const app = all.filter((s) => s.source === "app")
    const own = all.filter((s) => s.source !== "app")
    const groups = [
      { id: "agent", label: i18n.t("kernel.agents.groupAgentSkills"), skills: own },
      { id: "app", label: i18n.t("kernel.agents.groupAppSkills"), skills: app },
    ].filter((g) => g.skills.length > 0)
    if (groups.length < 2) return all.map((skill) => ({ skill }))
    return groups.flatMap<ListItem>((g) => [
      { header: g.label, id: g.id },
      ...g.skills.map((skill) => ({ skill })),
    ])
  })

  async function onToggle(skill: SkillRow) {
    if (!skill.appName) return
    try {
      await toggleAppSkill(api as never, skill.appName, skill.name, "user")
    } catch {
      // optimistic revert handled in the store; swallow here
    }
  }

  function openDetail(skill: SkillRow) {
    if (props.onSelect) {
      props.onSelect(skill)
      return
    }
    const entityId =
      skill.source === "app" && skill.appName
        ? `built-in/${skill.appName}/${skill.name}`
        : encodeURIComponent(skill.name)
    openTab({
      type: namespaceRegistryKey("agents", "skill"),
      entityId,
      label: skill.name,
    })
  }

  return (
    <div data-testid="skills-list" class="flex h-full flex-col">
      {/* Header */}
      <div class="flex items-center justify-between border-b border-border-subtle px-4 py-3">
        <h1 class="text-[15px] font-medium text-text">{i18n.t("kernel.agents.skillsTitle")}</h1>
        <Show when={showNew()}>
          <button
            type="button"
            data-testid="skills-new-skill"
            class="rounded-md border border-border-subtle bg-surface px-3 py-1 text-[12px] text-text-secondary hover:bg-surface-hover"
            onClick={onNew}
          >
            {scoped() ? i18n.t("kernel.agents.newSkill") : i18n.t("kernel.agents.newSkillPlus")}
          </button>
        </Show>
      </div>

      {/* Sub-tabs: provenance only, so an agent-scoped list has none. */}
      <Show when={!scoped()}>
        <div
          data-testid="skills-subtabs"
          class="flex items-center gap-1 border-b border-border-subtle px-4 py-1"
        >
          <For
            each={[
              { id: "built-in" as const, label: i18n.t("kernel.agents.filterBuiltIn") },
              { id: "org" as const, label: i18n.t("kernel.agents.filterOrg") },
              { id: "personal" as const, label: i18n.t("kernel.agents.filterPersonal") },
            ]}
          >
            {(item) => (
              <button
                type="button"
                data-testid={`skills-subtab-${item.id}`}
                onClick={() => setTab(item.id)}
                class={`px-3 py-1.5 text-[12px] outline-none transition-colors ${
                  tab() === item.id
                    ? "border-b-2 border-accent text-text"
                    : "border-b-2 border-transparent text-text-tertiary hover:text-text-secondary"
                }`}
              >
                {item.label}
              </button>
            )}
          </For>
        </div>
      </Show>

      {/* Rows */}
      <div class="min-h-0 flex-1 overflow-auto">
        <Show
          when={rows().length > 0}
          fallback={
            <div
              data-testid="skills-empty-state"
              class="flex flex-col items-center gap-2 px-6 py-12 text-center text-text-tertiary"
            >
              <Sparkles size={20} class="text-text-tertiary" />
              <p class="text-[13px]">
                {scoped()
                  ? i18n.t("kernel.agents.skillsEmpty")
                  : i18n.t("kernel.agents.skillsFlatEmpty")}
              </p>
              <Show when={showNew()}>
                <button
                  type="button"
                  data-testid="skills-empty-cta"
                  class="text-[12px] text-accent underline"
                  onClick={onNew}
                >
                  {scoped()
                    ? i18n.t("kernel.agents.newSkill")
                    : i18n.t("kernel.agents.createFirstSkill")}
                </button>
              </Show>
            </div>
          }
        >
          <Show
            when={tab() === "built-in"}
            fallback={
              <For each={listItems()}>
                {(item) =>
                  "header" in item ? (
                    <div
                      data-testid={`skills-group-${item.id}`}
                      class="border-b border-border-subtle bg-surface px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-text-tertiary"
                    >
                      {item.header}
                    </div>
                  ) : (
                    <button
                      type="button"
                      data-testid={`skill-row-${item.skill.name}`}
                      aria-current={props.selectedId === item.skill.id ? "true" : undefined}
                      onClick={() => openDetail(item.skill)}
                      class="flex w-full items-start gap-3 border-b border-border-subtle px-4 py-3 text-left transition-colors hover:bg-surface-hover"
                      classList={{ "bg-surface-active": props.selectedId === item.skill.id }}
                    >
                      <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2">
                          <span class="text-[13px] font-medium text-text">{item.skill.name}</span>
                          <Chip data-testid={`skill-source-chip-${item.skill.source}`}>
                            {item.skill.source}
                          </Chip>
                          <Show when={item.skill.createdByActorType === "agent"}>
                            <Chip tone="accent" data-testid="agent-origin-badge">
                              {i18n.t("kernel.agentUi.agent")}
                            </Chip>
                          </Show>
                          <Show
                            when={item.skill.domain}
                            fallback={
                              <span
                                data-testid={`skill-domain-${item.skill.name}`}
                                class="text-[11px] text-text-tertiary/70"
                              >
                                {i18n.t("kernel.agentUi.general")}
                              </span>
                            }
                          >
                            {(d) => (
                              <Chip tone="accent" data-testid={`skill-domain-${item.skill.name}`}>
                                {d()}
                              </Chip>
                            )}
                          </Show>
                        </div>
                        <p class="mt-0.5 truncate text-[12px] text-text-tertiary">
                          {item.skill.description}
                        </p>
                      </div>
                    </button>
                  )
                }
              </For>
            }
          >
            {/* Built-in tab: group app-shipped skills by app + per-skill toggle */}
            <For each={appGroups()}>
              {(group) => (
                <div data-testid={`app-skill-group-${group.appName}`}>
                  <div class="border-b border-border-subtle bg-surface px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
                    {group.appName}
                  </div>
                  <For each={group.skills}>
                    {(skill) => (
                      <div class="flex items-center gap-3 border-b border-border-subtle px-4 py-3 transition-colors hover:bg-surface-hover">
                        <button
                          type="button"
                          data-testid={`skill-row-${skill.name}`}
                          onClick={() => openDetail(skill)}
                          class="min-w-0 flex-1 text-left"
                        >
                          <span class="text-[13px] font-medium text-text">{skill.name}</span>
                          <p class="mt-0.5 truncate text-[12px] text-text-tertiary">
                            {skill.description}
                          </p>
                        </button>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={skill.disabled ? "false" : "true"}
                          data-testid={`app-skill-toggle-${group.appName}-${skill.name}`}
                          onClick={() => void onToggle(skill)}
                          class={`shrink-0 rounded-md border px-2 py-1 text-[11px] transition-colors ${
                            skill.disabled
                              ? "border-border-subtle bg-surface text-text-tertiary hover:bg-surface-hover"
                              : "border-accent bg-accent-glow text-accent"
                          }`}
                        >
                          {skill.disabled
                            ? i18n.t("kernel.agents.off")
                            : i18n.t("kernel.agents.on")}
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  )
}

export default SkillsList
