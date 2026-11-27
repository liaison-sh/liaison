// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The first card of a new workspace's setup conversation, posted by the
 * platform when its first administrator signs in (api
 * provisioning/setup-kickoff.ts). Its heading, what is set up (a snapshot from
 * the row, then read live), the key card when the workspace has no model key
 * yet, and the demo offer, the one place the offer appears. No modal, no banner, no alarm colour:
 * the agent carries the conversation from here.
 *
 * On Cloud (the managed edition) the card asks for one goal and leaves mail for
 * last. Without a goal from the signup, three plain buttons each post "I want
 * to start with ..." in this conversation: a message, never a dialog, and the
 * buttons go once the person has written here. A self-hosted card is unchanged.
 *
 * The checklist is live: the row's snapshot shows first, then the card reads
 * GET /api/first-run/checklist when it opens, whenever a message lands in this
 * conversation (a step done through the agent, an approval decided) and when
 * the tab comes back into view (a step done elsewhere, an invitation sent from
 * Settings). A failed read keeps what the card showed.
 */
import { isKickoffGoal, KICKOFF_GOALS, type KickoffGoal } from "@liaison/shared"
import { ExternalLink } from "lucide-solid"
import {
  type Component,
  createEffect,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { purchaseSurfacesHidden } from "~/lib/native-bridge"
import {
  readSetupState,
  SetupChecklistCard,
  type SetupStateView,
} from "~/modules/agent/SetupChecklistCard"
import { userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import SecretRequestToolCard from "~/modules/secret-request/SecretRequestToolCard"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { messageStore } from "~/modules/threads/message-store"
import {
  releaseHeldScopes,
  sendFailureToast,
  sendThreadMessage,
} from "~/modules/threads/thread-send"
import { Button } from "~/ui/Button"

export interface SetupKickoffView {
  state: SetupStateView
  demoUrl: string | null
  secretRequestId: string | null
  /** Cloud (the managed edition): goal first, mail last. */
  managed: boolean
  /** Cloud: the goal chosen at signup, or null. */
  goal: KickoffGoal | null
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
  return {
    state,
    demoUrl,
    secretRequestId,
    managed: meta.managed === true,
    goal: meta.managed === true && isKickoffGoal(meta.goal) ? meta.goal : null,
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** How many messages this conversation holds: one more, the checklist is read again. */
function messageCount(threadId: string): number {
  return messageStore.threads[threadId]?.ids.length ?? 0
}

/** Someone wrote in this conversation: the goal is in their own words now. */
function personWrote(threadId: string): boolean {
  const thread = messageStore.threads[threadId]
  if (!thread) return false
  return thread.ids.some((id) => thread.byId[id]?.authorType === "user")
}

export const SetupKickoffRow: Component<{
  messageId: string
  threadId: string
  view: SetupKickoffView
}> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [sending, setSending] = createSignal(false)
  const [chosen, setChosen] = createSignal(false)
  const heldTurnScopes = new Set<() => void>()
  onCleanup(() => releaseHeldScopes(heldTurnScopes))

  // The checklist as it is now; until the first read lands, the row's snapshot.
  const [live, setLive] = createSignal<SetupStateView | null>(null)
  let reading = false
  let again = false
  const readChecklist = async (): Promise<void> => {
    if (reading) {
      again = true
      return
    }
    reading = true
    try {
      const state = readSetupState(await api.get<unknown>("/first-run/checklist"))
      if (state) setLive(state)
    } catch {
      // Keep what the card shows; the next message or return to the tab reads again.
    } finally {
      reading = false
      if (again) {
        again = false
        void readChecklist()
      }
    }
  }
  const checklist = (): SetupStateView => live() ?? props.view.state
  onMount(() => {
    void readChecklist()
    const onVisible = () => {
      if (document.visibilityState === "visible") void readChecklist()
    }
    document.addEventListener("visibilitychange", onVisible)
    onCleanup(() => document.removeEventListener("visibilitychange", onVisible))
  })
  createEffect(
    on(
      () => messageCount(props.threadId),
      () => void readChecklist(),
      { defer: true },
    ),
  )

  const intro = () => {
    if (!props.view.managed) return i18n.t("first-run.kickoff.intro")
    const goal = props.view.goal
    return goal
      ? i18n.t(`first-run.kickoff.introManagedGoal.${goal}`)
      : i18n.t("first-run.kickoff.introManaged")
  }
  const askGoal = () =>
    props.view.managed && !props.view.goal && !chosen() && !personWrote(props.threadId)

  /** Post one line as the person in this conversation: a message, never a dialog. */
  const say = async (text: string): Promise<boolean> => {
    const user = userFromToken()
    if (!user || sending()) return false
    setSending(true)
    try {
      await sendThreadMessage(
        api,
        props.threadId,
        text,
        { id: user.userId, name: user.name },
        {},
        heldTurnScopes,
      )
      return true
    } catch (err) {
      addToast(sendFailureToast(err, i18n.t))
      return false
    } finally {
      setSending(false)
    }
  }

  const choose = async (goal: KickoffGoal): Promise<void> => {
    if (await say(i18n.t(`first-run.kickoff.goalMessage.${goal}`))) setChosen(true)
  }

  return (
    <div
      data-testid="setup-kickoff-row"
      data-message-id={props.messageId}
      class="mt-3 flex flex-col gap-1 px-1 text-[13px]"
    >
      <h3 class="text-[14px] font-semibold text-text-primary">
        {i18n.t("first-run.kickoff.title")}
      </h3>
      <p class="text-text-secondary">{intro()}</p>
      <Show when={askGoal()}>
        <div data-testid="setup-goal-choices" class="mt-1 flex flex-wrap gap-2">
          <For each={KICKOFF_GOALS}>
            {(goal) => (
              <Button
                variant="outline"
                size="sm"
                data-testid={`setup-goal-${goal}`}
                disabled={sending()}
                onClick={() => void choose(goal)}
              >
                {i18n.t(`first-run.kickoff.goal.${goal}`)}
              </Button>
            )}
          </For>
        </div>
      </Show>
      <SetupChecklistCard
        state={checklist()}
        starting={sending()}
        onStart={(step) => void say(i18n.t("first-run.checklist.startMessage", { step }))}
      />
      <Show when={props.view.secretRequestId}>
        {(id) => (
          <>
            <p class="text-text-secondary">{i18n.t("first-run.kickoff.keyFirst")}</p>
            <SecretRequestToolCard requestId={id()} />
          </>
        )}
      </Show>
      {/* The demo leads to a paid signup: never linked from the iOS app (3.1.1). */}
      <Show when={!purchaseSurfacesHidden() && props.view.demoUrl}>
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
