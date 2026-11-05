// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The first card of a new workspace's setup conversation, posted by the
 * platform when its first administrator signs in (api
 * provisioning/setup-kickoff.ts). Its heading, what is set up (a snapshot from
 * the row), the key card when the workspace has no model key yet, and the demo
 * offer, the one place the offer appears. No modal, no banner, no alarm colour:
 * the agent carries the conversation from here.
 */
import { ExternalLink } from "lucide-solid"
import { type Component, Show } from "solid-js"
import {
  readSetupState,
  SetupChecklistCard,
  type SetupStateView,
} from "~/modules/agent/SetupChecklistCard"
import { useI18n } from "~/modules/i18n/i18n-context"
import SecretRequestToolCard from "~/modules/secret-request/SecretRequestToolCard"

export interface SetupKickoffView {
  state: SetupStateView
  demoUrl: string | null
  secretRequestId: string | null
}

/** The card's data out of a message's metadata, or null when it is not one. */
export function setupKickoffOf(metadata: unknown): SetupKickoffView | null {
  if (!metadata || typeof metadata !== "object") return null
  const meta = metadata as Record<string, unknown>
  if (meta.type !== "setup-kickoff") return null
  const state = readSetupState(meta.state)
  if (!state) return null
  const demoUrl =
    typeof meta.demoUrl === "string" && /^https?:\/\//.test(meta.demoUrl) ? meta.demoUrl : null
  const secretRequestId =
    typeof meta.secretRequestId === "string" && meta.secretRequestId !== ""
      ? meta.secretRequestId
      : null
  return { state, demoUrl, secretRequestId }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export const SetupKickoffRow: Component<{ messageId: string; view: SetupKickoffView }> = (
  props,
) => {
  const i18n = useI18n()
  return (
    <div
      data-testid="setup-kickoff-row"
      data-message-id={props.messageId}
      class="mt-3 flex flex-col gap-1 px-1 text-[13px]"
    >
      <h3 class="text-[14px] font-semibold text-text-primary">
        {i18n.t("first-run.kickoff.title")}
      </h3>
      <p class="text-text-secondary">{i18n.t("first-run.kickoff.intro")}</p>
      <SetupChecklistCard state={props.view.state} />
      <Show when={props.view.secretRequestId}>
        {(id) => (
          <>
            <p class="text-text-secondary">{i18n.t("first-run.kickoff.keyFirst")}</p>
            <SecretRequestToolCard requestId={id()} />
          </>
        )}
      </Show>
      <Show when={props.view.demoUrl}>
        {(url) => (
          <div data-testid="setup-demo-offer" class="mt-1 max-w-md text-text-secondary">
            <span class="font-medium text-text-primary">
              {i18n.t("first-run.kickoff.demoTitle")}
            </span>{" "}
            {i18n.t("first-run.kickoff.demoBody", { host: hostOf(url()) })}{" "}
            <a
              data-testid="setup-demo-link"
              href={url()}
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1 text-accent hover:underline"
            >
              {i18n.t("first-run.kickoff.demoLink")}
              <ExternalLink size={12} />
            </a>
          </div>
        )}
      </Show>
    </div>
  )
}
