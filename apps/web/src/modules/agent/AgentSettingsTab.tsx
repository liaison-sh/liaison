// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The agent page's Settings tab (P4c-T38): the one place an agent's definition
 * is written, and the one place it is archived.
 *
 * TWO FORMS, ONE COMPONENT, because they are the same fields. An administrator
 * (`kernel:agents:admin`) edits everything: name, description, picture,
 * colour, instructions, model and the capability ceiling. The OWNER of a
 * personal agent edits four of them (name, picture, colour, instructions) and
 * the rest is not drawn
 * at all: a disabled ceiling editor would still tell its owner that raising it
 * is a thing they might ask for, and the server refuses the write regardless
 * (403 with a code, never a silent drop).
 *
 * NOBODY BUT AN ADMIN EVER SEES A SCOPE NAME. The ceiling editor is the roles
 * admin's own picker (`settings/PermissionGrid`), mounted only on the admin
 * branch, so the scope vocabulary cannot leak onto an owner's form by a later
 * edit to this file: the names exist inside that one `Show`.
 *
 * CREATE MODE is the same form with no agent behind it yet: the directory's New
 * agent card opens `/agents/new/settings` (`AgentsDirectory`, T34), this tab
 * POSTs, and the created agent's own page is opened on top, so the blank tab is
 * never left pretending to be a saved agent. The handle is derived from the
 * name and stays editable under Advanced, because it is what people type in a
 * mention and renaming an agent must not silently re-address it.
 *
 * IT IS A FORM ON THE TAB, never a dialog. The whole definition (name, handle,
 * purpose, instructions, model, capability ceiling and where the agent runs)
 * is on screen as soon as the tab opens: a definition behind a control the
 * viewer has to find first is a definition they report as missing. `Advanced`
 * keeps only what is genuinely rare, which is archiving.
 *
 * ARCHIVE lives here too, as the existing `AgentArchiveAdmin` row: it owns the
 * 409 blocker list and the reassign controls, and this tab merely gives it a
 * place on the page.
 *
 * BACKEND CONTRACT:
 *   GET   /api/agents/:agentId       -> the page read (T31)
 *   PATCH /api/agents/:agentId       -> { displayName?, avatarUrl?, avatarColor?,
 *                                         purpose?, systemPrompt?,
 *                                         modelPreference?, scopeCeiling? }
 *   POST  /api/agents                -> { handle, displayName, ... } (role agent)
 *   POST  /api/agents/:agentId/archive
 */
