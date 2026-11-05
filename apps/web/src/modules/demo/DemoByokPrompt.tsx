// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Paste your own model key so the agents work."
//
// THE KEY BELONGS TO THE ONE VISITOR WHO OWNS THIS WORKSPACE. It is written to
// `POST /api/settings/ai/keys`, which stores it in `organizations.settings`,
// which is ORG level. Every workspace on this instance is a workspace one
// visitor created for themselves, so org level and visitor level are the same
// thing here and nobody else can spend what they paste.
//
// WHY A KEY. Agents here run on this box's key only for a confirmed address
// and within a small budget. A key of the visitor's own lifts both: it is
// spent instead of the box's, with no budget from us.
//
// TWO PLACEMENTS. In the welcome popup's step 1, opened in place by "Use your
// own model key instead" (DemoWelcome.tsx), and on the budget page
// (`standalone`).
//
// WHETHER A KEY IS NEEDED IS THE SERVER'S ANSWER. `GET /credits/models` lists
// the models this org can actually run; an empty list means no usable key, and
// then the prompt is offered whatever this browser remembers (a "saved" flag
// from an earlier workspace, a record lost from storage). Without that answer
// yet, the local flags decide, as they always did.
import { type Component, createEffect, createSignal, For, type JSX, Show } from "solid-js"
import {
  availableModelIds,
  ensureAvailableModels,
  refreshAvailableModels,
} from "~/modules/agent/credits/credits-store"
import { demoByokSaved, demoWorkspace, markDemoByokSaved } from "~/modules/demo/demo-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { Input } from "~/ui/Input"

/** Mirrors the providers the keys route accepts (settings/ai-keys-routes.ts). */
export const DEMO_BYOK_PROVIDERS = [
  { id: "anthropic", name: "Anthropic" },
  { id: "openai", name: "OpenAI" },
  { id: "google", name: "Google" },
  { id: "mistral", name: "Mistral" },
  { id: "openrouter", name: "OpenRouter" },
] as const
const PROVIDERS = DEMO_BYOK_PROVIDERS

/**
 * Should the visitor be offered the key prompt? Yes whenever the server says
 * this org has no model it can run (an empty `GET /credits/models`), whatever
 * this browser remembers. Until that answer lands, the local record decides:
 * a workspace this browser created, with no key saved in it yet.
 */
export function demoKeyWanted(): boolean {
  const ids = availableModelIds()
  if (ids !== null) return ids.size === 0
  return demoWorkspace() !== null && !demoByokSaved()
}

export interface DemoByokPromptProps {
  /** On the budget page: always shown, no title, no card chrome. */
  standalone?: boolean
  /** Beside Save (the welcome popup's "Use the email code instead"). */
  children?: JSX.Element
}

export const DemoByokPrompt: Component<DemoByokPromptProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [provider, setProvider] = createSignal<string>(PROVIDERS[0].id)
  const [key, setKey] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal("")
  /** The success line, shown in place of the form until the visitor closes it. */
  const [justSaved, setJustSaved] = createSignal(false)

  // Only once the workspace is usable: asking for a key over a half-seeded
  // workspace competes with the thing the visitor came to look at. With no
  // record in this browser there is no seed state to wait on.
  const ready = () => {
    const ws = demoWorkspace()
    return ws === null || ws.state !== "provisioning"
  }
  createEffect(() => {
    if (ready()) void ensureAvailableModels(api)
  })
  const visible = () => props.standalone === true || (ready() && (justSaved() || demoKeyWanted()))

  async function save(event: Event): Promise<void> {
    event.preventDefault()
    if (saving() || key().trim() === "") return
    setSaving(true)
    setError("")
    try {
      await api.post(
        "/settings/ai/keys",
        { provider: provider(), apiKey: key().trim() },
        { suppressGlobalError: true },
      )
      setJustSaved(true)
      setKey("")
      markDemoByokSaved()
      // The picker must offer the new key's models now, not after a reload.
      void refreshAvailableModels(api)
    } catch (err) {
      setError((err as { message?: string })?.message || i18n.t("kernel.demo.byokFailed"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Show when={visible()}>
      <form
        data-testid={props.standalone ? "demo-byok-standalone" : "demo-byok"}
        onSubmit={(e) => void save(e)}
        class={
          props.standalone
            ? "@container flex flex-col gap-2"
            : "@container flex flex-col gap-2 rounded-lg border border-border bg-surface p-3"
        }
      >
        <Show when={justSaved()}>
          <div class="flex items-center justify-between gap-3">
            <p data-testid="demo-byok-saved" class="text-[13px] text-text">
              {i18n.t("kernel.demo.byokSaved")}
            </p>
            <button
              type="button"
              data-testid="demo-byok-close"
              onClick={() => setJustSaved(false)}
              class="shrink-0 text-[12px] text-text-secondary underline underline-offset-2 hover:text-text"
            >
              {i18n.t("kernel.dismiss")}
            </button>
          </div>
        </Show>
        <Show when={!justSaved()}>
          <Show when={!props.standalone}>
            <div class="flex flex-col gap-0.5">
              <p class="text-[13px] font-medium text-text">{i18n.t("kernel.demo.byokTitle")}</p>
              <p class="text-[12px] leading-snug text-text-secondary">
                {i18n.t("kernel.demo.byokBody")}
              </p>
            </div>
          </Show>
          {/* One row only where the FORM is wide enough, never because the
              screen is: inside the 440 px welcome popup on a desktop the row
              squeezed the key field to a sliver under Save key (walk D72).
              When it is one row, the field keeps a usable width and the
              buttons wrap below it. */}
          <div class="flex flex-col gap-2 @md:flex-row @md:flex-wrap @md:items-center">
            <select
              data-testid="demo-byok-provider"
              aria-label={i18n.t("kernel.demo.byokProvider")}
              value={provider()}
              onChange={(e) => setProvider(e.currentTarget.value)}
              class="h-8 rounded-sm border border-border bg-bg px-2 text-[13px] text-text @md:w-36 @md:shrink-0"
            >
              <For each={PROVIDERS}>{(p) => <option value={p.id}>{p.name}</option>}</For>
            </select>
            <div class="min-w-0 flex-1 @md:min-w-48">
              <Input
                type="password"
                value={key()}
                data-testid="demo-byok-key"
                placeholder={i18n.t("kernel.demo.byokKeyLabel")}
                autocomplete="off"
                onInput={(e) => setKey(e.currentTarget.value)}
              />
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <Button
                type="submit"
                size="sm"
                data-testid="demo-byok-save"
                loading={saving()}
                disabled={saving() || key().trim() === ""}
              >
                {i18n.t("kernel.demo.byokSave")}
              </Button>
              {props.children}
            </div>
          </div>
          <Show when={error()}>
            <p data-testid="demo-byok-error" role="alert" class="text-[12px] text-error">
              {error()}
            </p>
          </Show>
        </Show>
      </form>
    </Show>
  )
}
