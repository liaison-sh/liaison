// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The router's root (App.tsx): a workspace suspended or closed for billing
// (managed edition) turns every route into the suspended page once the server
// says so (lib/org-suspended.ts); the page keeps an admin's export and Billing.
import { lazy, type ParentComponent, Show } from "solid-js"
import { orgSuspended } from "~/lib/org-suspended"

const OrgSuspendedPage = lazy(() => import("~/modules/shell/OrgSuspendedPage"))

export const OrgSuspendedRoot: ParentComponent = (props) => (
  <Show when={orgSuspended()} fallback={props.children}>
    <OrgSuspendedPage />
  </Show>
)
