// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * R-08, the company page's "Client portal" section: who of this company has
 * portal access, what the company sees there, what they would see right now
 * (the preview runs the portal's own reads), the access log for its named
 * readers, the sign-in options and End access. Calls
 * `/api/contacts/companies/:id/portal/*`; every act is a person's click and the
 * server says what it did. No engagement score, no last-seen ranking, no seat
 * count, and no way to act as the client. Client-typed text renders as text.
 */
import {
  type Component,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { ApiError } from "~/lib/api-error"
import { hasScope } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"

export interface PortalPerson {
  userId: string
  name: string
  email: string
  title: string | null
  invitedAt: string | null
  lastSignInAt: string | null
  status: string
  totpEnabled: boolean
  keepsWhatTheySawBefore: boolean
}

export interface PortalShareRow {
  id: string
  kind: string
  objectId: string | null
  onlyUserIds: string[] | null
  /** The shared document's number and title, when the reader can read it. */
  label?: string | null
}

export interface PortalLogRow {
  id: string
  at: string
  user_id: string | null
  action: string
  entity_type: string | null
}

type Preview = Record<string, Array<Record<string, unknown>> | null> | null

/** The section's state from its people: nobody yet, open, or ended for the company. */
export function portalState(people: PortalPerson[]): "empty" | "active" | "ended" {
  if (people.length === 0) return "empty"
  return people.every((p) => p.status !== "active") ? "ended" : "active"
}

const COMPANY_WIDE = ["invoices", "requests"] as const
const PER_PROJECT = ["project_progress", "project_hours", "project_reports"] as const
/** Kinds whose opening asks first: what the client will then read. */
const WARNED = new Set<string>(["project_hours", "invoices"])

const btn =
  "rounded-md border border-border px-3 py-1.5 text-[13px] text-text hover:bg-surface-hover disabled:opacity-60"
const primary =
  "rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-foreground disabled:opacity-60"
const input =
  "rounded-md border border-border bg-bg px-2.5 py-1.5 text-[13px] text-text focus:outline-none focus:ring-2 focus:ring-accent/40"

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.message ? err.message : fallback
}

async function companyProjects(
  api: ReturnType<typeof useApi>,
  companyId: string,
): Promise<Array<{ id: string; name: string }>> {
  try {
    const res = await api.post<unknown>("/apps/run-tool", {
      toolName: "projects:company_work",
      params: { companyId },
    })
    const body = (
      res && typeof res === "object" && "data" in (res as object)
        ? (res as { data: unknown }).data
        : res
    ) as { projects?: Array<{ id: string; name: string }> }
    return Array.isArray(body?.projects) ? body.projects : []
  } catch {
    return []
  }
}

export const CompanyPortalSection: Component<{ companyId: string }> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const base = () => `/contacts/companies/${props.companyId}/portal`
  const canShare = () => hasScope("kernel:portal:share")
  const canLog = () => hasScope("kernel:portal:logs")

  const [people, { refetch: reloadPeople }] = createResource(
    () => props.companyId,
    () => api.get<PortalPerson[]>(`${base()}/people`),
  )
  const [shares, { refetch: reloadShares }] = createResource(
    () => (canShare() ? props.companyId : null),
    () => api.get<PortalShareRow[]>(`${base()}/shares`),
  )
  const [projects] = createResource(
    () => (canShare() ? props.companyId : null),
    (id) => companyProjects(api, id),
  )
  const [log, { refetch: reloadLog }] = createResource(
    () => (canLog() ? props.companyId : null),
    () => api.get<PortalLogRow[]>(`${base()}/log`),
  )
  // A client signs in and reads from their own browser: coming back to this window reads
  // the people and the log again, so their sign-in and what they did show without a reload.
  onMount(() => {
    const again = () => {
      void reloadPeople()
      if (canLog()) void reloadLog()
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") again()
    }
    window.addEventListener("focus", again)
    document.addEventListener("visibilitychange", onVisible)
    onCleanup(() => {
      window.removeEventListener("focus", again)
      document.removeEventListener("visibilitychange", onVisible)
    })
  })

  // Who may read the log, by name, and the second step's current setting: each a read of its
  // own, so a failed one leaves the generic words and unmarked options, never a broken section.
  const [logReaders] = createResource(
    () => (canLog() ? props.companyId : null),
    () =>
      api
        .get<{ readers: Array<{ userId: string; name: string }> }>(`${base()}/log/readers`)
        .then((r) => r.readers)
        .catch(() => null),
  )
  const [signIn, { refetch: reloadSignIn }] = createResource(
    () => props.companyId,
    () =>
      api
        .get<{ required: boolean }>(`${base()}/sign-in`)
        .then((r) => r.required === true)
        .catch(() => null),
  )

  const [view, setView] = createSignal<"controls" | "preview">("controls")
  const [message, setMessage] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [inviting, setInviting] = createSignal(false)
  const [inviteName, setInviteName] = createSignal("")
  const [inviteEmail, setInviteEmail] = createSignal("")
  const [confirmEnd, setConfirmEnd] = createSignal(false)
  const [endReason, setEndReason] = createSignal("")
  const [pendingShare, setPendingShare] = createSignal<string | null>(null)
  const [previewOf, setPreviewOf] = createSignal<string | null>(null)
  const [preview] = createResource(previewOf, (userId) =>
    api.get<{ userId: string; signedInWouldSee: Preview }>(`${base()}/preview/${userId}`),
  )

  const list = () => people() ?? []
  const state = createMemo(() => portalState(list()))
  const nameOf = (id: string) => list().find((p) => p.userId === id)?.name ?? ""

  const act = async (fn: () => Promise<string>) => {
    setBusy(true)
    setMessage(null)
    try {
      setMessage(await fn())
    } catch (err) {
      setMessage(errorText(err, i18n.t("portal.staff.failed")))
    } finally {
      setBusy(false)
    }
  }

  const invite = (e: Event) => {
    e.preventDefault()
    void act(async () => {
      const r = await api.post<{ name: string; email: string }>(`${base()}/invite`, {
        name: inviteName().trim(),
        email: inviteEmail().trim(),
      })
      setInviting(false)
      setInviteName("")
      setInviteEmail("")
      void reloadPeople()
      return i18n.t("portal.staff.invited", { name: r.name, email: r.email })
    })
  }

  const remove = (p: PortalPerson) =>
    act(async () => {
      await api.post(`${base()}/people/${p.userId}/remove`, {})
      void reloadPeople()
      return i18n.t("portal.staff.removed", { name: p.name })
    })

  const resetTotp = (p: PortalPerson) =>
    act(async () => {
      await api.post(`${base()}/people/${p.userId}/totp-reset`, {})
      void reloadPeople()
      return i18n.t("portal.staff.totpReset", { name: p.name })
    })

  const showWhole = (p: PortalPerson) =>
    act(async () => {
      const r = await api.post<{ message: string }>(
        `${base()}/people/${p.userId}/show-whole-company`,
        {},
      )
      void reloadPeople()
      return r.message
    })

  const requireTotp = (requireIt: boolean) =>
    act(async () => {
      await api.post(`${base()}/sign-in`, { requireTotp: requireIt })
      void reloadSignIn()
      return requireIt ? i18n.t("portal.staff.totpRequired") : i18n.t("portal.staff.totpOptional")
    })

  const end = () =>
    act(async () => {
      const r = await api.post<{
        signedOut: number
        cancelledLinks: number
        closedShares: number
      }>(`${base()}/end`, endReason().trim() ? { reason: endReason().trim() } : {})
      setConfirmEnd(false)
      setEndReason("")
      void reloadPeople()
      void reloadShares()
      return i18n.t("portal.staff.ended", {
        people: String(r.signedOut),
        links: String(r.cancelledLinks),
        shares: String(r.closedShares),
      })
    })

  const restore = () =>
    act(async () => {
      const r = await api.post<{ people: number }>(`${base()}/restore`, {})
      void reloadPeople()
      return i18n.t("portal.staff.restored", { people: String(r.people) })
    })

  const isOpen = (kind: string, objectId: string | null) =>
    (shares() ?? []).some((s) => s.kind === kind && (s.objectId ?? null) === objectId)

  const setShare = (kind: string, objectId: string | null, open: boolean) =>
    act(async () => {
      await api.post(`${base()}/shares`, {
        kind,
        open,
        ...(objectId ? { objectId } : {}),
      })
      setPendingShare(null)
      void reloadShares()
      return open
        ? i18n.t("portal.staff.shareOpened", { what: i18n.t(`portal.staff.kind.${kind}`) })
        : i18n.t("portal.staff.shareClosed", { what: i18n.t(`portal.staff.kind.${kind}`) })
    })

  const toggle = (kind: string, objectId: string | null) => {
    const key = `${kind}:${objectId ?? ""}`
    if (isOpen(kind, objectId)) return setShare(kind, objectId, false)
    if (WARNED.has(kind) && pendingShare() !== key) return setPendingShare(key)
    return setShare(kind, objectId, true)
  }

  const ShareSwitch: Component<{ kind: string; objectId: string | null; label: string }> = (sp) => {
    const key = () => `${sp.kind}:${sp.objectId ?? ""}`
    return (
      <li
        data-testid={`company-portal.share-${sp.kind}${sp.objectId ? `-${sp.objectId}` : ""}`}
        class="flex flex-col gap-1 py-1.5"
      >
        <div class="flex items-center justify-between gap-3">
          <span class="text-[13px] text-text">{sp.label}</span>
          <button
            type="button"
            role="switch"
            aria-checked={isOpen(sp.kind, sp.objectId)}
            data-testid="company-portal.share-toggle"
            class={btn}
            disabled={busy()}
            onClick={() => toggle(sp.kind, sp.objectId)}
          >
            {isOpen(sp.kind, sp.objectId)
              ? i18n.t("portal.staff.open")
              : i18n.t("portal.staff.closed")}
          </button>
        </div>
        <Show when={pendingShare() === key()}>
          <div
            data-testid="company-portal.share-warning"
            class="flex flex-wrap items-center gap-2 text-[12.5px] text-text-secondary"
          >
            <span>{i18n.t(`portal.staff.warn.${sp.kind}`)}</span>
            <button
              type="button"
              data-testid="company-portal.share-confirm"
              class={primary}
              onClick={() => setShare(sp.kind, sp.objectId, true)}
            >
              {i18n.t("portal.staff.openIt")}
            </button>
            <button type="button" class={btn} onClick={() => setPendingShare(null)}>
              {i18n.t("portal.staff.cancel")}
            </button>
          </div>
        </Show>
      </li>
    )
  }

  const otherShares = () =>
    (shares() ?? []).filter(
      (s) => s.objectId && !(PER_PROJECT as readonly string[]).includes(s.kind),
    )

  return (
    <section data-testid="company-portal" class="mt-10">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="mr-auto text-[12px] font-semibold uppercase tracking-wide text-text-tertiary">
          {i18n.t("portal.staff.title")}
        </h2>
        {/* Action row at the top. */}
        <div class="flex gap-1">
          <button
            type="button"
            data-testid="company-portal.view-controls"
            aria-pressed={view() === "controls"}
            class={view() === "controls" ? primary : btn}
            onClick={() => setView("controls")}
          >
            {i18n.t("portal.staff.viewControls")}
          </button>
          <button
            type="button"
            data-testid="company-portal.view-preview"
            aria-pressed={view() === "preview"}
            class={view() === "preview" ? primary : btn}
            disabled={list().length === 0}
            onClick={() => {
              setView("preview")
              if (!previewOf() && list()[0]) setPreviewOf(list()[0]?.userId ?? null)
            }}
          >
            {i18n.t("portal.staff.viewPreview")}
          </button>
        </div>
        <Show when={state() !== "ended"}>
          <button
            type="button"
            data-testid="company-portal.invite"
            class={btn}
            onClick={() => setInviting(!inviting())}
          >
            {i18n.t("portal.staff.invite")}
          </button>
        </Show>
        <Show when={state() === "active"}>
          <button
            type="button"
            data-testid="company-portal.end"
            class={btn}
            onClick={() => setConfirmEnd(true)}
          >
            {i18n.t("portal.staff.end")}
          </button>
        </Show>
        <Show when={state() === "ended"}>
          <button
            type="button"
            data-testid="company-portal.restore"
            class={btn}
            disabled={busy()}
            onClick={restore}
          >
            {i18n.t("portal.staff.restore")}
          </button>
        </Show>
      </div>

      <Show when={message()}>
        {(m) => (
          <p data-testid="company-portal.message" role="status" class="mt-2 text-[13px] text-text">
            {m()}
          </p>
        )}
      </Show>

      <Show when={inviting()}>
        <form
          data-testid="company-portal.invite-form"
          class="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={invite}
        >
          <label class="flex flex-col gap-1 text-[12px] text-text-secondary">
            {i18n.t("portal.staff.name")}
            <input
              data-testid="company-portal.invite-name"
              class={input}
              required
              value={inviteName()}
              onInput={(e) => setInviteName(e.currentTarget.value)}
            />
          </label>
          <label class="flex flex-col gap-1 text-[12px] text-text-secondary">
            {i18n.t("portal.staff.email")}
            <input
              data-testid="company-portal.invite-email"
              type="email"
              class={input}
              required
              value={inviteEmail()}
              onInput={(e) => setInviteEmail(e.currentTarget.value)}
            />
          </label>
          <button
            type="submit"
            data-testid="company-portal.invite-send"
            class={primary}
            disabled={busy()}
          >
            {i18n.t("portal.staff.inviteSend")}
          </button>
          <p class="w-full text-[12.5px] text-text-secondary">
            {i18n.t("portal.staff.sameForAll")}
          </p>
        </form>
      </Show>

      <Show when={confirmEnd()}>
        <div
          data-testid="company-portal.end-confirm"
          class="mt-3 flex flex-col gap-2 rounded-md border border-border px-3 py-3"
        >
          <p class="text-[13px] text-text">{i18n.t("portal.staff.endExplain")}</p>
          <input
            data-testid="company-portal.end-reason"
            class={input}
            placeholder={i18n.t("portal.staff.endReason")}
            value={endReason()}
            onInput={(e) => setEndReason(e.currentTarget.value)}
          />
          <div class="flex gap-2">
            <button
              type="button"
              data-testid="company-portal.end-confirm-button"
              class={primary}
              disabled={busy()}
              onClick={end}
            >
              {i18n.t("portal.staff.endConfirm")}
            </button>
            <button type="button" class={btn} onClick={() => setConfirmEnd(false)}>
              {i18n.t("portal.staff.cancel")}
            </button>
          </div>
        </div>
      </Show>

      <Show
        when={!people.error}
        fallback={
          <p data-testid="company-portal.error" class="mt-3 text-[13px] text-text-tertiary">
            {i18n.t("portal.staff.loadFailed")}
          </p>
        }
      >
        <Switch>
          <Match when={view() === "controls"}>
            <div class="mt-3 flex flex-col gap-5">
              <Switch>
                <Match when={people.loading && !people.latest}>
                  <p class="text-[13px] text-text-tertiary">{i18n.t("portal.states.loading")}</p>
                </Match>
                <Match when={state() === "empty"}>
                  <p data-testid="company-portal.empty" class="text-[13px] text-text-secondary">
                    {i18n.t("portal.staff.empty")}
                  </p>
                </Match>
                <Match when={state() === "ended"}>
                  <p data-testid="company-portal.ended" class="text-[13px] text-text-secondary">
                    {i18n.t("portal.staff.endedState")}
                  </p>
                </Match>
              </Switch>

              <Show when={list().length > 0}>
                <div>
                  <h3 class="mb-1 text-[12.5px] font-medium text-text-secondary">
                    {i18n.t("portal.staff.people")}
                  </h3>
                  <ul class="flex flex-col divide-y divide-border">
                    <For each={list()}>
                      {(p) => (
                        <li
                          data-testid={`company-portal.person-${p.userId}`}
                          class="flex flex-col gap-1 py-2"
                        >
                          <div class="flex flex-wrap items-center gap-2">
                            <span class="text-[13.5px] text-text">{p.name}</span>
                            <span class="text-[12.5px] text-text-tertiary">{p.email}</span>
                            <span class="text-[12px] text-text-secondary">
                              {p.lastSignInAt
                                ? i18n.t("portal.staff.hasSignedIn")
                                : i18n.t("portal.staff.invitedState")}
                            </span>
                            <span class="ml-auto flex gap-1">
                              <Show when={p.totpEnabled}>
                                <button
                                  type="button"
                                  class={btn}
                                  data-testid="company-portal.totp-reset"
                                  disabled={busy()}
                                  onClick={() => resetTotp(p)}
                                >
                                  {i18n.t("portal.staff.resetTotp")}
                                </button>
                              </Show>
                              <button
                                type="button"
                                class={btn}
                                data-testid="company-portal.remove"
                                disabled={busy()}
                                onClick={() => remove(p)}
                              >
                                {p.lastSignInAt
                                  ? i18n.t("portal.staff.remove")
                                  : i18n.t("portal.staff.cancelInvite")}
                              </button>
                            </span>
                          </div>
                          <Show when={p.keepsWhatTheySawBefore}>
                            <div
                              data-testid="company-portal.merge-kept"
                              class="flex flex-wrap items-center gap-2 text-[12.5px] text-text-secondary"
                            >
                              <span>{i18n.t("portal.staff.mergeKept", { name: p.name })}</span>
                              <button
                                type="button"
                                class={btn}
                                data-testid="company-portal.show-whole-company"
                                disabled={busy()}
                                onClick={() => showWhole(p)}
                              >
                                {i18n.t("portal.staff.showWhole")}
                              </button>
                            </div>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>

              <Show when={canShare() && state() !== "ended"}>
                <div data-testid="company-portal.shares">
                  <h3 class="mb-1 text-[12.5px] font-medium text-text-secondary">
                    {i18n.t("portal.staff.shares")}
                  </h3>
                  <p class="text-[12.5px] text-text-tertiary">
                    {i18n.t("portal.staff.sameForAll")}
                  </p>
                  <ul class="flex flex-col divide-y divide-border">
                    <For each={[...COMPANY_WIDE]}>
                      {(kind) => (
                        <ShareSwitch
                          kind={kind}
                          objectId={null}
                          label={i18n.t(`portal.staff.kind.${kind}`)}
                        />
                      )}
                    </For>
                    <For each={projects() ?? []}>
                      {(project) => (
                        <For each={[...PER_PROJECT]}>
                          {(kind) => (
                            <ShareSwitch
                              kind={kind}
                              objectId={project.id}
                              label={`${project.name} · ${i18n.t(`portal.staff.kind.${kind}`)}`}
                            />
                          )}
                        </For>
                      )}
                    </For>
                    <For each={otherShares()}>
                      {(s) => (
                        <li
                          data-testid={`company-portal.shared-${s.id}`}
                          class="flex flex-wrap items-center justify-between gap-2 py-1.5"
                        >
                          <span class="text-[13px] text-text">
                            {s.label || i18n.t(`portal.staff.kind.${s.kind}`)}
                          </span>
                          <Show when={s.onlyUserIds && s.onlyUserIds.length > 0}>
                            <span
                              data-testid="company-portal.restricted-row"
                              class="text-[12.5px] text-text-secondary"
                            >
                              {i18n.t("portal.staff.onlyThese", {
                                names: (s.onlyUserIds ?? []).map(nameOf).filter(Boolean).join(", "),
                              })}
                            </span>
                          </Show>
                          {/* The same switch as the rows above: it says the share is open,
                              and a click closes it. */}
                          <button
                            type="button"
                            role="switch"
                            aria-checked={true}
                            data-testid="company-portal.share-toggle"
                            class={btn}
                            disabled={busy()}
                            onClick={() => setShare(s.kind, s.objectId, false)}
                          >
                            {i18n.t("portal.staff.open")}
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                  <p
                    data-testid="company-portal.never-shared"
                    class="mt-2 text-[12.5px] text-text-tertiary"
                  >
                    {i18n.t("portal.staff.never")}
                  </p>
                </div>
              </Show>

              <Show when={state() === "active"}>
                <div
                  data-testid="company-portal.sign-in-options"
                  class="flex flex-wrap items-center gap-2"
                >
                  <span class="mr-auto text-[12.5px] font-medium text-text-secondary">
                    {i18n.t("portal.staff.signInOptions")}
                  </span>
                  <button
                    type="button"
                    class={signIn() === true ? primary : btn}
                    aria-pressed={signIn() === true}
                    data-testid="company-portal.require-totp"
                    disabled={busy()}
                    onClick={() => requireTotp(true)}
                  >
                    {i18n.t("portal.staff.requireTotp")}
                  </button>
                  <button
                    type="button"
                    class={signIn() === false ? primary : btn}
                    aria-pressed={signIn() === false}
                    data-testid="company-portal.optional-totp"
                    disabled={busy()}
                    onClick={() => requireTotp(false)}
                  >
                    {i18n.t("portal.staff.optionalTotp")}
                  </button>
                </div>
              </Show>

              <Show when={canLog()}>
                <div data-testid="company-portal.log">
                  <h3 class="mb-1 text-[12.5px] font-medium text-text-secondary">
                    {i18n.t("portal.staff.log")}
                  </h3>
                  <p
                    data-testid="company-portal.log-readers"
                    class="text-[12.5px] text-text-tertiary"
                  >
                    {(logReaders() ?? []).length > 0
                      ? i18n.t("portal.staff.logReadersNamed", {
                          names: (logReaders() ?? []).map((r) => r.name).join(", "),
                        })
                      : i18n.t("portal.staff.logReaders")}
                  </p>
                  <Show
                    when={(log() ?? []).length > 0}
                    fallback={
                      <p class="text-[12.5px] text-text-tertiary">
                        {i18n.t("portal.staff.logEmpty")}
                      </p>
                    }
                  >
                    <ul class="flex flex-col">
                      <For each={(log() ?? []).slice(0, 20)}>
                        {(row) => (
                          <li
                            data-testid={`company-portal.log-${row.id}`}
                            class="flex flex-wrap gap-2 py-1 text-[12.5px] text-text-secondary"
                          >
                            <span>{new Date(row.at).toLocaleString(i18n.locale())}</span>
                            <span class="text-text">{row.user_id ? nameOf(row.user_id) : ""}</span>
                            <span>{i18n.t(`portal.staff.logAction.${logAction(row.action)}`)}</span>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </div>
              </Show>
            </div>
          </Match>

          <Match when={view() === "preview"}>
            <div data-testid="company-portal.preview" class="mt-3 flex flex-col gap-3">
              <label class="flex items-center gap-2 text-[12.5px] text-text-secondary">
                {i18n.t("portal.staff.previewAs")}
                <select
                  data-testid="company-portal.preview-person"
                  class={input}
                  value={previewOf() ?? ""}
                  onChange={(e) => setPreviewOf(e.currentTarget.value || null)}
                >
                  <For each={list()}>{(p) => <option value={p.userId}>{p.name}</option>}</For>
                </select>
              </label>
              <PreviewBody
                preview={preview()?.signedInWouldSee ?? null}
                loading={preview.loading}
              />
            </div>
          </Match>
        </Switch>
      </Show>
    </section>
  )
}

const LOG_ACTIONS = new Set([
  "sign_in",
  "view",
  "download",
  "sign",
  "accept",
  "approve",
  "decline",
  "failure",
])

export function logAction(action: string): string {
  const short = action.replace(/^portal\./, "")
  return LOG_ACTIONS.has(short) ? short : "other"
}

/** What the person would see now, through the portal's own reads. */
const PreviewBody: Component<{ preview: Preview; loading: boolean }> = (props) => {
  const i18n = useI18n()
  const rows = (part: string) => props.preview?.[part] ?? []
  return (
    <Show
      when={props.preview}
      fallback={
        <p data-testid="company-portal.preview-none" class="text-[13px] text-text-secondary">
          {props.loading ? i18n.t("portal.states.loading") : i18n.t("portal.staff.previewNone")}
        </p>
      }
    >
      <div class="flex flex-col gap-3 rounded-md border border-border px-3 py-3 text-[13px]">
        <p class="text-[12.5px] text-text-tertiary">{i18n.t("portal.staff.previewTrue")}</p>
        <For
          each={[
            ["projects", "name"],
            ["invoices", "number"],
            ["upcoming", "label"],
            ["requests", "subject"],
          ]}
        >
          {([part, field]) => (
            <div data-testid={`company-portal.preview-${part}`}>
              <p class="text-[12px] font-medium text-text-secondary">
                {i18n.t(`portal.staff.previewPart.${part}`)}
              </p>
              <Show
                when={props.preview?.[part as string] !== null}
                fallback={<p class="text-text-tertiary">{i18n.t("portal.states.partFailed")}</p>}
              >
                <Show
                  when={rows(part as string).length > 0}
                  fallback={
                    <p class="text-text-tertiary">{i18n.t("portal.staff.previewNothing")}</p>
                  }
                >
                  <ul>
                    <For each={rows(part as string)}>
                      {(r) => <li class="text-text">{String(r[field as string] ?? "")}</li>}
                    </For>
                  </ul>
                </Show>
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
