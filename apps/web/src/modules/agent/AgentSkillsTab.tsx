// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * P4c-T36: the agent page's Skills tab.
 *
 * IT IS THE EXISTING VIEWS, FILTERED. `SkillsList` and `SkillDetail` are the
 * same components the flat `/agent/skills` screen mounts; the only difference
 * is an `ownerAgentId`, which switches the question from "what can I see" to
 * "what does this agent own" and, in the store, switches which cached list
 * they read. Both screens stay mounted in the shell at once, so their rows are
 * cached per agent id and never overwrite each other.
 *
 * WRITE AUTHORITY IS NOT RECOMPUTED HERE. Every listed row carries `canWrite`,
 * the server's A15 answer for this viewer (T32b), and the detail view reads it.
 * The `New skill` action has no row to read yet, so the PAGE passes its own
 * `canAdminister` down as `canCreate` (`agent-permissions.ts` states that rule
 * once, for a surface mounted without the page).
 *
 * MASTER AND DETAIL, LIKE MEMORY. The list is the left pane, the selected
 * skill's editor the right one, and on desktop the first row is selected as
 * soon as the list lands: a two pane surface whose right half is empty until
 * you click reads as a narrow mobile column that lost its content. The PHONE
 * keeps push navigation, because two panes do not fit: the list is the screen,
 * a row pushes the detail over it and a Back control returns.
 *
 * BACKEND CONTRACT:
 *   GET  /api/agent/skills?ownerAgentId=<id>
 *        -> [{ id, name, description, body, source, requiredScopes, domain,
 *              ownerAgentId, canWrite }]
 *   POST /api/agent/skills  body { ..., ownerAgentId }
 *        -> 201, or 403 `agent_write_forbidden` when A15 refuses.
 */
