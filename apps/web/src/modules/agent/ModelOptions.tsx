// SPDX-License-Identifier: FSL-1.1-ALv2
import { For, Show } from "solid-js"
import { autoEntryLabel, pickableModelGroups } from "~/lib/model-groups"
import { availableModelIds } from "~/modules/agent/credits/credits-store"
import { useI18n } from "~/modules/i18n/i18n-context"

interface ModelOptionsProps {
  /** The stored choice, kept listed (disabled) when it can no longer run. */
  current: string | null | undefined
}

/**
 * The `<option>`s of a settings model `<select>` (an agent's default, a
 * routine's model): Auto, then the models this org is served, one
 * `<optgroup>` per provider label in the S6 order. The same list the composer
 * menu shows, so a model switched off by an admin is offered nowhere.
 */
export default function ModelOptions(props: ModelOptionsProps) {
  const i18n = useI18n()
  const groups = () => pickableModelGroups(availableModelIds(), props.current)
  const autoLabel = () => {
    const label = autoEntryLabel()
    return label === "Auto" ? i18n.t("kernel.agents.modelAuto") : label
  }
  return (
    <>
      <option value="">{autoLabel()}</option>
      <For each={groups()}>
        {(group) => {
          const options = () => (
            <For each={group.models}>
              {(model) => (
                <option value={model.id ?? ""} disabled={model.unavailable}>
                  {model.unavailable
                    ? i18n.t("kernel.agents.modelUnavailable", { model: model.label })
                    : model.label}
                </option>
              )}
            </For>
          )
          return (
            <Show when={group.provider} fallback={options()}>
              <optgroup label={group.provider}>{options()}</optgroup>
            </Show>
          )
        }}
      </For>
    </>
  )
}
