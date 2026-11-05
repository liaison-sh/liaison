// SPDX-License-Identifier: FSL-1.1-ALv2
import { capabilityCategories, skillDomainSchema } from "@liaison/shared"
import { type Component, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { categoryChip, scopeIdTitle, scopeLabel } from "~/lib/capability-copy"
import { kebabCase } from "~/lib/kebab-case"
import { hasAppsAdmin, hasScope } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import Chip from "./Chip"
import SkillCreate from "./SkillCreate"
import SkillFormFields from "./SkillFormFields"
import {
  deleteSkill,
  forkSkill,
  loadSkills,
  setOpenSkillDetailId,
  skillsForAgent,
  toggleAppSkill,
  updateSkill,
} from "./skills-store"

interface Props {
  entityId: string
  /** P4c-T36: read the agent page's per-agent list instead of the flat one,
   *  and take the server's `canWrite` as the edit authority. */
  ownerAgentId?: string
}

const SkillDetail: Component<Props> = (props) => {
  const i18n = useI18n()
  // The "new" sentinel renders the create surface (a tab, never a modal).
  if (props.entityId === "new") return <SkillCreate />

  const api = useApi()
  /** Who reads the per-GRANT detail on this surface: the agents admin, nobody
   *  else. Everyone else reads the capability categories. NEITHER reads an
   *  identifier: the admin's chips name the same grants in words, with the
   *  raw id kept in the chip's title for the one person entitled to it. */
  const scopeAdmin = () => hasScope("kernel:agents:admin")
  const [banner, setBanner] = createSignal<null | "remote-updated">(null)
  const [editing, setEditing] = createSignal(false)
  const [editName, setEditName] = createSignal("")
  const [editDescription, setEditDescription] = createSignal("")
  const [editBody, setEditBody] = createSignal("")
  const [editDomain, setEditDomain] = createSignal("")
  const [editError, setEditError] = createSignal<string | null>(null)
  const [savingEdit, setSavingEdit] = createSignal(false)
  // Two-step inline delete — mirrors Memory's pattern instead of window.confirm
  // (project convention: no popups for cognitive work).
  const [confirmDelete, setConfirmDelete] = createSignal(false)

  const scoped = () => props.ownerAgentId

  onMount(() => {
    setOpenSkillDetailId(props.entityId)
    const owner = scoped()
    if (skillsForAgent(owner).length === 0) {
      void loadSkills(api as any, owner ? { ownerAgentId: owner } : undefined)
    }
  })

  const skill = createMemo(() => {
    const rows = skillsForAgent(scoped())
    return (
      rows.find((s) => s.id === props.entityId) ||
      rows.find((s) => s.name === decodeURIComponent(props.entityId))
    )
  })

  // Who may edit/delete this skill IN PLACE. A personal skill in the list is
  // always the caller's own (resolveAllSkills only surfaces personal skills the
  // caller authored), so it is editable. An org-shared skill lives under
  // author_user_id = NULL and the backend (loadEditableSkill) lets ONLY an
  // apps-admin edit it — so gate the Edit/Delete affordance on the SAME check.
  // Without this, a non-admin sees Edit, changes the body, and the save 403s.
  // Non-admins still get Fork (a personal copy they can freely edit).
  function canEdit(): boolean {
    const s = skill()
    if (!s) return false
    // On the agent page the server has already answered this, per row, under
    // A15 (T32b). The web never recomputes it.
    if (scoped()) return s.canWrite === true
    if (s.source === "personal") return true
    if (s.source === "org") return hasAppsAdmin()
    return false
  }

  function isForkable(): boolean {
    const s = skill()
    return !!s && (s.source === "app" || s.source === "org")
  }

  async function onFork() {
    const s = skill()
    if (!s) return
    try {
      await forkSkill(api as any, s.id)
    } catch (err) {
      console.error("Fork failed", err)
    }
  }

  async function onDelete() {
    const s = skill()
    if (!s) return
    if (!confirmDelete()) {
      setConfirmDelete(true)
      return
    }
    setConfirmDelete(false)
    try {
      await deleteSkill(api as any, s.id)
    } catch (err) {
      console.error("Delete failed", err)
    }
  }

  async function onToggleEnable() {
    const s = skill()
    if (!s || s.source !== "app" || !s.appName) return
    try {
      await toggleAppSkill(api as any, s.appName, s.name, "user")
    } catch (err) {
      console.error("Toggle failed", err)
    }
  }

  async function onReload() {
    const owner = scoped()
    await loadSkills(api as any, owner ? { ownerAgentId: owner } : undefined)
    setBanner(null)
  }

  function startEdit() {
    const s = skill()
    if (!s) return
    setEditName(s.name)
    setEditDescription(s.description)
    setEditBody(s.body ?? "")
    setEditDomain(s.domain ?? "")
    setEditError(null)
    setEditing(true)
  }

  async function saveEdit() {
    const s = skill()
    if (!s) return
    setEditError(null)
    const normalizedName = kebabCase(editName())
    if (!normalizedName) {
      setEditError(i18n.t("kernel.agentForms.nameInvalid"))
      return
    }
    if (!editDescription().trim()) {
      setEditError(i18n.t("kernel.agentForms.descriptionRequired"))
      return
    }
    if (!editBody().trim()) {
      setEditError(i18n.t("kernel.agentForms.bodyRequired"))
      return
    }
    const trimmedDomain = editDomain().trim()
    if (trimmedDomain && !skillDomainSchema.safeParse(trimmedDomain).success) {
      setEditError(i18n.t("kernel.agentForms.domainInvalid"))
      return
    }
    setSavingEdit(true)
    try {
      await updateSkill(api as any, s.id, {
        name: normalizedName,
        description: editDescription(),
        body: editBody(),
        domain: trimmedDomain || undefined,
      })
      setEditing(false)
    } catch (err) {
      setEditError(err instanceof Error ? err.message : i18n.t("kernel.agents.saveFailed"))
    } finally {
      setSavingEdit(false)
    }
  }

  return (
    <div data-testid="skill-detail" class="flex h-full flex-col">
      <Show
        when={skill()}
        fallback={
          <div class="px-6 py-8 text-text-tertiary">
            {i18n.t("kernel.agentForms.skillNotFound")}
          </div>
        }
      >
        {(s) => (
          <>
            <Show when={banner() === "remote-updated"}>
              <div
                data-testid="skill-detail-banner"
                class="flex items-center gap-3 border-b border-border-subtle bg-surface-hover px-4 py-2 text-[12px]"
              >
                <span>{i18n.t("kernel.agentForms.remoteUpdate")}</span>
                <button
                  type="button"
                  data-testid="skill-detail-reload"
                  class="text-accent underline"
                  onClick={() => void onReload()}
                >
                  {i18n.t("kernel.agentForms.reload")}
                </button>
                <button
                  type="button"
                  data-testid="skill-detail-discard"
                  class="text-text-tertiary underline"
                  onClick={() => setBanner(null)}
                >
                  {i18n.t("kernel.agentForms.keepEditing")}
                </button>
              </div>
            </Show>

            <div class="border-b border-border-subtle px-6 py-4">
              <div class="flex items-center gap-2">
                <h1 class="text-[16px] font-medium text-text">{s().name}</h1>
                <Chip data-testid={`skill-detail-source-${s().source}`}>{s().source}</Chip>
                <Show when={s().domain}>
                  {(d) => (
                    <Chip tone="accent" data-testid="skill-detail-domain">
                      {d()}
                    </Chip>
                  )}
                </Show>
              </div>
              <p class="mt-1 text-[13px] text-text-tertiary">{s().description}</p>
              <div class="mt-3 flex flex-wrap items-center gap-2">
                {/* A SCOPE NAME IS NEVER SHOWN (A14, charter agent.md): the
                    row renders the capability CATEGORIES its scopes amount to,
                    by their app or role NAME, and a `kernel:agents:admin`
                    viewer additionally reads one phrase per grant. The
                    identifier survives only in the admin chip's title, where
                    it is a lookup aid rather than the label. */}
                <Show
                  when={scopeAdmin()}
                  fallback={
                    <For each={capabilityCategories(s().requiredScopes ?? [])}>
                      {(category) => (
                        <Chip
                          data-testid={`skill-detail-capability-${category}`}
                          title={categoryChip(category, i18n.t).title}
                        >
                          {categoryChip(category, i18n.t).label}
                        </Chip>
                      )}
                    </For>
                  }
                >
                  <For each={s().requiredScopes ?? []}>
                    {(scope) => (
                      <Chip
                        data-testid={`skill-detail-scope-${scope}`}
                        title={scopeIdTitle(scope, i18n.t)}
                      >
                        {scopeLabel(scope, i18n.t)}
                      </Chip>
                    )}
                  </For>
                </Show>
              </div>
              <div class="mt-4 flex items-center gap-2">
                <Show when={s().source === "app"}>
                  <button
                    type="button"
                    data-testid={`skill-enable-toggle-${s().name}`}
                    onClick={() => void onToggleEnable()}
                    class="rounded-md border border-border-subtle px-3 py-1 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover"
                  >
                    {s().disabled
                      ? i18n.t("kernel.agents.enable")
                      : i18n.t("kernel.agentForms.disable")}
                  </button>
                </Show>
                <Show when={isForkable()}>
                  <button
                    type="button"
                    data-testid="skill-fork"
                    onClick={() => void onFork()}
                    class="rounded-md border border-border-subtle px-3 py-1 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover"
                  >
                    {i18n.t("kernel.agentForms.fork")}
                  </button>
                </Show>
                <Show when={canEdit() && !editing()}>
                  <button
                    type="button"
                    data-testid="skill-edit"
                    onClick={startEdit}
                    class="rounded-md border border-border-subtle px-3 py-1 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover"
                  >
                    {i18n.t("kernel.agentForms.edit")}
                  </button>
                  <button
                    type="button"
                    data-testid="skill-delete"
                    onClick={() => void onDelete()}
                    class="rounded-md border border-border-subtle px-3 py-1 text-[12px] text-red-500 transition-colors hover:bg-surface-hover"
                  >
                    {confirmDelete()
                      ? i18n.t("kernel.agentForms.confirmDelete")
                      : i18n.t("kernel.agentForms.delete")}
                  </button>
                  <Show when={confirmDelete()}>
                    <button
                      type="button"
                      data-testid="skill-delete-cancel"
                      onClick={() => setConfirmDelete(false)}
                      class="rounded-md border border-border-subtle px-3 py-1 text-[12px] text-text-tertiary transition-colors hover:bg-surface-hover"
                    >
                      {i18n.t("kernel.agents.cancel")}
                    </button>
                  </Show>
                </Show>
              </div>
            </div>

            <Show
              when={editing()}
              fallback={
                <div class="min-h-0 flex-1 overflow-auto px-6 py-4">
                  <pre
                    data-testid="skill-detail-body"
                    class="whitespace-pre-wrap font-mono text-[12px] text-text"
                  >
                    {s().body ?? ""}
                  </pre>
                </div>
              }
            >
              <div
                data-testid="skill-edit-form"
                class="min-h-0 flex-1 overflow-auto px-6 pt-4 pb-dock-runway [--dock-pad-base:1rem]"
              >
                <SkillFormFields
                  testidPrefix="skill-edit"
                  name={editName}
                  setName={setEditName}
                  description={editDescription}
                  setDescription={setEditDescription}
                  body={editBody}
                  setBody={setEditBody}
                  domain={editDomain}
                  setDomain={setEditDomain}
                  error={editError}
                />
                <div class="mt-4 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    data-testid="skill-edit-cancel"
                    onClick={() => setEditing(false)}
                    class="rounded-md border border-border-subtle px-3 py-1.5 text-[12px] text-text-tertiary transition-colors hover:bg-surface-hover"
                  >
                    {i18n.t("kernel.agents.cancel")}
                  </button>
                  <button
                    type="button"
                    data-testid="skill-edit-save"
                    onClick={() => void saveEdit()}
                    disabled={savingEdit()}
                    class="rounded-md bg-accent px-3 py-1.5 text-[12px] text-accent-foreground transition-colors disabled:opacity-50"
                  >
                    {savingEdit()
                      ? i18n.t("kernel.agentForms.savingEllipsis")
                      : i18n.t("kernel.agents.save")}
                  </button>
                </div>
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}

export default SkillDetail
