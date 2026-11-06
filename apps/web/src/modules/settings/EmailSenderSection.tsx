// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings → Organization → Email sender (managed edition, org admins; S29).
// The org sends its invitations, digests and survey mail from its own domain:
// the admin adds the domain, copies the DNS records shown here into their DNS
// host, then presses Verify. Until the domain is verified, that mail goes out
// as "<Org> via Liaison". Sign-in mail always keeps the service's own sender.
// Everything goes through `/api/mail-sender/*`, which forwards to the control
// plane; the sending key never reaches this page.
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { Input } from "~/ui/Input"

/** The control plane's view of the org's domain (`mail.domain_*` replies). */
interface MailDomainRecord {
  type: string
  name: string
  value: string
  priority?: number
}
interface MailDomain {
  id: string
  name: string
  status: "not_started" | "pending" | "verified" | "failed"
  records: MailDomainRecord[]
}

const STATUS_KEY: Record<MailDomain["status"], string> = {
  not_started: "cloud-limits.sender.statusNotStarted",
  pending: "cloud-limits.sender.statusPending",
  verified: "cloud-limits.sender.statusVerified",
  failed: "cloud-limits.sender.statusFailed",
}

const EmailSenderSection: Component<{ orgName: string }> = (props) => {
  const { t } = useI18n()
  const api = useApi()
  const [domainInput, setDomainInput] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [problem, setProblem] = createSignal<string | null>(null)
  const [copied, setCopied] = createSignal<string | null>(null)

  const [state, { mutate }] = createResource(async () => {
    try {
      const res = await api.get<{ domain: MailDomain | null }>("/mail-sender/status")
      return { domain: res.domain, unavailable: false }
    } catch {
      return { domain: null, unavailable: true }
    }
  })

  function messageFor(err: unknown): string {
    if (err instanceof ApiError) {
      if (err.code === "domain_limit") return t("cloud-limits.sender.domainLimit")
      if (err.code === "domain_invalid") return t("cloud-limits.sender.domainInvalid")
      if (err.code === "domain_taken") return t("cloud-limits.sender.domainTaken")
      if (err.status === 400) return t("cloud-limits.sender.domainInvalid")
    }
    return t("cloud-limits.sender.unavailable")
  }

  async function run(action: () => Promise<MailDomain | null>): Promise<void> {
    setBusy(true)
    setProblem(null)
    try {
      const domain = await action()
      mutate({ domain, unavailable: false })
    } catch (err) {
      setProblem(messageFor(err))
    } finally {
      setBusy(false)
    }
  }

  const add = () =>
    run(async () => {
      const res = await api.post<{ domain: MailDomain }>("/mail-sender/domain", {
        domain: domainInput().trim(),
        requestId: crypto.randomUUID(),
      })
      setDomainInput("")
      return res.domain
    })

  const verify = () =>
    run(async () => {
      const res = await api.post<{ domain: MailDomain }>("/mail-sender/verify", {
        requestId: crypto.randomUUID(),
      })
      return res.domain
    })

  const remove = () =>
    run(async () => {
      await api.delete("/mail-sender/domain")
      return null
    })

  async function copy(id: string, value: string): Promise<void> {
    try {
      await navigator.clipboard?.writeText(value)
      setCopied(id)
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500)
    } catch {
      // Clipboard refused: the value stays selectable in the table.
    }
  }

  const CopyButton = (p: { id: string; value: string }) => (
    <Button
      variant="ghost"
      size="sm"
      data-testid={`email-sender-copy-${p.id}`}
      onClick={() => void copy(p.id, p.value)}
    >
      {copied() === p.id ? t("cloud-limits.sender.copied") : t("cloud-limits.sender.copy")}
    </Button>
  )

  return (
    <div class="flex flex-col gap-3" data-testid="email-sender-section">
      <h3 class="text-sm font-semibold text-text">{t("cloud-limits.sender.title")}</h3>
      <p class="text-xs text-text-secondary" data-testid="email-sender-help">
        {t("cloud-limits.sender.help")}
      </p>
      <Show when={state()?.unavailable}>
        <p class="text-xs text-danger" data-testid="email-sender-unavailable">
          {t("cloud-limits.sender.unavailable")}
        </p>
      </Show>
      <Show when={state() && !state()?.unavailable && !state()?.domain}>
        <p class="text-xs text-text-secondary" data-testid="email-sender-fallback">
          {t("cloud-limits.sender.fallback", { org: props.orgName })}
        </p>
        <form
          class="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (domainInput().trim()) void add()
          }}
        >
          <div class="min-w-0 flex-1">
            <Input
              label={t("cloud-limits.sender.domainLabel")}
              placeholder={t("cloud-limits.sender.domainPlaceholder")}
              value={domainInput()}
              onInput={(e) => setDomainInput((e.currentTarget as HTMLInputElement).value)}
              data-testid="email-sender-domain-input"
            />
          </div>
          <Button
            type="submit"
            size="sm"
            disabled={busy() || domainInput().trim().length === 0}
            data-testid="email-sender-add"
          >
            {t("cloud-limits.sender.add")}
          </Button>
        </form>
      </Show>
      <Show when={state()?.domain}>
        {(domain) => (
          <div class="flex flex-col gap-3">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm font-medium text-text" data-testid="email-sender-domain-name">
                {domain().name}
              </span>
              <span
                class="rounded-sm border border-border px-1.5 py-0.5 text-xs text-text-secondary"
                data-testid="email-sender-status"
                data-status={domain().status}
              >
                {t(STATUS_KEY[domain().status])}
              </span>
            </div>
            <Show when={domain().status !== "verified"}>
              <p class="text-xs text-text-secondary" data-testid="email-sender-records-help">
                {t("cloud-limits.sender.recordsHelp")}
              </p>
            </Show>
            <Show when={domain().status === "verified"}>
              <p class="text-xs text-text-secondary" data-testid="email-sender-verified-help">
                {t("cloud-limits.sender.verifiedHelp")}
              </p>
            </Show>
            <div class="overflow-x-auto">
              <table class="w-full text-left text-xs" data-testid="email-sender-records">
                <thead class="text-text-secondary">
                  <tr>
                    <th class="py-1 pr-3 font-medium">{t("cloud-limits.sender.recordType")}</th>
                    <th class="py-1 pr-3 font-medium">{t("cloud-limits.sender.recordName")}</th>
                    <th class="py-1 pr-3 font-medium">{t("cloud-limits.sender.recordValue")}</th>
                    <th class="py-1 pr-3 font-medium">{t("cloud-limits.sender.recordPriority")}</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={domain().records}>
                    {(r: MailDomainRecord, i) => (
                      <tr class="border-t border-border" data-testid={`email-sender-record-${i()}`}>
                        <td class="py-1 pr-3 font-mono">{r.type}</td>
                        <td class="py-1 pr-3">
                          <div class="flex items-center gap-1">
                            <span
                              class="whitespace-nowrap font-mono"
                              data-testid={`email-sender-name-${i()}`}
                            >
                              {r.name}
                            </span>
                            <CopyButton id={`name-${i()}`} value={r.name} />
                          </div>
                        </td>
                        <td class="py-1 pr-3">
                          <div class="flex items-center gap-1">
                            <span class="break-all font-mono">{r.value}</span>
                            <CopyButton id={`value-${i()}`} value={r.value} />
                          </div>
                        </td>
                        <td
                          class="py-1 pr-3 font-mono"
                          data-testid={`email-sender-priority-${i()}`}
                        >
                          {r.priority ?? ""}
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
            <div class="flex flex-wrap gap-2">
              <Show when={domain().status !== "verified"}>
                <Button
                  size="sm"
                  disabled={busy()}
                  onClick={() => void verify()}
                  data-testid="email-sender-verify"
                >
                  {t("cloud-limits.sender.verify")}
                </Button>
              </Show>
              <Button
                variant="outline"
                size="sm"
                disabled={busy()}
                onClick={() => void remove()}
                data-testid="email-sender-remove"
              >
                {t("cloud-limits.sender.remove")}
              </Button>
            </div>
          </div>
        )}
      </Show>
      <Show when={problem()}>
        <p class="text-xs text-danger" role="alert" data-testid="email-sender-error">
          {problem()}
        </p>
      </Show>
    </div>
  )
}

export default EmailSenderSection
