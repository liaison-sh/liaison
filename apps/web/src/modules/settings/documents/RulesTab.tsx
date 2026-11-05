// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Rules tab: the rules that say a record needs this template (api
// modules/documents/rules-store.ts). A rule matches a record when every
// condition it lists holds (any of the SKUs, any of the countries, any of the
// carriers). Rules are added, edited and deleted inline; the server checks
// them and its refusal shows here.

import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { Switch } from "~/ui/Switch"
import {
  createRule,
  type DocumentTemplate,
  type DocumentTemplateRule,
  deleteRule,
  type InlineError,
  inlineError,
  listRules,
  updateRule,
  whenFrom,
} from "./documents-api"

const INPUT =
  "w-full rounded-sm border border-border bg-bg px-2.5 py-1.5 text-[13px] text-text focus-visible:outline-2 focus-visible:outline-accent"

interface Draft {
  name: string
  sku: string
  countryIso2: string
  carrier: string
  note: string
}

const EMPTY: Draft = { name: "", sku: "", countryIso2: "", carrier: "", note: "" }

function draftOf(rule: DocumentTemplateRule): Draft {
  return {
    name: rule.name,
    sku: (rule.when.sku ?? []).join(", "),
    countryIso2: (rule.when.countryIso2 ?? []).join(", "),
    carrier: (rule.when.carrier ?? []).join(", "),
    note: rule.note ?? "",
  }
}

const RuleForm: Component<{
  initial: Draft
  testId: string
  busy: boolean
  submitLabel: string
  onSubmit: (d: Draft) => void
  onCancel: () => void
}> = (props) => {
  const i18n = useI18n()
  const [draft, setDraft] = createSignal<Draft>({ ...props.initial })
  const field = (key: keyof Draft, label: string, hint?: string) => (
    <label class="block text-[12.5px] text-text-secondary">
      {label}
      <input
        class={INPUT}
        value={draft()[key]}
        onInput={(e) => {
          const value = e.currentTarget.value
          setDraft((d) => ({ ...d, [key]: value }))
        }}
        data-testid={`${props.testId}-${key}`}
      />
      <Show when={hint}>
        <span class="mt-0.5 block text-[12px]">{hint}</span>
      </Show>
    </label>
  )
  return (
    <div class="space-y-2 rounded-md border border-border-subtle p-3" data-testid={props.testId}>
      {field("name", i18n.t("kernel.documentsUi.ruleName"))}
      {field(
        "sku",
        i18n.t("kernel.documentsUi.ruleSku"),
        i18n.t("kernel.documentsUi.ruleValuesHint"),
      )}
      {field(
        "countryIso2",
        i18n.t("kernel.documentsUi.ruleCountries"),
        i18n.t("kernel.documentsUi.ruleCountriesHint"),
      )}
      {field("carrier", i18n.t("kernel.documentsUi.ruleCarriers"))}
      {field("note", i18n.t("kernel.documentsUi.ruleNote"))}
      <div class="flex gap-2">
        <Button
          size="sm"
          loading={props.busy}
          disabled={props.busy}
          onClick={() => props.onSubmit(draft())}
          data-testid={`${props.testId}-save`}
        >
          {props.submitLabel}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => props.onCancel()}>
          {i18n.t("kernel.documentsUi.cancel")}
        </Button>
      </div>
    </div>
  )
}

