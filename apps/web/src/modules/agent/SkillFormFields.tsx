// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"

interface Props {
  /** Prefix for the three field testids — keeps the create / edit surfaces
   *  visually identical while their tests can still address them distinctly. */
  testidPrefix: string
  name: () => string
  setName: (value: string) => void
  description: () => string
  setDescription: (value: string) => void
  body: () => string
  setBody: (value: string) => void
  /** Optional routing domain slug. Approval of this skill routes to reviewers
   *  with authority for the domain. Empty string means no domain (general). */
  domain: () => string
  setDomain: (value: string) => void
  /** Optional validation message rendered below the body field. */
  error?: () => string | null
}

const INPUT_CLASS =
  "rounded-md border border-border-subtle bg-surface-elevated px-2.5 py-1.5 text-[13px] text-text outline-none transition-colors focus:border-accent"

const TEXTAREA_CLASS =
  "rounded-md border border-border-subtle bg-surface-elevated px-2.5 py-1.5 font-mono text-[12px] text-text outline-none transition-colors focus:border-accent"

/** The Name + Description + Body fields shared by SkillCreate and SkillDetail's
 *  edit form. Scope (Create-only) and the surrounding actions stay with the
 *  caller — only the three common fields are abstracted so divergence on
 *  copy/styling/validation wording is structurally impossible. */
const SkillFormFields: Component<Props> = (props) => {
  const i18n = useI18n()
  return (
    <>
      <label class="flex flex-col gap-1.5 text-[12px] text-text-tertiary">
        {i18n.t("kernel.agents.fieldName")}
        <input
          data-testid={`${props.testidPrefix}-name`}
          type="text"
          placeholder={i18n.t("kernel.agentUi.skillNamePlaceholder")}
          class={INPUT_CLASS}
          value={props.name()}
          onInput={(e) => props.setName(e.currentTarget.value)}
        />
      </label>

      <label class="mt-3 flex flex-col gap-1.5 text-[12px] text-text-tertiary">
        {i18n.t("kernel.agents.fieldDescription")}
        <input
          data-testid={`${props.testidPrefix}-description`}
          type="text"
          maxLength={100}
          placeholder={i18n.t("kernel.agentForms.skillDescriptionPlaceholder")}
          class={INPUT_CLASS}
          value={props.description()}
          onInput={(e) => props.setDescription(e.currentTarget.value)}
        />
      </label>

      <label class="mt-3 flex flex-col gap-1.5 text-[12px] text-text-tertiary">
        {i18n.t("kernel.agentForms.skillBodyLabel")}
        <textarea
          data-testid={`${props.testidPrefix}-body`}
          rows={10}
          class={TEXTAREA_CLASS}
          value={props.body()}
          onInput={(e) => props.setBody(e.currentTarget.value)}
        />
      </label>

      <label class="mt-3 flex flex-col gap-1.5 text-[12px] text-text-tertiary">
        {i18n.t("kernel.agentForms.skillDomain")}
        <input
          data-testid={`${props.testidPrefix}-domain`}
          type="text"
          maxLength={40}
          placeholder={i18n.t("kernel.agentUi.skillDomainPlaceholder")}
          class={INPUT_CLASS}
          value={props.domain()}
          onInput={(e) => props.setDomain(e.currentTarget.value)}
        />
        <span class="text-[11px] text-text-tertiary">
          {i18n.t("kernel.agentForms.skillDomainHint")}
        </span>
      </label>

      <Show when={props.error?.()}>
        {(msg) => (
          <p data-testid={`${props.testidPrefix}-error`} class="mt-2 text-[12px] text-amber-500">
            {msg()}
          </p>
        )}
      </Show>
    </>
  )
}

export default SkillFormFields
