// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `/demo` as a standalone route, for a link that points straight at the doors.
//
// On a deployment that is not the demo box this redirects to the ordinary
// login rather than rendering anything: the route exists in every bundle, and
// a route that exists is not the same thing as a surface that is offered.
import { useNavigate } from "@solidjs/router"
import { type Component, createEffect, onMount, Show } from "solid-js"
import { DemoEntry } from "~/modules/demo/DemoEntry"
import { demoMode, ensureBrandingLoaded } from "~/modules/shell/branding-store"

const DemoEntryRoute: Component = () => {
  const navigate = useNavigate()
  let asked = false

  onMount(() => {
    void ensureBrandingLoaded().then(() => {
      asked = true
      if (!demoMode()) navigate("/login", { replace: true })
    })
  })

  // Covers the case where the flag was already loaded by an earlier surface:
  // `ensureBrandingLoaded` resolves immediately and the effect settles at once.
  createEffect(() => {
    if (asked && !demoMode()) navigate("/login", { replace: true })
  })

  return (
    <Show when={demoMode()}>
      <DemoEntry onSignInInstead={() => navigate("/login?signin=1")} />
    </Show>
  )
}

export default DemoEntryRoute