import { AGENT_AVATAR_COLOR_COUNT, isAgentAvatarColor } from "@liaison/shared"
import { type Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import AgentArchiveAdmin from "~/modules/agent/AgentArchiveAdmin"
import { ensureAvailableModels } from "~/modules/agent/credits/credits-store"
import ModelOptions from "~/modules/agent/ModelOptions"
import { hasScope, userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { createAttachedNodeName } from "~/modules/nodes/agent-node"
import {
  AVATAR_ACCEPT_ATTR,
  AVATAR_ACCEPT_MIME,
  AVATAR_MAX_UPLOAD_BYTES,
} from "~/modules/settings/avatar-service"
import { PermissionGrid, type ScopeCatalogEntry } from "~/modules/settings/PermissionGrid"
import { useApi } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"
import { setAgentAvatarColor } from "~/modules/threads/agent-directory"
import { localizeAgentName } from "~/modules/threads/agent-name"
import AgentGlyph from "~/ui/AgentGlyph"
import { AvatarImage } from "~/ui/AvatarImage"
import { agentAvatarSlot, agentAvatarStyle } from "~/ui/avatar-palette"

/** The name each palette slot is read out by (`--agent-avatar-N`, theme.css). */
const AVATAR_COLOR_NAME_KEYS = [
  "kernel.agents.colorViolet",
  "kernel.agents.colorBlue",
  "kernel.agents.colorOrange",
  "kernel.agents.colorGreen",
  "kernel.agents.colorPink",
  "kernel.agents.colorTeal",
  "kernel.agents.colorRed",
  "kernel.agents.colorSlate",
] as const

/** The agent page's own tab type, so a created agent opens as a page and not
 *  as a second kind of thing (`AgentsDirectory` uses the same string). */
const AGENT_TAB_TYPE = "agents:agent"

/** The entity id the directory's New agent card opens the tab with. */
const CREATE_ENTITY_ID = "new"

/** What the tab edits, read off the page read and written back by PATCH. */
interface AgentDefinition {
  id: string
  handle: string
  displayName: string
  kind: "role" | "personal" | "system"
  ownerUserId: string | null
  purpose: string
  avatarUrl: string | null
  /** The stored palette slot, null when none is stored yet. */
  avatarColor: number | null
  systemPrompt: string
  modelPreference: string | null
  scopeCeiling: string[]
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function normalizeDefinition(raw: any): AgentDefinition | null {
  if (typeof raw?.id !== "string") return null
  return {
    id: raw.id,
    handle: text(raw.handle),
    displayName: text(raw.displayName),
    kind: raw.kind === "personal" || raw.kind === "system" ? raw.kind : "role",
    ownerUserId: typeof raw.ownerUserId === "string" ? raw.ownerUserId : null,
    purpose: text(raw.purpose),
    avatarUrl: typeof raw.avatarUrl === "string" ? raw.avatarUrl : null,
    avatarColor: isAgentAvatarColor(raw.avatarColor) ? raw.avatarColor : null,
    // The page read does not carry the prompt: `/definition` does, and it is
    // fetched alongside for exactly this form.
    systemPrompt: text(raw.systemPrompt),
    modelPreference: typeof raw.modelPreference === "string" ? raw.modelPreference : null,
    scopeCeiling: Array.isArray(raw.scopeCeiling)
      ? raw.scopeCeiling.filter((s: unknown) => typeof s === "string")
      : [],
  }
}

/** A name typed by a person, as the handle people will mention. */
function handleFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 31)
  return slug ? `@${slug}` : ""
}

interface Props {
  agentId: string
  /** Where this agent's turns run, from the page read the header already made.
   *  It is part of the definition a person reads here, and it is not the
   *  settings read's to answer twice. */
  runsOn?: "liaison" | "local"
}

const AgentSettingsTab: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const isCreate = () => props.agentId === CREATE_ENTITY_ID
  // L26: a cloud agent attached to the viewer's node runs there too.
  const attachedNode = createAttachedNodeName(api, () => (isCreate() ? null : props.agentId))
  const isAdmin = createMemo(() => hasScope("kernel:agents:admin"))

  const [definition, { mutate }] = createResource<AgentDefinition | null, string>(
    () => props.agentId,
    async (agentId) => {
      if (agentId === CREATE_ENTITY_ID) return null
      // The editor's own read, not the page read: the page read names no scope
      // and carries no prompt, and this form edits both.
      const res = await api.get<any>(`/agents/${agentId}/settings`)
      return normalizeDefinition(res?.data ?? res)
    },
  )

  /**
   * THE PROMPT THE AGENT ACTUALLY RUNS ON, which is not the field above it.
   * The row's own `systemPrompt` is what this form edits; the workspace charter
   * and the roster are composed on top of it at turn time, and `/definition` is
   * the one place that composition is published. The Overview tab reads exactly
   * this and offered Show instructions on it, while Settings, which the
   * Overview's own copy names as the place instructions change, drew an empty
   * box for an agent whose own prompt is blank. Both tabs name both halves now.
   */
  const [composed] = createResource<string, string>(
    () => props.agentId,
    async (agentId) => {
      if (agentId === CREATE_ENTITY_ID) return ""
      try {
        const res = await api.get<any>(`/agents/${agentId}/definition`)
        const body = res?.data ?? res
        return typeof body?.systemPrompt === "string" ? body.systemPrompt : ""
      } catch {
        // A definition we cannot read is one fewer explanation, never a broken
        // settings form.
        return ""
      }
    },
  )
  const [showComposed, setShowComposed] = createSignal(false)

  const [name, setName] = createSignal<string | null>(null)
  const [purpose, setPurpose] = createSignal<string | null>(null)
  const [avatar, setAvatar] = createSignal<string | null>(null)
  const [prompt, setPrompt] = createSignal<string | null>(null)
  const [model, setModel] = createSignal<string | null>(null)
  const [handle, setHandle] = createSignal<string | null>(null)
  const [ceiling, setCeiling] = createSignal<string[] | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [saved, setSaved] = createSignal(false)
  const [avatarBusy, setAvatarBusy] = createSignal(false)
  const [avatarError, setAvatarError] = createSignal<string | null>(null)
  const [colorError, setColorError] = createSignal<string | null>(null)
  let avatarInputRef: HTMLInputElement | undefined

  /** The edited value, or the loaded one while the field is untouched. */
  // The Name field shows a personal agent's untouched default in the reader's language;
  // an untouched field saves the STORED name back, so opening Settings never renames it.
  const nameValue = () => name() ?? localizeAgentName(definition()?.displayName ?? "")
  const nameToSave = () => name() ?? definition()?.displayName ?? ""
  const purposeValue = () => purpose() ?? definition()?.purpose ?? ""
  const avatarValue = () => avatar() ?? definition()?.avatarUrl ?? ""
  const promptValue = () => prompt() ?? definition()?.systemPrompt ?? ""
  const modelValue = () => model() ?? definition()?.modelPreference ?? ""
  const ceilingValue = () => ceiling() ?? definition()?.scopeCeiling ?? []
  const handleValue = () => handle() ?? definition()?.handle ?? handleFromName(nameValue())

  /** The owner branch: three fields, and the server enforces the same three. */
  const isOwner = createMemo(() => {
    const row = definition()
    if (row?.kind !== "personal") return false
    return row.ownerUserId !== null && row.ownerUserId === userFromToken()?.userId
  })
  const canEditAll = createMemo(() => isAdmin())

  const [catalog] = createResource<ScopeCatalogEntry[]>(async () => {
    if (!isAdmin()) return []
    try {
      const res = await api.get<any>("/admin/scope-catalog")
      const raw = Array.isArray(res) ? res : (res?.data ?? [])
      return (Array.isArray(raw) ? raw : []).filter(
        (entry: any): entry is ScopeCatalogEntry => typeof entry?.scope === "string",
      )
    } catch {
      // No catalog is an empty picker that still shows what is granted, which
      // is what `PermissionGrid` does with an empty catalog on its own.
      return []
    }
  })

  // Only what this workspace can run (walk N4): a picked model is never
  // silently answered by another one.
  void ensureAvailableModels(api)

  async function save(): Promise<void> {
    if (busy()) return
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      if (isCreate()) {
        const res = await api.post<any>("/agents", {
          handle: handleValue(),
          displayName: nameValue(),
          purpose: purposeValue() || null,
          avatarUrl: avatarValue() || null,
          systemPrompt: promptValue(),
          modelPreference: modelValue() || null,
          scopeCeiling: ceilingValue(),
        })
        const created = normalizeDefinition(res?.data ?? res)
        if (created) {
          // The blank tab has served its purpose: the agent now has a page of
          // its own and that is where the rest of the work happens.
          openTab({
            type: AGENT_TAB_TYPE,
            entityId: created.id,
            label: created.displayName || nameValue(),
            routePath: `/agents/${created.id}/settings`,
          })
        }
        setSaved(true)
        return
      }
      const body: Record<string, unknown> = {
        displayName: nameToSave(),
        avatarUrl: avatarValue() || null,
        systemPrompt: promptValue(),
      }
      // Only what this caller may write is ever SENT: the server answers a
      // body naming a field an owner may not write with a 403, so a form that
      // sent them anyway would fail every owner save.
      if (canEditAll()) {
        body.purpose = purposeValue() || null
        body.modelPreference = modelValue() || null
        body.scopeCeiling = ceilingValue()
      }
      const res = await api.patch<any>(`/agents/${props.agentId}`, body)
      const updated = normalizeDefinition(res?.data ?? res)
      if (updated) mutate({ ...updated, systemPrompt: updated.systemPrompt || promptValue() })
      setSaved(true)
    } catch {
      setError(i18n.t("kernel.agents.settingsSaveFailed"))
    } finally {
      setBusy(false)
    }
  }

  /**
   * THE PICTURE IS UPLOADED, NOT TYPED. This field used to be a bare text box
   * for `avatarUrl`, so the only way to give an agent a face was to know a URL
   * and paste it: an empty box with no control and no preview. The file goes as
   * the raw body to `POST /api/agents/:id/avatar`, exactly as a person's own
   * picture goes to `/api/users/me/avatar`, and the row comes back with the
   * capability URL the header already renders.
   *
   * Create mode has no agent id yet, so the control is drawn only once the
   * agent exists: there is nothing to attach an object to before then.
   */
  async function onAvatarSelected(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    // Reset so picking the SAME file again still fires onChange.
    input.value = ""
    if (!file) return
    if (file.size > AVATAR_MAX_UPLOAD_BYTES) {
      setAvatarError(i18n.t("kernel.agents.pictureTooLarge"))
      return
    }
    if (file.type && !(AVATAR_ACCEPT_MIME as readonly string[]).includes(file.type)) {
      setAvatarError(i18n.t("kernel.agents.pictureUnsupported"))
      return
    }
    setAvatarBusy(true)
    setAvatarError(null)
    try {
      const res = await api.post<any>(`/agents/${props.agentId}/avatar`, file)
      const updated = normalizeDefinition(res?.data ?? res)
      if (updated) {
        mutate({ ...updated, systemPrompt: updated.systemPrompt || promptValue() })
        setAvatar(updated.avatarUrl ?? "")
      }
    } catch {
      setAvatarError(i18n.t("kernel.agents.pictureFailed"))
    } finally {
      setAvatarBusy(false)
    }
  }

  async function onAvatarRemoved(): Promise<void> {
    setAvatarBusy(true)
    setAvatarError(null)
    try {
      const res = await api.delete<any>(`/agents/${props.agentId}/avatar`)
      const updated = normalizeDefinition(res?.data ?? res)
      if (updated) {
        mutate({ ...updated, systemPrompt: updated.systemPrompt || promptValue() })
      }
      setAvatar("")
    } catch {
      setAvatarError(i18n.t("kernel.agents.pictureFailed"))
    } finally {
      setAvatarBusy(false)
    }
  }

  /**
   * THE COLOUR SAVES ON PICK, like the picture: it is the agent's face, and
   * every disc of this agent (sidebar, chats, messages, the page header)
   * repaints at once through the directory. Only the newest pick is applied
   * when picks overlap, so an arrow key held across the swatches settles on
   * the one it stopped on.
   */
  let colorSeq = 0
  async function pickColor(color: number): Promise<void> {
    const row = definition()
    if (!row || row.avatarColor === color) return
    const seq = ++colorSeq
    const previous = row.avatarColor
    setColorError(null)
    mutate({ ...row, avatarColor: color })
    setAgentAvatarColor(row.id, color)
    try {
      const res = await api.patch<any>(`/agents/${props.agentId}`, { avatarColor: color })
      if (seq !== colorSeq) return
      const updated = normalizeDefinition(res?.data ?? res)
      if (updated?.avatarColor != null) {
        const current = definition()
        if (current) mutate({ ...current, avatarColor: updated.avatarColor })
        setAgentAvatarColor(row.id, updated.avatarColor)
      }
    } catch {
      if (seq !== colorSeq) return
      const current = definition()
      if (current) mutate({ ...current, avatarColor: previous })
      if (previous != null) setAgentAvatarColor(row.id, previous)
      setColorError(i18n.t("kernel.agents.colorFailed"))
    }
  }
  const colorValue = () => agentAvatarSlot(props.agentId, definition()?.avatarColor)

  const fieldClass =
    "w-full rounded-md border border-border-subtle bg-surface-elevated px-2 py-1.5 text-[13px] text-text"
  const labelClass = "text-[12px] font-medium text-text-secondary"

  return (
    <div data-testid="agent-settings" class="flex flex-col gap-4 px-4 py-3">
      <Show when={isCreate()}>
        <h2 class="text-[15px] font-medium text-text">{i18n.t("kernel.agents.newAgent")}</h2>
      </Show>
      <Show when={!isCreate() && definition.state === "errored"}>
        <p data-testid="agent-settings-error" class="text-[12px] text-amber-500">
          {i18n.t("kernel.agents.settingsLoadFailed")}
        </p>
      </Show>
      <Show when={isOwner() && !isAdmin()}>
        <p data-testid="agent-settings-owner-note" class="text-[12px] text-text-tertiary">
          {i18n.t("kernel.agents.ownerNote")}
        </p>
      </Show>

      <div data-testid="agent-settings-form" class="flex flex-col gap-4">
        <label class="flex flex-col gap-1">
          <span class={labelClass}>{i18n.t("kernel.agents.fieldName")}</span>
          <input
            data-testid="agent-settings-name"
            class={fieldClass}
            value={nameValue()}
            onInput={(e) => setName(e.currentTarget.value)}
          />
        </label>

        <Show when={canEditAll()}>
          <label class="flex flex-col gap-1">
            <span class={labelClass}>{i18n.t("kernel.agents.fieldDescription")}</span>
            <input
              data-testid="agent-settings-purpose"
              class={fieldClass}
              value={purposeValue()}
              onInput={(e) => setPurpose(e.currentTarget.value)}
            />
            <span class="text-[11px] text-text-tertiary">
              {i18n.t("kernel.agents.purposeHint")}
            </span>
          </label>
        </Show>

        <Show when={!isCreate()}>
          <div class="flex flex-col gap-1">
            <span class={labelClass}>{i18n.t("kernel.agents.fieldPicture")}</span>
            <div class="flex items-center gap-3">
              <span
                data-testid="agent-settings-avatar-preview"
                class="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full text-[20px]"
                style={agentAvatarStyle(props.agentId, definition()?.avatarColor)}
              >
                <AvatarImage
                  url={avatarValue()}
                  testId="agent-settings-avatar-image"
                  class="h-14 w-14 rounded-full object-cover"
                  fallback={<AgentGlyph />}
                />
              </span>
              <div class="flex min-w-0 flex-col gap-1">
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept={AVATAR_ACCEPT_ATTR}
                  class="hidden"
                  data-testid="agent-settings-avatar-file"
                  onChange={(e) => void onAvatarSelected(e)}
                />
                <div class="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="agent-settings-avatar-choose"
                    disabled={avatarBusy()}
                    onClick={() => avatarInputRef?.click()}
                    class="rounded-md border border-border-subtle px-3 py-1 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover disabled:opacity-50"
                  >
                    {i18n.t("kernel.agents.choosePicture")}
                  </button>
                  <Show when={avatarValue()}>
                    <button
                      type="button"
                      data-testid="agent-settings-avatar-remove"
                      disabled={avatarBusy()}
                      onClick={() => void onAvatarRemoved()}
                      class="rounded-md px-2 py-1 text-[12px] text-text-tertiary transition-colors hover:bg-surface-hover disabled:opacity-50"
                    >
                      {i18n.t("kernel.agents.removePicture")}
                    </button>
                  </Show>
                </div>
                <span class="text-[11px] text-text-tertiary">
                  {i18n.t("kernel.agents.pictureHint")}
                </span>
                <Show when={avatarError()}>
                  <span
                    data-testid="agent-settings-avatar-error"
                    class="text-[11px] text-amber-500"
                  >
                    {avatarError()}
                  </span>
                </Show>
              </div>
            </div>
          </div>
        </Show>

        <Show when={!isCreate() && definition()}>
          <fieldset class="flex flex-col gap-1" data-testid="agent-settings-color">
            <legend class={`${labelClass} mb-1`}>{i18n.t("kernel.agents.fieldColor")}</legend>
            {/* Native radios: one Tab stop for the group, arrow keys move the
                pick, Space selects, and a screen reader names each swatch. */}
            <div class="flex flex-wrap items-center gap-2">
              <For each={Array.from({ length: AGENT_AVATAR_COLOR_COUNT }, (_, i) => i)}>
                {(slot) => (
                  <label
                    class="relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-full has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent"
                    title={i18n.t(AVATAR_COLOR_NAME_KEYS[slot] ?? AVATAR_COLOR_NAME_KEYS[0])}
                  >
                    <input
                      type="radio"
                      name={`agent-color-${props.agentId}`}
                      class="peer sr-only"
                      value={slot}
                      checked={colorValue() === slot}
                      aria-label={i18n.t(AVATAR_COLOR_NAME_KEYS[slot] ?? AVATAR_COLOR_NAME_KEYS[0])}
                      data-testid={`agent-settings-color-${slot}`}
                      onChange={() => void pickColor(slot)}
                    />
                    <span
                      aria-hidden="true"
                      class="h-7 w-7 rounded-full border-2 border-transparent peer-checked:border-text"
                      style={{ background: `var(--agent-avatar-${slot}-bg)` }}
                    />
                  </label>
                )}
              </For>
            </div>
            <span class="text-[11px] text-text-tertiary">{i18n.t("kernel.agents.colorHint")}</span>
            <Show when={colorError()}>
              <span data-testid="agent-settings-color-error" class="text-[11px] text-amber-500">
                {colorError()}
              </span>
            </Show>
          </fieldset>
        </Show>

        <label class="flex flex-col gap-1">
          <span class={labelClass}>{i18n.t("kernel.agents.fieldInstructions")}</span>
          <textarea
            data-testid="agent-settings-instructions"
            rows={8}
            class={`${fieldClass} font-mono leading-relaxed`}
            value={promptValue()}
            onInput={(e) => setPrompt(e.currentTarget.value)}
          />
        </label>

        <Show when={(composed() ?? "").trim().length > 0}>
          <div class="flex flex-col gap-1">
            <span class="text-[12px] text-text-tertiary">
              {i18n.t("kernel.agents.fieldInstructionsComposedNote", {
                name: nameValue() || i18n.t("kernel.agents.thisAgent"),
              })}
            </span>
            <button
              type="button"
              data-testid="agent-settings-toggle-composed"
              onClick={() => setShowComposed((v) => !v)}
              class="self-start min-h-9 rounded-md border border-border-subtle px-2.5 text-[12px] text-text-secondary hover:bg-surface-hover"
            >
              {showComposed()
                ? i18n.t("kernel.agents.hideInstructions")
                : i18n.t("kernel.agents.showInstructions")}
            </button>
            <Show when={showComposed()}>
              <pre
                data-testid="agent-settings-composed"
                class="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-surface p-3 text-[12px] text-text-secondary"
              >
                {composed()}
              </pre>
            </Show>
          </div>
        </Show>

        <Show when={canEditAll()}>
          <label class="flex flex-col gap-1">
            <span class={labelClass}>{i18n.t("kernel.agents.fieldModel")}</span>
            <select
              data-testid="agent-settings-model"
              class={fieldClass}
              value={modelValue()}
              onChange={(e) => setModel(e.currentTarget.value)}
            >
              <ModelOptions current={definition()?.modelPreference} />
            </select>
          </label>

          <div class="flex flex-col gap-1">
            <span class={labelClass}>{i18n.t("kernel.agents.capabilities")}</span>
            <div data-testid="agent-settings-capabilities">
              <PermissionGrid
                catalog={catalog() ?? []}
                granted={ceilingValue()}
                loading={catalog.loading}
                mode="edit"
                /* The agent pages never print a scope id (charter agent.md):
                   each checkbox reads as the capability it grants, with the
                   identifier kept in the row's title for an admin. */
                humanLabels
                testIdPrefix="agent-ceiling"
                onAdd={(scope) => {
                  setCeiling([...ceilingValue(), scope])
                }}
                onRemove={(scope) => {
                  setCeiling(ceilingValue().filter((s) => s !== scope))
                }}
              />
            </div>
          </div>
        </Show>

        {/* The handle is what people TYPE in a mention, so it belongs on the form
          and not under a fold. It is fixed after creation: renaming an agent
          must not silently re-address it. */}
        <label class="flex flex-col gap-1">
          <span class={labelClass}>{i18n.t("kernel.agents.fieldHandle")}</span>
          <input
            data-testid="agent-settings-handle"
            class={fieldClass}
            disabled={!isCreate()}
            value={handleValue()}
            onInput={(e) => setHandle(e.currentTarget.value)}
          />
          <Show when={!isCreate()}>
            <span class="text-[11px] text-text-tertiary">{i18n.t("kernel.agents.handleHint")}</span>
          </Show>
        </label>

        {/* Where the turns run. Read only: it follows whether a desktop has
          claimed this agent, never a preference typed here. */}
        <Show when={!isCreate()}>
          <div class="flex flex-col gap-1">
            <span class={labelClass}>{i18n.t("kernel.agents.fieldRuntime")}</span>
            <p data-testid="agent-settings-runtime" class="text-[13px] text-text-secondary">
              {props.runsOn === "local"
                ? i18n.t("kernel.agents.runsOnLocal")
                : attachedNode()
                  ? i18n.t("kernel.agents.runsOnLiaisonAndNode", { node: attachedNode() ?? "" })
                  : i18n.t("kernel.agents.runsOnLiaison")}
            </p>
          </div>
        </Show>
      </div>

      <div class="flex items-center gap-3">
        <button
          type="button"
          data-testid="agent-settings-save"
          disabled={busy() || nameValue().trim() === ""}
          class="rounded-md border border-border-subtle bg-accent/10 px-3 py-1 text-[12px] text-accent disabled:opacity-50"
          onClick={() => void save()}
        >
          {busy() ? i18n.t("kernel.agents.saving") : i18n.t("kernel.agents.save")}
        </button>
        <Show when={error()}>
          {(message) => (
            <p data-testid="agent-settings-save-error" class="text-[12px] text-amber-500">
              {message()}
            </p>
          )}
        </Show>
        <Show when={saved() && !error()}>
          <p data-testid="agent-settings-saved" class="text-[12px] text-text-tertiary">
            {i18n.t("kernel.agentUi.saved")}
          </p>
        </Show>
      </div>

      <details class="rounded-md border border-border-subtle">
        <summary class="cursor-pointer px-3 py-2 text-[12px] text-text-secondary">
          {i18n.t("kernel.agents.fieldAdvanced")}
        </summary>
        <div class="flex flex-col gap-3 px-3 pb-3">
          {/* Archiving is an administrator's, and it owns its own blocker list
              and reassign controls: this tab only gives it a place to sit. */}
          <Show when={!isCreate() && isAdmin()}>
            <AgentArchiveAdmin agentId={props.agentId} />
          </Show>
        </div>
      </details>
    </div>
  )
}

export default AgentSettingsTab
