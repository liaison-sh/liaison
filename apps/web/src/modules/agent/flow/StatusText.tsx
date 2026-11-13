// SPDX-License-Identifier: FSL-1.1-ALv2
/** Flow copy with each of the project's status names drawn as a status pill. */
import { type Component, For } from "solid-js"
import { StatusPill } from "~/modules/projects/StatusPill"
import { type FlowNames, statusTextParts } from "./flow-model"

export const StatusText: Component<{ names: FlowNames; text: string; testid?: string }> = (
  props,
) => (
  <For each={statusTextParts(props.names, props.text)}>
    {(part) =>
      part.kind === "status" ? (
        <StatusPill
          label={part.text}
          color={part.color}
          data-testid={props.testid ? `${props.testid}-status` : undefined}
        />
      ) : (
        part.text
      )
    }
  </For>
)

export default StatusText