import { ChevronLeft } from "lucide-solid"
import { type Component, createEffect, createSignal, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { trackOpenRecord } from "~/modules/shell/open-record"
import { shellTier } from "~/modules/shell/shell-tier"
import SkillDetail from "./SkillDetail"
import SkillsList from "./SkillsList"
import { createSkill, skillsForAgent } from "./skills-store"

interface Props {
  agentId: string
  /** The page's `canAdminister`: may this viewer author for this agent? */
  canCreate?: boolean
  /** A deep link's `?selected=<skill id>`, from the page's own route. */
  selected?: string
  /** The viewer picked another row, so the page drops the param. */
  onSelectedCleared?: () => void
  /** This tab is the one showing. Absent means yes. */
  active?: boolean
}

const AgentSkillsTab: Component<Props> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [selected, setSelected] = createSignal<string | null>(null)
  /** The row the viewer opened: the first row selecting itself is not one. */
  const [opened, setOpened] = createSignal<string | null>(null)
  trackOpenRecord("kernel", "skill", () =>
    props.active !== false && selected() === opened() ? opened() : null,
  )
  const [creating, setCreating] = createSignal(false)
  const [name, setName] = createSignal("")
  const [description, setDescription] = createSignal("")
  const [body, setBody] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  // The deep link's row, consumed ONCE: after that the viewer's own clicks own
  // the selection, and the page drops the param.
  let consumedSelection: string | null = null
  createEffect(() => {
    const id = props.selected
    if (!id || id === consumedSelection) return
    consumedSelection = id
    setCreating(false)
    setOpened(id)
    setSelected(id)
  })

  const isPhone = () => shellTier() === "phone"

  // The default selection, once: the list arrives after mount, so the first row
  // cannot be picked at init, and picking it on every list change would fight
  // the viewer's own clicks.
  let defaulted = false
  createEffect(() => {
    if (defaulted || isPhone()) return
    if (selected() || creating() || props.selected) return
    const first = skillsForAgent(props.agentId)[0]
    if (!first) return
    defaulted = true
    setSelected(first.id)
  })

  /** Phone shows ONE pane: the list, or the thing a row pushed over it. */
  const showDetailPane = () => !isPhone() || creating() || selected() !== null
  const showListPane = () => !isPhone() || (!creating() && selected() === null)

  function startCreate() {
    setName("")
    setDescription("")
    setBody("")
    setError(null)
    setSelected(null)
    setCreating(true)
  }

  async function save() {
    setError(null)
    if (!name().trim() || !description().trim() || !body().trim()) {
      setError(i18n.t("kernel.agents.skillIncomplete"))
      return
    }
    setSaving(true)
    try {
      const created = await createSkill(api as never, {
        name: name().trim(),
        description: description().trim(),
        body: body(),
        scope: "user",
        requiredScopes: [],
        ownerAgentId: props.agentId,
      })
      setCreating(false)
      setOpened(created.id)
      setSelected(created.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : i18n.t("kernel.agents.saveFailed"))
    } finally {
      setSaving(false)
    }
  }

  const fieldClass =
    "rounded-md border border-border-subtle bg-surface-elevated px-2.5 py-1.5 text-[13px] text-text outline-none transition-colors focus:border-accent"

  return (
    <div data-testid="agent-skills-tab" class="flex h-full min-h-0">
      <div
        class="flex min-h-0 flex-col border-border-subtle"
        classList={{
          hidden: !showListPane(),
          "w-full": isPhone(),
          "w-[300px] shrink-0 border-r": !isPhone(),
        }}
      >
        <SkillsList
          ownerAgentId={props.agentId}
          canCreate={props.canCreate}
          selectedId={selected()}
          onSelect={(skill) => {
            props.onSelectedCleared?.()
            setCreating(false)
            setOpened(skill.id)
            setSelected(skill.id)
          }}
          onNew={() => {
            props.onSelectedCleared?.()
            startCreate()
          }}
        />
      </div>

      <div
        data-testid="agent-skills-detail"
        class="min-h-0 min-w-0 flex-1 overflow-auto"
        classList={{ hidden: !showDetailPane() }}
      >
        <Show when={isPhone() && showDetailPane()}>
          <button
            type="button"
            data-testid="agent-skills-back"
            onClick={() => {
              setCreating(false)
              setSelected(null)
            }}
            class="flex min-h-11 items-center gap-1 px-4 text-[13px] text-text-secondary"
          >
            <ChevronLeft size={14} />
            {i18n.t("kernel.agents.backToList")}
          </button>
        </Show>

        <Show when={creating()}>
          <div data-testid="agent-skill-create" class="flex flex-col gap-3 px-6 py-4">
            <label class="flex flex-col gap-1.5 text-[12px] text-text-tertiary">
              {i18n.t("kernel.agents.fieldName")}
              <input
                type="text"
                data-testid="agent-skill-create-name"
                class={fieldClass}
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
              />
            </label>
            <label class="flex flex-col gap-1.5 text-[12px] text-text-tertiary">
              {i18n.t("kernel.agents.fieldDescription")}
              <input
                type="text"
                data-testid="agent-skill-create-description"
                class={fieldClass}
                value={description()}
                onInput={(e) => setDescription(e.currentTarget.value)}
              />
            </label>
            <label class="flex flex-col gap-1.5 text-[12px] text-text-tertiary">
              {i18n.t("kernel.agents.fieldBody")}
              <textarea
                rows={8}
                data-testid="agent-skill-create-body"
                class={fieldClass}
                value={body()}
                onInput={(e) => setBody(e.currentTarget.value)}
              />
            </label>
            <Show when={error()}>
              <p data-testid="agent-skill-create-error" class="text-[12px] text-amber-500">
                {error()}
              </p>
            </Show>
            <div class="flex items-center justify-end gap-2">
              <button
                type="button"
                data-testid="agent-skill-create-cancel"
                onClick={() => setCreating(false)}
                class="rounded-md border border-border-subtle px-3 py-1.5 text-[12px] text-text-tertiary transition-colors hover:bg-surface-hover"
              >
                {i18n.t("kernel.agents.cancel")}
              </button>
              <button
                type="button"
                data-testid="agent-skill-create-save"
                disabled={saving()}
                onClick={() => void save()}
                class="rounded-md bg-accent px-3 py-1.5 text-[12px] text-accent-foreground transition-colors disabled:opacity-50"
              >
                {i18n.t("kernel.agents.create")}
              </button>
            </div>
          </div>
        </Show>

        <Show
          when={!creating() && selected()}
          fallback={
            <Show when={!creating() && !isPhone()}>
              <p
                data-testid="agent-skills-no-selection"
                class="px-6 py-6 text-[13px] text-text-tertiary"
              >
                {i18n.t("kernel.agents.selectSkill")}
              </p>
            </Show>
          }
        >
          {(id) => <SkillDetail entityId={id()} ownerAgentId={props.agentId} />}
        </Show>
      </div>
    </div>
  )
}

export default AgentSkillsTab
