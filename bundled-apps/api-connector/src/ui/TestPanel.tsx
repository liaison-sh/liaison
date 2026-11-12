// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Try one READ operation against the live system: pick it, fill its params
// (a form generated from its JSON Schema), run it, see the HTTP status, the
// time it took and the items it returned, already projected to the adapter's
// allow-listed fields. Write operations are never offered here: the route
// refuses them, and a write only ever runs through an approval.

import type {
  ConnectionSummary,
  ProjectedObject,
  TestOperationResult,
} from "@liaison/api-connector-core/contract"
import { type Component, createMemo, createSignal, For, Show } from "solid-js"
import { ApiError } from "./api"
import { useI18n } from "./kit"
import { useApi } from "./api"
import { Button } from "./kit"
import { testOperation } from "./api"
import { flattenRecord } from "./customer-format"
import {
  buildParams,
  type ParamError,
  type ParamField,
  paramFields,
  type RawParams,
} from "./params-form"

/** Error codes the test route answers with; anything else reads as a generic failure. */
const KNOWN_ERRORS = new Set([
  "upstream_status",
  "timeout",
  "too_large",
  "invalid_response",
  "host_refused",
  "not_configured",
  "write_not_testable",
])

/**
 * A failed test as the panel shows it: the stable code, and for an upstream
 * error the HTTP status the system answered (the admin panel may name it;
 * the body is never shown).
 */
interface TestFailure {
  code: string
  upstreamStatus: number | null
}

/** The catalog plural form (`one` / `other`) of `count` in `locale`. */
function pluralForm(locale: string, count: number): "one" | "other" {
  return new Intl.PluralRules(locale).select(count) === "one" ? "one" : "other"
}

const inputClass =
  "w-full rounded-sm border border-border bg-bg px-2 py-1 text-xs text-text outline-none focus:border-accent-muted"

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (Array.isArray(value)) return value.map(String).join(", ")
  return String(value)
}

/** Columns: the adapter's allow-list order when known, then any other path seen. */
function columnsOf(items: ProjectedObject[], fields: string[] | undefined): string[] {
  const seen: string[] = []
  for (const item of items) {
    for (const [path] of flattenRecord(item)) if (!seen.includes(path)) seen.push(path)
  }
  if (!fields || fields.length === 0) return seen
  const ordered = fields.filter((f) => seen.includes(f))
  return [...ordered, ...seen.filter((p) => !ordered.includes(p))]
}

