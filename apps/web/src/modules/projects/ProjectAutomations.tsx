// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A project's Automations, as a tab (never a modal): the routines whose event
 * filter names this project (on/off, last run, open), and "New automation",
 * which offers the projects app's flow templates. Choosing one opens the flow
 * editor (FlowList) prefilled for this project, its statuses resolved; saving
 * creates the routine through the routines create path, so the routine
 * approval rules apply as for any other routine.
 */
import type { RoutineFlow } from "@liaison/shared"
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { formatDateTime } from "~/lib/relative-time"
import FlowList from "~/modules/agent/flow/FlowList"
import { loadFlowPeople, loadFlowProject } from "~/modules/agent/flow/flow-data"
import {
  describeTrigger,
  type FlowEventFilter,
  fillTemplate,
  flowProblem,
} from "~/modules/agent/flow/flow-model"
import { openRoutineOnAgentPage } from "~/modules/agent/open-routine"
import { runStatusLabel } from "~/modules/agent/routine-status-copy"
import {
  createRoutine,
  loadProjectRoutines,
  type RoutineRow,
  type RoutineTemplateRow,
  routineLabel,
  updateRoutine,
} from "~/modules/agent/routines-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { Switch } from "~/ui/Switch"

const fieldClass =
  "w-full min-w-0 rounded-md border border-border-subtle bg-surface-elevated px-2 py-1.5 text-[13px] text-text"

interface Draft {
  templateKey: string
  /** The routine's identifier, made from the template and project (never shown). */
  name: string
  /** Its human name, prefilled "<template> · <project>" and editable. */
  title: string
  description: string
  event: string
  prompt: string
  scopes: string[]
  flow: RoutineFlow
  eventFilter: FlowEventFilter | null
  missing: string[]
}

const TITLE_MAX = 120

/**
 * A routine identifier (kebab-case, at most 60) from a template key and the project, with a
 * short time suffix so the same template set up twice does not collide.
 */
function draftName(templateKey: string, projectName: string): string {
  const slug = `${templateKey}-${projectName}`
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  const suffix = Date.now().toString(36).slice(-5)
  const base = slug.slice(0, 60 - suffix.length - 1).replace(/-+$/g, "") || templateKey
  return `${base}-${suffix}`
}