export const RulesTab: Component<{ template: DocumentTemplate }> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [rules, { refetch }] = createResource(
    () => props.template.recordType,
    async (recordType) => {
      const all = await listRules(api, recordType)
      return all.filter((r) => r.templateIds.includes(props.template.id))
    },
  )
  const [adding, setAdding] = createSignal(false)
  const [editing, setEditing] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<InlineError | null>(null)

  async function act(fn: () => Promise<unknown>, after: () => void) {
    setError(null)
    setBusy(true)
    try {
      await fn()
      after()
      await refetch()
    } catch (err) {
      setError(inlineError(err, i18n.t("kernel.documentsUi.ruleSaveFailed")))
    } finally {
      setBusy(false)
    }
  }

  function add(d: Draft) {
    const recordType = props.template.recordType
    if (!recordType) return
    void act(
      () =>
        createRule(api, {
          recordType,
          name: d.name.trim(),
          when: whenFrom(d),
          templateIds: [props.template.id],
          note: d.note.trim() || null,
          enabled: true,
        }),
      () => setAdding(false),
    )
  }

  function save(rule: DocumentTemplateRule, d: Draft) {
    void act(
      () =>
        updateRule(api, rule.id, {
          name: d.name.trim(),
          when: whenFrom(d),
          note: d.note.trim() || null,
        }),
      () => setEditing(null),
    )
  }

  const summary = (rule: DocumentTemplateRule) => {
    const parts: string[] = []
    if (rule.when.sku?.length)
      parts.push(i18n.t("kernel.documentsUi.ruleWhenSku", { values: rule.when.sku.join(", ") }))
    if (rule.when.countryIso2?.length)
      parts.push(
        i18n.t("kernel.documentsUi.ruleWhenCountry", { values: rule.when.countryIso2.join(", ") }),
      )
    if (rule.when.carrier?.length)
      parts.push(
        i18n.t("kernel.documentsUi.ruleWhenCarrier", { values: rule.when.carrier.join(", ") }),
      )
    return parts.join(i18n.t("kernel.documentsUi.ruleAnd"))
  }

  return (
    <div class="space-y-3" data-testid="documents-rules">
      <p class="text-[12.5px] text-text-secondary">{i18n.t("kernel.documentsUi.rulesIntro")}</p>
      <Show
        when={props.template.recordType}
        fallback={
          <p class="text-[12.5px] text-text-secondary" data-testid="documents-rules-no-record-type">
            {i18n.t("kernel.documentsUi.rulesNeedRecordType")}
          </p>
        }
      >
        <Show
          when={(rules() ?? []).length > 0}
          fallback={
            <p class="text-[13px] text-text-secondary" data-testid="documents-rules-empty">
              {rules.loading
                ? i18n.t("kernel.common.loading2")
                : i18n.t("kernel.documentsUi.noRules")}
            </p>
          }
        >
          <ul class="space-y-2">
            <For each={rules()}>
              {(rule) => (
                <li data-testid={`documents-rule-${rule.id}`}>
                  <Show
                    when={editing() === rule.id}
                    fallback={
                      <div class="flex items-start gap-3 rounded-md border border-border-subtle p-2.5 text-[12.5px]">
                        <div class="flex-1">
                          <p class="font-medium text-text">{rule.name}</p>
                          <p
                            class="text-text-secondary"
                            data-testid={`documents-rule-${rule.id}-when`}
                          >
                            {summary(rule)}
                          </p>
                          <Show when={rule.templateIds.length > 1}>
                            <p class="text-text-secondary">
                              {i18n.t("kernel.documentsUi.ruleOtherTemplates", {
                                n: rule.templateIds.length - 1,
                              })}
                            </p>
                          </Show>
                          <Show when={rule.note}>
                            <p class="text-text-secondary">{rule.note}</p>
                          </Show>
                        </div>
                        <Switch
                          checked={rule.enabled}
                          label={i18n.t("kernel.documentsUi.ruleEnabled")}
                          onChange={(next) =>
                            void act(
                              () => updateRule(api, rule.id, { enabled: next }),
                              () => {},
                            )
                          }
                          data-testid={`documents-rule-${rule.id}-enabled`}
                        />
                        <button
                          type="button"
                          class="text-text-secondary underline-offset-2 hover:underline"
                          onClick={() => setEditing(rule.id)}
                          data-testid={`documents-rule-${rule.id}-edit`}
                        >
                          {i18n.t("kernel.documentsUi.edit")}
                        </button>
                        <button
                          type="button"
                          class="text-text-secondary underline-offset-2 hover:underline"
                          onClick={() =>
                            void act(
                              () => deleteRule(api, rule.id),
                              () => {},
                            )
                          }
                          data-testid={`documents-rule-${rule.id}-delete`}
                        >
                          {i18n.t("kernel.documentsUi.delete")}
                        </button>
                      </div>
                    }
                  >
                    <RuleForm
                      initial={draftOf(rule)}
                      testId={`documents-rule-${rule.id}-form`}
                      busy={busy()}
                      submitLabel={i18n.t("kernel.documentsUi.save")}
                      onSubmit={(d) => save(rule, d)}
                      onCancel={() => setEditing(null)}
                    />
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show
          when={adding()}
          fallback={
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAdding(true)}
              data-testid="documents-rules-add"
            >
              {i18n.t("kernel.documentsUi.addRule")}
            </Button>
          }
        >
          <RuleForm
            initial={EMPTY}
            testId="documents-rules-new"
            busy={busy()}
            submitLabel={i18n.t("kernel.documentsUi.addRule")}
            onSubmit={add}
            onCancel={() => setAdding(false)}
          />
        </Show>
      </Show>
      <Show when={error()}>
        {(e) => (
          <p class="text-[12.5px] text-error" role="alert" data-testid="documents-rules-error">
            {e().message}
          </p>
        )}
      </Show>
    </div>
  )
}