export const TestPanel: Component<{ connection: ConnectionSummary }> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const reads = () => props.connection.operations.filter((op) => op.kind === "read")
  const [opName, setOpName] = createSignal(reads()[0]?.name ?? "")
  const operation = () => reads().find((op) => op.name === opName())
  const fields = createMemo<ParamField[]>(() => paramFields(operation()?.params))
  const [raw, setRaw] = createSignal<RawParams>({})
  const [errors, setErrors] = createSignal<Record<string, ParamError>>({})
  const [result, setResult] = createSignal<Extract<TestOperationResult, { ok: true }> | null>(null)
  const [failure, setFailure] = createSignal<TestFailure | null>(null)
  const [running, setRunning] = createSignal(false)

  const setParam = (name: string, value: string | boolean) =>
    setRaw((r) => ({ ...r, [name]: value }))

  function pick(name: string): void {
    setOpName(name)
    setRaw({})
    setErrors({})
    setResult(null)
    setFailure(null)
  }

  async function run(e: Event): Promise<void> {
    e.preventDefault()
    const op = operation()
    if (!op) return
    const built = buildParams(fields(), raw())
    if (!built.ok) {
      setErrors(built.errors)
      return
    }
    setErrors({})
    setResult(null)
    setFailure(null)
    setRunning(true)
    try {
      const outcome = await testOperation(api, props.connection.identifier, {
        operation: op.name,
        params: built.params,
      })
      // The upstream failed (status, timeout, cap...): the call itself was fine,
      // so it comes back as a result carrying the stable code.
      if (outcome.ok) setResult(outcome)
      else
        setFailure({
          code: KNOWN_ERRORS.has(outcome.code) ? outcome.code : "failed",
          upstreamStatus: outcome.code === "upstream_status" ? outcome.status : null,
        })
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined
      setFailure({ code: code && KNOWN_ERRORS.has(code) ? code : "failed", upstreamStatus: null })
    } finally {
      setRunning(false)
    }
  }

  const items = () => result()?.items ?? []
  const columns = createMemo(() => columnsOf(items(), operation()?.fields))

  return (
    <Show
      when={reads().length > 0}
      fallback={
        <p data-testid="api-connector-test-no-reads" class="text-xs text-text-secondary">
          {i18n.t("api-connector.settings.testNoReads")}
        </p>
      }
    >
      <form
        data-testid="api-connector-test-panel"
        class="flex flex-col gap-3"
        onSubmit={(e) => void run(e)}
      >
        <label class="flex flex-col gap-1 text-xs font-medium text-text-secondary">
          <span>{i18n.t("api-connector.settings.testOperation")}</span>
          <select
            data-testid="api-connector-test-operation"
            class={inputClass}
            value={opName()}
            onChange={(e) => pick(e.currentTarget.value)}
          >
            <For each={reads()}>
              {(op) => (
                <option value={op.name}>{op.role ? `${op.name} (${op.role})` : op.name}</option>
              )}
            </For>
          </select>
        </label>
        <Show when={operation()?.description}>
          {(text) => <p class="text-xs text-text-tertiary">{text()}</p>}
        </Show>

        <For each={fields()}>
          {(field) => (
            <div class="flex flex-col gap-1 text-xs">
              <Show
                when={field.kind === "boolean"}
                fallback={
                  <label class="flex flex-col gap-1 font-medium text-text-secondary">
                    <span>
                      {field.name}
                      {field.required ? " *" : ""}
                    </span>
                    <Show
                      when={field.kind === "enum"}
                      fallback={
                        <input
                          data-testid={`api-connector-param-${field.name}`}
                          class={inputClass}
                          inputmode={
                            field.kind === "number" || field.kind === "integer"
                              ? "decimal"
                              : undefined
                          }
                          placeholder={
                            field.kind === "array"
                              ? i18n.t("api-connector.settings.paramListHint")
                              : undefined
                          }
                          value={String(raw()[field.name] ?? "")}
                          onInput={(e) => setParam(field.name, e.currentTarget.value)}
                        />
                      }
                    >
                      <select
                        data-testid={`api-connector-param-${field.name}`}
                        class={inputClass}
                        value={String(raw()[field.name] ?? "")}
                        onChange={(e) => setParam(field.name, e.currentTarget.value)}
                      >
                        <option value="" />
                        <For each={field.options ?? []}>
                          {(opt) => <option value={opt}>{opt}</option>}
                        </For>
                      </select>
                    </Show>
                  </label>
                }
              >
                <label class="flex items-center gap-2 font-medium text-text-secondary">
                  <input
                    data-testid={`api-connector-param-${field.name}`}
                    type="checkbox"
                    checked={raw()[field.name] === true}
                    onChange={(e) => setParam(field.name, e.currentTarget.checked)}
                  />
                  <span>{field.name}</span>
                </label>
              </Show>
              <Show when={field.description}>
                <span class="text-text-tertiary">{field.description}</span>
              </Show>
              <Show when={errors()[field.name]}>
                {(error) => (
                  <span data-testid={`api-connector-param-error-${field.name}`} class="text-error">
                    {i18n.t(`api-connector.settings.paramError.${error()}`)}
                  </span>
                )}
              </Show>
            </div>
          )}
        </For>

        <div>
          <Button type="submit" size="sm" data-testid="api-connector-test-run" loading={running()}>
            {i18n.t("api-connector.settings.testRun")}
          </Button>
        </div>

        <Show when={failure()}>
          {(f) => (
            <p data-testid="api-connector-test-error" class="text-xs text-error">
              {f().upstreamStatus !== null
                ? i18n.t("api-connector.settings.testUpstreamHttp", {
                    status: f().upstreamStatus ?? "",
                  })
                : i18n.t(`api-connector.settings.testError.${f().code}`)}
            </p>
          )}
        </Show>

        <Show when={result()}>
          {(r) => (
            <div data-testid="api-connector-test-result" class="flex flex-col gap-2 text-xs">
              <div class="flex flex-wrap gap-3 text-text-secondary">
                <span data-testid="api-connector-test-status">
                  {i18n.t("api-connector.settings.testStatus", { status: r().status })}
                </span>
                <span data-testid="api-connector-test-ms">
                  {i18n.t("api-connector.settings.testMs", { ms: i18n.fmtNumber(r().ms) })}
                </span>
                <span data-testid="api-connector-test-count">
                  {i18n.t(
                    `api-connector.settings.testCount.${pluralForm(i18n.locale(), items().length)}`,
                    { count: i18n.fmtNumber(items().length) },
                  )}
                </span>
              </div>
              <Show when={items().length > 0}>
                <div class="overflow-x-auto">
                  <table data-testid="api-connector-test-items" class="w-full text-left">
                    <thead>
                      <tr class="border-b border-border text-text-tertiary">
                        <For each={columns()}>
                          {(col) => <th class="px-2 py-1 font-medium">{col}</th>}
                        </For>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={items()}>
                        {(item) => {
                          const flat = Object.fromEntries(flattenRecord(item))
                          return (
                            <tr
                              data-testid="api-connector-test-row"
                              class="border-b border-border-subtle"
                            >
                              <For each={columns()}>
                                {(col) => (
                                  <td class="px-2 py-1 text-text">{cellText(flat[col])}</td>
                                )}
                              </For>
                            </tr>
                          )
                        }}
                      </For>
                    </tbody>
                  </table>
                </div>
              </Show>
            </div>
          )}
        </Show>
      </form>
    </Show>
  )
}
