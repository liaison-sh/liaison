// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The suspended page (spec S26, managed edition): what every screen of a
// workspace suspended or closed for billing becomes once the server says so
// (lib/org-suspended.ts, routed from App.tsx). One sentence, the billing
// contact the control plane pushed (from the 403 body, never a literal here),
// and for an admin while access remains (`accessUntil` ahead): the export and
// Billing, opened inside this page, so the data can be taken and the open
// invoice paid. A member, or anyone once the workspace is closed, gets the
// sentence and the contact only.
import { type Component, createSignal, lazy, Match, Show, Suspense, Switch } from "solid-js"
import { orgSuspension } from "~/lib/org-suspended"
import { hasScope } from "~/modules/auth/auth-store"
import { authManager } from "~/modules/auth/createAuthManager"
import { useI18n } from "~/modules/i18n/i18n-context"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { Skeleton } from "~/ui/Skeleton"

const BillingSettings = lazy(() => import("~/modules/settings/BillingSettings"))
const OrgExportSection = lazy(() => import("~/modules/settings/OrgExportSection"))

/** The scope that keeps an admin's export and Billing while suspended (server: suspension.ts). */
const ADMIN_SCOPE = "kernel:org:admin"

type View = "summary" | "billing" | "export"

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  })
}

const OrgSuspendedPage: Component<{ leave?: (path: string) => void }> = (props) => {
  const { t } = useI18n()
  const [view, setView] = createSignal<View>("summary")
  const details = () => orgSuspension()
  const until = () => {
    const at = details()?.accessUntil
    return at && Date.parse(at) > Date.now() ? at : null
  }
  // An admin's own session, inside the window: export and Billing stay theirs.
  const adminAccess = () => until() !== null && hasScope(ADMIN_SCOPE)
  const leave = (path: string) => (props.leave ? props.leave(path) : window.location.replace(path))

  async function signOut(): Promise<void> {
    await authManager.logout().catch(() => undefined)
    leave("/login")
  }

  return (
    <div data-testid="org-suspended" class="flex min-h-screen justify-center bg-bg px-4 py-12">
      <div class="w-full max-w-2xl">
        <h1 class="mb-2 text-lg font-semibold text-text">{t("cloud-limits.suspended.title")}</h1>
        <p class="mb-3 text-sm text-text-secondary" data-testid="org-suspended-sentence">
          {t("cloud-limits.suspended.sentence")}
        </p>
        <Show when={adminAccess() && until()}>
          {(at) => (
            <p class="mb-3 text-sm text-text-secondary" data-testid="org-suspended-until">
              {t("cloud-limits.suspended.adminUntil", { date: formatDate(at()) })}
            </p>
          )}
        </Show>
        <Show when={details()?.contact}>
          {(contact) => (
            <p class="mb-4 text-sm text-text" data-testid="org-suspended-contact">
              {t("cloud-limits.suspended.contact")}{" "}
              <a class="text-accent underline" href={`mailto:${contact()}`}>
                {contact()}
              </a>
            </p>
          )}
        </Show>
        <div class="mb-6 flex flex-wrap items-center gap-2">
          <Show when={adminAccess()}>
            <Button
              size="sm"
              variant={view() === "export" ? "primary" : "outline"}
              data-testid="org-suspended-export"
              onClick={() => setView("export")}
            >
              {t("cloud-limits.suspended.export")}
            </Button>
            <Button
              size="sm"
              variant={view() === "billing" ? "primary" : "outline"}
              data-testid="org-suspended-billing"
              onClick={() => setView("billing")}
            >
              {t("cloud-limits.suspended.billing")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="org-suspended-reload"
              onClick={() => window.location.reload()}
            >
              {t("cloud-limits.suspended.reload")}
            </Button>
          </Show>
          <Button
            size="sm"
            variant="ghost"
            data-testid="org-suspended-sign-out"
            onClick={() => void signOut()}
          >
            {t("cloud-limits.suspended.signOut")}
          </Button>
        </div>
        <Show when={adminAccess() && view() !== "summary"}>
          <ApiProvider>
            <Suspense fallback={<Skeleton class="h-32 w-full" />}>
              <Switch>
                <Match when={view() === "billing"}>
                  <BillingSettings />
                </Match>
                <Match when={view() === "export"}>
                  <div data-testid="org-suspended-export-section">
                    <OrgExportSection />
                  </div>
                </Match>
              </Switch>
            </Suspense>
          </ApiProvider>
        </Show>
      </div>
    </div>
  )
}

export default OrgSuspendedPage