export const ProjectAutomations: Component<{ entityId: string }> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const projectId = () => props.entityId

  const [project] = createResource(projectId, (id) => loadFlowProject(api, id))
  const [people] = createResource(() => loadFlowPeople(api))
  const [routines, { refetch: refetchRoutines, mutate: setRoutines }] = createResource(
    projectId,
    (id) => loadProjectRoutines(api, id),
  )
  const [templates] = createResource(async () => {
    try {
      const rows = (await api.get<RoutineTemplateRow[]>("/agent/routines/templates")) ?? []
      return rows.filter((t) => t.appName === "projects" && t.flow)
    } catch {
      return []
    }
  })

  const [mode, setMode] = createSignal<"list" | "templates" | "edit">("list")
  const [draft, setDraft] = createSignal<Draft | null>(null)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const templateTitle = (templateKey: string) =>
    i18n.t(`projects.automations.template_${templateKey.replace(/-/g, "_")}`)

  const names = () => ({
    project: project() ?? null,
    people: people() ?? [],
    t: i18n.t,
    locale: i18n.locale(),
  })

  function chooseTemplate(t: RoutineTemplateRow) {
    const p = project()
    if (!p || !t.flow || !t.event) return
    const filled = fillTemplate(
      { flow: t.flow, eventFilter: (t.eventFilter ?? null) as FlowEventFilter | null },
      p,
    )
    setDraft({
      templateKey: t.templateKey,
      name: draftName(t.templateKey, p.name),
      title: `${templateTitle(t.templateKey)} · ${p.name}`.slice(0, TITLE_MAX),
      description: t.description,
      event: t.event,
      prompt: t.prompt ?? t.description,
      scopes: t.scopes ?? [],
      flow: filled.value.flow,
      eventFilter: filled.value.eventFilter,
      missing: filled.missing,
    })
    setError(null)
    setMode("edit")
  }

  const problem = () => {
    const d = draft()
    if (!d) return null
    if (!d.title.trim()) return i18n.t("projects.automations.nameRequired")
    if (!d.description.trim()) return i18n.t("projects.automations.descriptionRequired")
    return flowProblem(i18n.t, d.flow, d.event, d.eventFilter)
  }

  async function save() {
    const d = draft()
    if (!d || problem()) return
    setSaving(true)
    setError(null)
    try {
      await createRoutine(api, {
        name: d.name,
        title: d.title.trim(),
        description: d.description.trim().slice(0, 200),
        kind: "event",
        event: d.event,
        prompt: d.prompt,
        scopes: d.scopes,
        enabled: true,
        eventFilter: d.eventFilter,
        flow: d.flow,
      })
      setDraft(null)
      setMode("list")
      await refetchRoutines()
    } catch (err) {
      setError(err instanceof Error ? err.message : i18n.t("projects.automations.saveFailed"))
    } finally {
      setSaving(false)
    }
  }

  async function toggle(r: RoutineRow, enabled: boolean) {
    setRoutines((prev) => prev?.map((x) => (x.id === r.id ? { ...x, enabled } : x)))
    try {
      await updateRoutine(api, r.id, { enabled })
    } catch {
      setRoutines((prev) => prev?.map((x) => (x.id === r.id ? { ...x, enabled: r.enabled } : x)))
    }
  }

  /** A routine lives on its owner agent's page, Routines tab, opened on it. */
  const open = (r: RoutineRow) => openRoutineOnAgentPage(r)

  return (
    <div data-testid="project-automations" class="flex h-full min-w-0 flex-col">
      <header class="flex min-w-0 flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-3">
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-[15px] font-medium text-text">
            {i18n.t("projects.automations.title")}
          </h1>
          <Show when={project()}>
            {(p) => (
              <p
                data-testid="project-automations.project"
                class="truncate text-[12px] text-text-tertiary"
              >
                {p().name}
              </p>
            )}
          </Show>
        </div>
        <Show when={mode() === "list"}>
          <Button variant="primary" size="sm" onClick={() => setMode("templates")}>
            <span data-testid="project-automations.new">{i18n.t("projects.automations.new")}</span>
          </Button>
        </Show>
        <Show when={mode() !== "list"}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(null)
              setMode("list")
            }}
          >
            <span data-testid="project-automations.back">
              {i18n.t("projects.automations.back")}
            </span>
          </Button>
        </Show>
      </header>

      <div class="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-3 pb-dock-runway">
        {/* The list */}
        <Show when={mode() === "list"}>
          <p
            data-testid="project-automations.explainer"
            class="mb-3 text-[12px] text-text-tertiary"
          >
            {i18n.t("projects.automations.explainer")}
          </p>
          <Show when={routines.error}>
            <p data-testid="project-automations.load-failed" class="text-[12px] text-amber-500">
              {i18n.t("projects.automations.loadFailed")}
            </p>
          </Show>
          <ul data-testid="project-automations.list" class="flex min-w-0 flex-col gap-2">
            <For
              each={routines() ?? []}
              fallback={
                <Show when={!routines.loading && !routines.error}>
                  <li
                    data-testid="project-automations.empty"
                    class="text-[13px] text-text-secondary"
                  >
                    {i18n.t("projects.automations.empty")}
                  </li>
                </Show>
              }
            >
              {(r) => (
                <li
                  data-testid={`project-automations.row-${r.id}`}
                  class="flex min-w-0 flex-col gap-1 rounded-md border border-border-subtle bg-surface px-3 py-2"
                >
                  <div class="flex min-w-0 items-center gap-2">
                    <button
                      type="button"
                      data-testid={`project-automations.open-${r.id}`}
                      class="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-text hover:underline"
                      onClick={() => open(r)}
                    >
                      {routineLabel(r)}
                    </button>
                    <Switch
                      checked={r.enabled}
                      onChange={(v) => void toggle(r, v)}
                      label={i18n.t("projects.automations.enabled")}
                      disabled={r.canWrite === false}
                      data-testid={`project-automations.toggle-${r.id}`}
                    />
                  </div>
                  <p class="break-words text-[12px] text-text-secondary">
                    {describeTrigger(
                      names(),
                      r.event,
                      (r.eventFilter ?? null) as FlowEventFilter | null,
                      r.description,
                    )}
                  </p>
                  <p
                    data-testid={`project-automations.last-run-${r.id}`}
                    class="text-[11px] text-text-tertiary"
                  >
                    {r.lastRunAt
                      ? i18n.t("projects.automations.lastRun", {
                          when: formatDateTime(r.lastRunAt, i18n.locale()),
                          status: runStatusLabel(i18n.t, r.lastRunStatus ?? ""),
                        })
                      : i18n.t("projects.automations.neverRan")}
                  </p>
                </li>
              )}
            </For>
          </ul>
        </Show>

        {/* Templates */}
        <Show when={mode() === "templates"}>
          <p class="mb-3 text-[12px] text-text-tertiary">
            {i18n.t("projects.automations.pickTemplate")}
          </p>
          <ul
            data-testid="project-automations.templates"
            class="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2"
          >
            <For
              each={templates() ?? []}
              fallback={
                <li class="text-[13px] text-text-secondary">
                  {i18n.t("projects.automations.noTemplates")}
                </li>
              }
            >
              {(t) => (
                <li class="min-w-0">
                  <button
                    type="button"
                    data-testid={`project-automations.template-${t.templateKey}`}
                    disabled={!project()}
                    onClick={() => chooseTemplate(t)}
                    class="flex h-full w-full min-w-0 flex-col gap-1 rounded-md border border-border-subtle bg-surface px-3 py-2 text-left hover:bg-surface-hover disabled:opacity-50"
                  >
                    <span class="text-[13px] font-medium text-text">
                      {templateTitle(t.templateKey)}
                    </span>
                    <span class="break-words text-[12px] text-text-secondary">{t.description}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>

        {/* Editor */}
        <Show when={mode() === "edit" ? draft() : null}>
          {(d) => (
            <div data-testid="project-automations.editor" class="flex min-w-0 flex-col gap-3">
              <label class="flex min-w-0 flex-col gap-1">
                <span class="text-[12px] font-medium text-text-secondary">
                  {i18n.t("projects.automations.name")}
                </span>
                <input
                  data-testid="project-automations.name"
                  class={fieldClass}
                  maxLength={TITLE_MAX}
                  value={d().title}
                  onInput={(e) => setDraft({ ...d(), title: e.currentTarget.value })}
                />
              </label>
              <label class="flex min-w-0 flex-col gap-1">
                <span class="text-[12px] font-medium text-text-secondary">
                  {i18n.t("projects.automations.description")}
                </span>
                <input
                  data-testid="project-automations.description"
                  class={fieldClass}
                  maxLength={200}
                  value={d().description}
                  onInput={(e) => setDraft({ ...d(), description: e.currentTarget.value })}
                />
              </label>
              <Show when={d().missing.length > 0}>
                <p
                  data-testid="project-automations.missing"
                  class="text-[12px] text-text-secondary"
                >
                  {i18n.t("projects.automations.missingStatuses", {
                    labels: d().missing.join(", "),
                  })}
                </p>
              </Show>
              <FlowList
                flow={d().flow}
                event={d().event}
                eventFilter={d().eventFilter}
                project={project() ?? null}
                people={people() ?? []}
                mode="edit"
                onChange={(flow) => setDraft({ ...d(), flow })}
                onFilterChange={(eventFilter) => setDraft({ ...d(), eventFilter })}
              />
              <Show when={problem() ?? error()}>
                {(msg) => (
                  <p data-testid="project-automations.problem" class="text-[12px] text-amber-500">
                    {msg()}
                  </p>
                )}
              </Show>
              <div class="flex flex-wrap justify-end gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={saving() || !!problem()}
                  onClick={() => void save()}
                >
                  <span data-testid="project-automations.save">
                    {i18n.t("projects.automations.save")}
                  </span>
                </Button>
              </div>
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}

export default ProjectAutomations
