// SPDX-License-Identifier: FSL-1.1-ALv2
import { skillDomainSchema } from "@liaison/shared"
import { Sparkles } from "lucide-solid"
import { type Component, createSignal } from "solid-js"
import { namespaceRegistryKey } from "~/framework/app-registry"
import { kebabCase } from "~/lib/kebab-case"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { closeTab, makeTabId, openTab } from "~/modules/shell/tab-store"
import SkillFormFields from "./SkillFormFields"
import { type CreateSkillInput, createSkill } from "./skills-store"

/**
 * Skill creation as a full tab surface — not a modal. The agent chat stays
 * reachable so the user can ask for help authoring the skill body.
 */
const SkillCreate: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const [name, setName] = createSignal("")
  const [description, setDescription] = createSignal("")
  const [body, setBody] = createSignal("")
  const [domain, setDomain] = createSignal("")
  const [scope, setScope] = createSignal<"user" | "org">("user")
  const [saving, setSaving] = createSignal(false)
  const [saveError, setSaveError] = createSignal<string | null>(null)

  const createTabId = () => makeTabId(namespaceRegistryKey("agents", "skill"), "new")

  function cancel() {
    closeTab(createTabId())
  }

  async function handleSave() {
    setSaveError(null)
    const normalizedName = kebabCase(name())
    if (!normalizedName) {
      setSaveError(i18n.t("kernel.agentForms.nameInvalid"))
      return
    }
    if (!description().trim()) {
      setSaveError(i18n.t("kernel.agentForms.descriptionRequired"))
      return
    }
    if (!body().trim()) {
      setSaveError(i18n.t("kernel.agentForms.bodyRequired"))
      return
    }
    const trimmedDomain = domain().trim()
    if (trimmedDomain && !skillDomainSchema.safeParse(trimmedDomain).success) {
      setSaveError(i18n.t("kernel.agentForms.domainInvalid"))
      return
    }
    setSaving(true)
    try {
      const input: CreateSkillInput = {
        name: normalizedName,
        description: description(),
        body: body(),
        scope: scope(),
        requiredScopes: [],
        domain: trimmedDomain || undefined,
      }
      const created = await createSkill(api as any, input)
      // Just created by the user — open as a permanent tab, not an ephemeral preview.
      openTab({
        type: namespaceRegistryKey("agents", "skill"),
        entityId: encodeURIComponent(created.name),
        label: created.name,
        preview: false,
      })
      closeTab(createTabId())
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : i18n.t("kernel.agents.saveFailed"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div data-testid="skill-create" class="flex h-full flex-col">
      <div class="flex items-center gap-2 border-b border-border-subtle px-6 py-4">
        <Sparkles size={16} class="text-text-secondary" />
        <h1 class="text-[15px] font-medium text-text">{i18n.t("kernel.agents.newSkill")}</h1>
      </div>

      <div
        data-testid="skill-form"
        class="min-h-0 flex-1 overflow-auto px-6 pt-4 pb-dock-runway [--dock-pad-base:1rem]"
      >
        <div class="flex max-w-[560px] flex-col gap-4">
          <SkillFormFields
            testidPrefix="skills-new"
            name={name}
            setName={setName}
            description={description}
            setDescription={setDescription}
            body={body}
            setBody={setBody}
            domain={domain}
            setDomain={setDomain}
            error={saveError}
          />

          <label class="flex flex-col gap-1.5 text-[12px] text-text-tertiary">
            {i18n.t("kernel.agentForms.scope")}
            <select
              data-testid="skills-new-scope"
              class="rounded-md border border-border-subtle bg-surface-elevated px-2.5 py-1.5 text-[13px] text-text outline-none transition-colors focus:border-accent"
              value={scope()}
              onChange={(e) => setScope(e.currentTarget.value as "user" | "org")}
            >
              <option value="user">{i18n.t("kernel.agentForms.personal")}</option>
              <option value="org">{i18n.t("kernel.agentForms.organization")}</option>
            </select>
          </label>

          <div class="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              data-testid="skills-new-cancel"
              onClick={cancel}
              class="rounded-md border border-border-subtle px-3 py-1.5 text-[12px] text-text-tertiary transition-colors hover:bg-surface-hover"
            >
              {i18n.t("kernel.agents.cancel")}
            </button>
            <button
              type="button"
              data-testid="skills-new-save"
              onClick={() => void handleSave()}
              disabled={saving()}
              class="rounded-md bg-accent px-3 py-1.5 text-[12px] text-accent-foreground transition-colors disabled:opacity-50"
            >
              {saving()
                ? i18n.t("kernel.agentForms.savingEllipsis")
                : i18n.t("kernel.agentForms.createSkill")}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default SkillCreate
