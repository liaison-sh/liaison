// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE CLIENT PORTAL (`/portal/<org>/...`): where a client company's people read
// what the org shares with them, send requests and decide what was sent to them.
// Its own lazy chunk: no member shell, no agent, no tab, no dock, no socket. It
// talks only to `/api/portal/*`, with an access token held in memory and the
// server's HttpOnly refresh cookie.
//
//   /portal/sign-in?org=<slug>#c=..&t=..   the mailed link: taken, then the address is cleaned
//   /portal/<slug>/verify                  one button to sign in with that link (R-07)
//   /portal/<slug>                         sign-in form, or the home (R-01)
//   /portal/<slug>/projects/<id>           a project (R-02)
//   /portal/<slug>/invoices                invoices (R-03)
//   /portal/<slug>/requests                requests (R-04)
//   /portal/<slug>/documents/<id>          a document and what waits on it (R-05)

import { useLocation, useNavigate } from "@solidjs/router"
import {
  type Component,
  createMemo,
  createResource,
  createSignal,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js"
import { DocumentPage } from "./Approve"
import { HomePage, InvoicesPage, Loading, NotAvailable, PartFailed, ProjectPage } from "./Pages"
import { PortalShell } from "./PortalShell"
import {
  hasPortalSession,
  onPortalSessionGone,
  portalBranding,
  portalGet,
  refreshPortalSession,
  signOutOfPortal,
} from "./portal-api"
import { RequestsPage } from "./Requests"
import { SignInForm, VerifyPage } from "./SignIn"
import { rememberedOrg, rememberOrg, takeSignInLink, validSlug } from "./sign-in-link"
import type { PortalDocument, PortalHome } from "./types"

/** `/portal/<slug>/<rest...>` split, with nothing decoded beyond the segments. */
export function portalPath(pathname: string): { slug: string | null; rest: string[] } {
  const parts = pathname.split("/").filter(Boolean)
  if (parts[0] !== "portal") return { slug: null, rest: [] }
  return { slug: parts[1] ?? null, rest: parts.slice(2) }
}

const PortalRoot: Component = () => {
  const location = useLocation()
  const navigate = useNavigate()

  // The mailed link: taken once, before anything renders, and the address cleaned.
  if (portalPath(location.pathname).slug === "sign-in") {
    const { slug, link } = takeSignInLink()
    if (link)
      navigate(slug ? `/portal/${slug}/verify` : "/portal/sign-in/verify", { replace: true })
    else if (slug) navigate(`/portal/${slug}`, { replace: true })
  }

  const path = createMemo(() => portalPath(location.pathname))
  const orgSlug = () => {
    const s = path().slug
    return validSlug(s) ? s : rememberedOrg()
  }
  const [branding] = createResource(orgSlug, (s) => portalBranding(s))

  const [session, setSession] = createSignal<"checking" | "in" | "out">("checking")
  const [ended, setEnded] = createSignal(false)
  onPortalSessionGone((why) => {
    setEnded(why === "ended")
    setSession("out")
  })
  onCleanup(() => onPortalSessionGone(null))

  const check = async () => {
    if (hasPortalSession() || (await refreshPortalSession())) setSession("in")
    else setSession("out")
  }
  const verifying = () => path().rest[0] === "verify"
  if (!verifying()) void check()
  else setSession("out")

  const base = () => `/portal/${orgSlug() ?? path().slug ?? "sign-in"}`
  const go = (p: string) => navigate(p ? `${base()}/${p}` : base())
  const signedIn = () => {
    const s = orgSlug()
    if (s) rememberOrg(s)
    setEnded(false)
    setSession("in")
    navigate(base(), { replace: true })
  }

  const [home, { refetch: reloadHome }] = createResource(
    () => (session() === "in" ? 1 : null),
    async () => portalGet<PortalHome>("/home"),
  )
  const [documents] = createResource(
    () => (session() === "in" ? 1 : null),
    async () => {
      const out = await portalGet<PortalDocument[]>("/documents")
      return out.status === 200 ? (out.data ?? []) : null
    },
  )
  const homeData = () => {
    const h = home()
    return h?.status === 200 ? h.data : null
  }
  const page = () => path().rest
  const current = () => page().join("/")

  const signOut = async () => {
    await signOutOfPortal()
    setSession("out")
    navigate(base(), { replace: true })
  }

  return (
    <Switch>
      <Match when={verifying()}>
        <Show when={!branding.loading} fallback={<Loading />}>
          <VerifyPage branding={branding() ?? null} onSignedIn={signedIn} />
        </Show>
      </Match>
      <Match when={session() === "checking"}>
        <main class="flex min-h-screen items-center justify-center bg-bg">
          <Loading />
        </main>
      </Match>
      <Match when={session() === "out"}>
        <SignInForm
          slug={validSlug(path().slug) ? path().slug : orgSlug()}
          branding={branding() ?? null}
          ended={ended()}
        />
      </Match>
      <Match when={session() === "in"}>
        <PortalShell
          branding={branding() ?? null}
          home={homeData()}
          documents={documents() ?? null}
          current={current()}
          go={go}
          onSignOut={signOut}
        >
          <Show when={home()} fallback={<Loading />}>
            <Show when={homeData()} fallback={<PartFailed part="home" />}>
              {(h) => (
                <Switch fallback={<NotAvailable />}>
                  <Match when={page().length === 0}>
                    <HomePage home={h()} documents={documents() ?? null} go={go} />
                  </Match>
                  <Match when={page()[0] === "projects" && page().length === 2}>
                    <ProjectPage id={page()[1] as string} />
                  </Match>
                  <Match when={page()[0] === "invoices" && page().length === 1}>
                    <InvoicesPage home={h()} />
                  </Match>
                  <Match when={page()[0] === "requests" && page().length === 1}>
                    <RequestsPage home={h()} reload={() => void reloadHome()} />
                  </Match>
                  <Match when={page()[0] === "documents" && page().length === 2}>
                    <DocumentPage id={page()[1] as string} />
                  </Match>
                </Switch>
              )}
            </Show>
          </Show>
        </PortalShell>
      </Match>
    </Switch>
  )
}

export default PortalRoot
