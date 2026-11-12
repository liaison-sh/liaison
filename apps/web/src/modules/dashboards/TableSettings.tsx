// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A table's settings (the table page's Settings tab): its columns, who sees and edits it, and
// whether agents' row writes wait for approval. An editor's change applies at once (no approval
// for a person), each one PATCH at the table's version: a change saved meanwhile by someone else
// is refused, the table is read again and the person tries once more. A column's key never
// changes; its label, its choices and whether it exists do. Dropping a column keeps its values in
// the history. A viewer reads the same page without the controls.
import { type Component, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { Switch as Toggle } from "~/ui/Switch"
import { TableConfirmDialog } from "./blocks/TableConfirmDialog"
import { choicesFrom, columnKeyFrom } from "./blocks/table-cells"
import { DashboardShareDialog } from "./DashboardShareDialog"
import {
  getTable,
  patchTable,
  TABLE_COLUMN_TYPES,
  type TableColumn,
  type TableColumnType,
  type TableInfo,
  type TablePatch,
  type TablesApi,
  tableErrorFrom,
  tableSharingPath,
} from "./dashboards-client"

export interface TableSettingsProps {
  table: TableInfo
  /** The table as it is after a change (or after a reread). */
  onChanged: (table: TableInfo) => void
}

const FIELD =
  "h-8 min-w-0 rounded border border-border bg-bg px-2 text-[13px] text-text outline-none focus:border-accent"
const SECTION = "text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-tertiary"

export const TableSettings: Component<TableSettingsProps> = (props) => {
  const i18n = useI18n()
  const api = useApi() as unknown as TablesApi
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [renaming, setRenaming] = createSignal<string | null>(null)
  const [choosing, setChoosing] = createSignal<string | null>(null)
  const [dropping, setDropping] = createSignal<TableColumn | null>(null)
  const [sharing, setSharing] = createSignal(false)
  // The add-a-column form.
  const [newLabel, setNewLabel] = createSignal("")
  const [newType, setNewType] = createSignal<TableColumnType>("text")
  const [newRequired, setNewRequired] = createSignal(false)
  const [newChoices, setNewChoices] = createSignal("")
  const [newCurrency, setNewCurrency] = createSignal("EUR")

  const canEdit = () => props.table.myRole === "editor" || props.table.myRole === "owner"
  const typeLabel = (t: TableColumnType) => i18n.t(`kernel.dashboards.tables.type.${t}`)

  function describe(c: TableColumn): string {
    const parts = [typeLabel(c.type)]
    if (c.type === "amount" && c.currency) parts.push(c.currency)
    if ((c.type === "choice" || c.type === "choices") && c.choices?.length)
      parts.push(c.choices.join(", "))
    if (c.type === "link" && c.linkTo)
      parts.push(c.linkTo.entityType ? `${c.linkTo.app} ${c.linkTo.entityType}` : c.linkTo.app)
    if (c.required) parts.push(i18n.t("kernel.dashboards.tables.requiredTag"))
    return parts.join(" · ")
  }

  async function apply(patch: TablePatch): Promise<boolean> {
    setBusy(true)
    setError(null)
    try {
      props.onChanged(await patchTable(api, props.table.id, props.table.version, patch))
      return true
    } catch (err) {
      const e = tableErrorFrom(err)
      if (e.code === "version_conflict") {
        setError(i18n.t("kernel.dashboards.tables.settingsConflict"))
        await getTable(api, props.table.id)
          .then(props.onChanged)
          .catch(() => {})
      } else {
        setError(e.message ?? i18n.t("kernel.dashboards.tables.saveFailed"))
      }
      return false
    } finally {
      setBusy(false)
    }
  }

  async function addColumn(): Promise<void> {
    const label = newLabel().trim()
    if (!label) return
    const type = newType()
    const choices = choicesFrom(newChoices())
    if ((type === "choice" || type === "choices") && choices.length === 0) {
      setError(i18n.t("kernel.dashboards.tables.choicesNeeded"))
      return
    }
    const column: TableColumn = {
      key: columnKeyFrom(label, [
        ...props.table.columns.map((c) => c.key),
        ...(props.table.droppedKeys ?? []),
      ]),
      label,
      type,
      ...(newRequired() ? { required: true } : {}),
      ...(type === "choice" || type === "choices" ? { choices } : {}),
      ...(type === "amount" ? { currency: newCurrency().trim().toUpperCase() || "EUR" } : {}),
    }
    if (await apply({ columns: { add: [column] } })) {
      setNewLabel("")
      setNewChoices("")
      setNewRequired(false)
    }
  }

  return (
    <div data-testid="table-settings" class="flex max-w-3xl flex-col gap-6">
      <Show when={error()}>
        <p data-testid="table-settings-error" class="text-[12.5px] text-error">
          {error()}
        </p>
      </Show>

      <section class="flex flex-col gap-2">
        <h3 class={SECTION}>{i18n.t("kernel.dashboards.tables.columns")}</h3>
        <ul class="flex flex-col">
          <For each={props.table.columns}>
            {(c) => (
              <li
                data-testid={`table-settings-column-${c.key}`}
                class="flex flex-wrap items-center gap-2 border-b border-border-subtle py-2 text-[13px]"
              >
                <Show
                  when={renaming() === c.key}
                  fallback={<span class="min-w-0 flex-1 truncate text-text">{c.label}</span>}
                >
                  <form
                    class="flex min-w-0 flex-1 items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault()
                      const v = new FormData(e.currentTarget).get("label")?.toString().trim() ?? ""
                      if (!v || v === c.label) return setRenaming(null)
                      void apply({ columns: { rename: [{ key: c.key, label: v }] } }).then(
                        (ok) => ok && setRenaming(null),
                      )
                    }}
                  >
                    <input
                      name="label"
                      data-testid={`table-settings-rename-input-${c.key}`}
                      aria-label={i18n.t("kernel.dashboards.tables.columnLabel")}
                      value={c.label}
                      class={`${FIELD} flex-1`}
                    />
                    <Button
                      type="submit"
                      size="sm"
                      data-testid={`table-settings-rename-save-${c.key}`}
                      disabled={busy()}
                    >
                      {i18n.t("kernel.dashboards.tables.save")}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setRenaming(null)}>
                      {i18n.t("kernel.common.cancel")}
                    </Button>
                  </form>
                </Show>
                <span
                  data-testid={`table-settings-column-type-${c.key}`}
                  class="text-text-tertiary"
                >
                  {describe(c)}
                </span>
                <Show when={canEdit() && renaming() !== c.key}>
                  <div class="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid={`table-settings-rename-${c.key}`}
                      disabled={busy()}
                      onClick={() => setRenaming(c.key)}
                    >
                      {i18n.t("kernel.dashboards.tables.rename")}
                    </Button>
                    <Show when={c.type === "choice" || c.type === "choices"}>
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid={`table-settings-choices-${c.key}`}
                        disabled={busy()}
                        onClick={() => setChoosing(choosing() === c.key ? null : c.key)}
                      >
                        {i18n.t("kernel.dashboards.tables.editChoices")}
                      </Button>
                    </Show>
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid={`table-settings-drop-${c.key}`}
                      disabled={busy()}
                      onClick={() => setDropping(c)}
                    >
                      {i18n.t("kernel.dashboards.tables.drop")}
                    </Button>
                  </div>
                </Show>
                <Show when={choosing() === c.key}>
                  <form
                    class="flex w-full items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault()
                      const raw = new FormData(e.currentTarget).get("choices")?.toString() ?? ""
                      const list = choicesFrom(raw)
                      if (list.length === 0)
                        return setError(i18n.t("kernel.dashboards.tables.choicesNeeded"))
                      void apply({ columns: { setChoices: [{ key: c.key, choices: list }] } }).then(
                        (ok) => ok && setChoosing(null),
                      )
                    }}
                  >
                    <input
                      name="choices"
                      data-testid={`table-settings-choices-input-${c.key}`}
                      aria-label={i18n.t("kernel.dashboards.tables.choicesHint")}
                      value={(c.choices ?? []).join(", ")}
                      class={`${FIELD} flex-1`}
                    />
                    <Button
                      type="submit"
                      size="sm"
                      data-testid={`table-settings-choices-save-${c.key}`}
                      disabled={busy()}
                    >
                      {i18n.t("kernel.dashboards.tables.save")}
                    </Button>
                  </form>
                </Show>
              </li>
            )}
          </For>
        </ul>

        <Show when={canEdit()}>
          <form
            data-testid="table-settings-add-column"
            class="flex flex-wrap items-end gap-2 pt-1"
            onSubmit={(e) => {
              e.preventDefault()
              void addColumn()
            }}
          >
            <label class="flex flex-col gap-1 text-[11.5px] text-text-secondary">
              {i18n.t("kernel.dashboards.tables.columnLabel")}
              <input
                data-testid="table-settings-new-label"
                class={FIELD}
                value={newLabel()}
                onInput={(e) => setNewLabel(e.currentTarget.value)}
              />
            </label>
            <label class="flex flex-col gap-1 text-[11.5px] text-text-secondary">
              {i18n.t("kernel.dashboards.tables.columnType")}
              <select
                data-testid="table-settings-new-type"
                class={FIELD}
                value={newType()}
                onChange={(e) => setNewType(e.currentTarget.value as TableColumnType)}
              >
                <For each={TABLE_COLUMN_TYPES}>
                  {(t) => <option value={t}>{typeLabel(t)}</option>}
                </For>
              </select>
            </label>
            <Show when={newType() === "choice" || newType() === "choices"}>
              <label class="flex flex-col gap-1 text-[11.5px] text-text-secondary">
                {i18n.t("kernel.dashboards.tables.choicesHint")}
                <input
                  data-testid="table-settings-new-choices"
                  class={FIELD}
                  value={newChoices()}
                  onInput={(e) => setNewChoices(e.currentTarget.value)}
                />
              </label>
            </Show>
            <Show when={newType() === "amount"}>
              <label class="flex flex-col gap-1 text-[11.5px] text-text-secondary">
                {i18n.t("kernel.dashboards.tables.currency")}
                <input
                  data-testid="table-settings-new-currency"
                  class={`${FIELD} w-20`}
                  maxLength={3}
                  value={newCurrency()}
                  onInput={(e) => setNewCurrency(e.currentTarget.value)}
                />
              </label>
            </Show>
            <label class="flex h-8 items-center gap-1.5 text-[12.5px] text-text-secondary">
              <input
                type="checkbox"
                data-testid="table-settings-new-required"
                checked={newRequired()}
                onChange={(e) => setNewRequired(e.currentTarget.checked)}
              />
              {i18n.t("kernel.dashboards.tables.requiredTag")}
            </label>
            <Button
              type="submit"
              variant="outline"
              size="sm"
              data-testid="table-settings-add-column-save"
              disabled={busy() || !newLabel().trim()}
            >
              {i18n.t("kernel.dashboards.tables.addColumn")}
            </Button>
          </form>
        </Show>
      </section>

      <section class="flex flex-col gap-2">
        <h3 class={SECTION}>{i18n.t("kernel.dashboards.tables.whoCanSee")}</h3>
        <div class="flex flex-wrap items-center gap-3 text-[13px]">
          <span data-testid="table-settings-access" class="text-text-secondary">
            {i18n.t(`kernel.dashboards.tables.access.${props.table.orgAccess}`)}
          </span>
          <Button
            variant="outline"
            size="sm"
            data-testid="table-settings-share"
            onClick={() => setSharing(true)}
          >
            {i18n.t("kernel.dashboards.tables.manageSharing")}
          </Button>
        </div>
      </section>

      <section class="flex flex-col gap-1">
        <div class="flex min-h-11 items-center gap-3 text-[13px] text-text">
          <Toggle
            data-testid="table-settings-agent-approval"
            label={i18n.t("kernel.dashboards.tables.agentApproval")}
            checked={props.table.agentWritesNeedApproval}
            disabled={!canEdit() || busy()}
            onChange={(next) => void apply({ agentWritesNeedApproval: next })}
          />
          <span>{i18n.t("kernel.dashboards.tables.agentApproval")}</span>
        </div>
        <p class="text-[12px] text-text-tertiary">
          {props.table.agentWritesNeedApproval
            ? i18n.t("kernel.dashboards.tables.agentApprovalOn")
            : i18n.t("kernel.dashboards.tables.agentApprovalOff")}
        </p>
      </section>

      <TableConfirmDialog
        open={dropping() !== null}
        title={i18n.t("kernel.dashboards.tables.dropTitle", { column: dropping()?.label ?? "" })}
        body={i18n.t("kernel.dashboards.tables.dropBody")}
        confirmLabel={i18n.t("kernel.dashboards.tables.drop")}
        testid="table-settings-drop-dialog"
        onCancel={() => setDropping(null)}
        onConfirm={() => {
          const c = dropping()
          setDropping(null)
          if (c) void apply({ columns: { drop: [c.key] } })
        }}
      />
      <DashboardShareDialog
        dashboardId={props.table.id}
        dashboardTitle={props.table.name}
        sharingPath={tableSharingPath(props.table.id)}
        title={i18n.t("kernel.dashboards.tables.sharingTitle", { name: props.table.name })}
        testIdPrefix="table-share"
        open={sharing()}
        onOpenChange={setSharing}
        onSaved={() =>
          void getTable(api, props.table.id)
            .then(props.onChanged)
            .catch(() => {})
        }
      />
    </div>
  )
}
