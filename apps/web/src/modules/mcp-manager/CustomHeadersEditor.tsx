// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Custom headers for a bearer or no-auth MCP connection (S28): sent on every
// request. Values are write-only: the server keeps them encrypted and returns
// only the names, so a saved header shows its name and an empty value field
// that replaces it when typed in. The editor reports a patch in the API's
// shape: a value sets a header, null removes a saved one, names left out stay.
import { type Component, createSignal, For, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"

export type HeaderPatch = Record<string, string | null>

interface HeaderRow {
  key: number
  name: string
  value: string
  /** Saved on the server: its name is fixed and its value unknown here. */
  saved: boolean
  removed: boolean
}

/** The patch the rows describe. Blank new rows and untouched saved ones say nothing. */
export function headerPatchOf(rows: readonly HeaderRow[]): HeaderPatch {
  const patch: HeaderPatch = {}
  for (const r of rows) {
    const name = r.name.trim()
    if (!name) continue
    if (r.saved && r.removed) patch[name] = null
    else if (r.value !== "") patch[name] = r.value
  }
  return patch
}

export const CustomHeadersEditor: Component<{
  savedNames?: string[]
  onChange: (patch: HeaderPatch) => void
}> = (props) => {
  const i18n = useI18n()
  const [nextKey, setNextKey] = createSignal(0)
  const take = () => {
    const k = nextKey()
    setNextKey(k + 1)
    return k
  }
  const [rows, setRows] = createStore<HeaderRow[]>(
    (props.savedNames ?? []).map((name) => ({
      key: take(),
      name,
      value: "",
      saved: true,
      removed: false,
    })),
  )
  const emit = () => props.onChange(headerPatchOf(rows))
  const update = (key: number, fn: (r: HeaderRow) => void) => {
    setRows(
      (r) => r.key === key,
      produce((r) => fn(r)),
    )
    emit()
  }

  return (
    <div class="flex flex-col gap-2" data-testid="mcp-headers">
      <span class="text-[12.5px] font-medium text-text">{i18n.t("kernel.mcpUi.headersLabel")}</span>
      <For each={rows}>
        {(row, i) => (
          <div class="flex items-center gap-2" data-testid={`mcp-header-row-${i()}`}>
            <input
              data-testid={`mcp-header-name-${i()}`}
              aria-label={i18n.t("kernel.mcpUi.headerName")}
              class="w-40 min-w-0 rounded border border-border bg-bg px-2 py-1 font-mono text-xs disabled:opacity-70"
              classList={{ "line-through": row.removed }}
              placeholder={i18n.t("kernel.mcpUi.headerNamePlaceholder")}
              value={row.name}
              disabled={row.saved}
              spellcheck={false}
              autocomplete="off"
              onInput={(e) => update(row.key, (r) => (r.name = e.currentTarget.value))}
            />
            <input
              type="password"
              data-testid={`mcp-header-value-${i()}`}
              aria-label={i18n.t("kernel.mcpUi.headerValue")}
              class="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 font-mono text-xs"
              placeholder={row.saved ? i18n.t("kernel.mcpUi.headerSavedPlaceholder") : ""}
              value={row.value}
              disabled={row.removed}
              autocomplete="new-password"
              onInput={(e) => update(row.key, (r) => (r.value = e.currentTarget.value))}
            />
            <Show
              when={row.saved}
              fallback={
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid={`mcp-header-remove-${i()}`}
                  onClick={() => {
                    setRows((all) => all.filter((r) => r.key !== row.key))
                    emit()
                  }}
                >
                  {i18n.t("kernel.mcpUi.headerRemove")}
                </Button>
              }
            >
              <Button
                size="sm"
                variant="ghost"
                data-testid={`mcp-header-remove-${i()}`}
                onClick={() => update(row.key, (r) => (r.removed = !r.removed))}
              >
                {row.removed
                  ? i18n.t("kernel.mcpUi.headerKeep")
                  : i18n.t("kernel.mcpUi.headerRemove")}
              </Button>
            </Show>
          </div>
        )}
      </For>
      <div>
        <Button
          size="sm"
          variant="outline"
          data-testid="mcp-header-add"
          onClick={() =>
            setRows(rows.length, { key: take(), name: "", value: "", saved: false, removed: false })
          }
        >
          + {i18n.t("kernel.mcpUi.headerAdd")}
        </Button>
      </div>
      <span class="text-xs text-text-secondary">{i18n.t("kernel.mcpUi.headersHint")}</span>
    </div>
  )
}
