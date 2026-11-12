// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Add a connection, or replace its adapter: a slug (fixed when replacing) and
// the adapter document, pasted or loaded from a .yaml/.json file. The server
// validates; each refusal comes back at its path and is listed under the
// document, path first, so the author can find it. A replacement that points
// the connection at another address or auth type deletes its stored
// credentials: the server refuses it until confirmed, and the form shows that
// warning with both targets and a button that saves anyway.

import {
  type AdapterIssue,
  CONNECTION_SLUG_PATTERN,
  type ConnectionSummary,
} from "@liaison/api-connector-core/contract"
import { type Component, createSignal, For, Show } from "solid-js"
import { putAdapter, useApi } from "./api"
import { Button, Input, useI18n } from "./kit"

export const AdapterForm: Component<{
  /** Replacing this connection's adapter; absent when adding a new one. */
  identifier?: string
  onSaved: (summary: ConnectionSummary) => void
  onCancel: () => void
}> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [slug, setSlug] = createSignal(props.identifier ?? "")
  const [text, setText] = createSignal("")
  const [slugError, setSlugError] = createSignal(false)
  const [issues, setIssues] = createSignal<AdapterIssue[]>([])
  const [failed, setFailed] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [wipe, setWipe] = createSignal<{ priorTarget: string; newTarget: string } | null>(null)

  async function loadFile(file: File | undefined): Promise<void> {
    if (!file) return
    setText(await file.text())
  }

  async function save(e?: Event, confirmCredentialWipe = false): Promise<void> {
    e?.preventDefault()
    const identifier = slug().trim()
    setIssues([])
    setFailed(false)
    setWipe(null)
    if (!CONNECTION_SLUG_PATTERN.test(identifier)) {
      setSlugError(true)
      return
    }
    setSlugError(false)
    if (!text().trim()) {
      setIssues([{ path: "", message: i18n.t("api-connector.settings.adapterEmpty") }])
      return
    }
    setSaving(true)
    try {
      const outcome = await putAdapter(api, identifier, text(), { confirmCredentialWipe })
      if (outcome.ok) props.onSaved(outcome.summary)
      else if ("wipe" in outcome) setWipe(outcome.wipe)
      else setIssues(outcome.issues)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      data-testid="api-connector-adapter-form"
      class="flex flex-col gap-3 rounded-sm border border-border p-3"
      onSubmit={(e) => void save(e)}
    >
      <h3 class="text-xs font-semibold">
        {props.identifier
          ? i18n.t("api-connector.settings.replaceTitle", { identifier: props.identifier })
          : i18n.t("api-connector.settings.addTitle")}
      </h3>
      <Show when={!props.identifier}>
        <Input
          data-testid="api-connector-slug"
          label={i18n.t("api-connector.settings.slugLabel")}
          placeholder={i18n.t("api-connector.settings.slugPlaceholder")}
          value={slug()}
          autocapitalize="off"
          autocorrect="off"
          spellcheck={false}
          onInput={(e) => setSlug(e.currentTarget.value)}
        />
        <p class="-mt-2 text-xs text-text-tertiary">{i18n.t("api-connector.settings.slugHint")}</p>
        <Show when={slugError()}>
          <p data-testid="api-connector-slug-error" class="text-xs text-error">
            {i18n.t("api-connector.settings.slugInvalid")}
          </p>
        </Show>
      </Show>

      <label class="flex flex-col gap-1.5 text-[12.5px] font-medium text-text-secondary">
        <span>{i18n.t("api-connector.settings.adapterLabel")}</span>
        <textarea
          data-testid="api-connector-adapter-text"
          class="min-h-48 w-full rounded-sm border border-border bg-bg px-3 py-2 font-mono text-xs text-text outline-none focus:border-accent-muted"
          spellcheck={false}
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
        />
      </label>
      <label class="flex items-center gap-2 text-xs text-text-secondary">
        <span>{i18n.t("api-connector.settings.adapterFile")}</span>
        <input
          data-testid="api-connector-adapter-file"
          type="file"
          accept=".yaml,.yml,.json,application/json,application/yaml,text/yaml"
          class="text-xs"
          onChange={(e) => void loadFile(e.currentTarget.files?.[0])}
        />
      </label>

      <Show when={issues().length > 0}>
        <ul
          data-testid="api-connector-issues"
          class="flex flex-col gap-1 rounded-sm border border-border bg-surface-sunken p-2 text-xs"
        >
          <For each={issues()}>
            {(issue) => (
              <li data-testid="api-connector-issue" data-path={issue.path} class="flex gap-2">
                <code class="shrink-0 text-text-secondary">
                  {issue.path || i18n.t("api-connector.settings.issueDocument")}
                </code>
                <span class="text-text">{issue.message}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={wipe()}>
        {(w) => (
          <div
            data-testid="api-connector-wipe-warning"
            class="flex flex-wrap items-center gap-2 rounded-sm bg-surface-sunken p-2 text-xs"
          >
            <span class="text-text">
              {i18n.t("api-connector.settings.wipeWarning", {
                from: w().priorTarget,
                to: w().newTarget,
              })}
            </span>
            <Button
              type="button"
              size="sm"
              variant="danger"
              data-testid="api-connector-adapter-save-confirm"
              loading={saving()}
              onClick={() => void save(undefined, true)}
            >
              {i18n.t("api-connector.settings.saveAnyway")}
            </Button>
          </div>
        )}
      </Show>
      <Show when={failed()}>
        <p data-testid="api-connector-adapter-error" class="text-xs text-error">
          {i18n.t("api-connector.settings.saveFailed")}
        </p>
      </Show>

      <div class="flex gap-2">
        <Button type="submit" size="sm" data-testid="api-connector-adapter-save" loading={saving()}>
          {i18n.t("api-connector.settings.saveAdapter")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid="api-connector-adapter-cancel"
          onClick={() => props.onCancel()}
        >
          {i18n.t("kernel.common.cancel")}
        </Button>
      </div>
    </form>
  )
}
