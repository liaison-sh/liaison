// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The CURATED capability labels a withheld card may say (A14).
//
// `describeWithheldCapabilities` maps a withheld scope to the label of the app
// it belongs to. Nobody ever supplied that map: every call site passed `{}`, so
// every scope fell through to `GENERIC_WITHHELD_LABEL` and every card in the
// product read "a capability", which tells the requester nothing at all.
//
// A label is deliberately the CATEGORY, not the app's machine name and not the
// scope: "finance data", never "pennylane:payouts:read" and never "pennylane".
// An app with no entry here keeps the generic label rather than leaking its
// prefix, which is the rule `withheld-capability.test.ts` pins.
// THE MAP ITSELF LIVES IN `packages/shared` (`CAPABILITY_LABELS`): the admin
// access request row renders the same words beside the raw scope an admin is
// entitled to see, and a second copy would drift until one of them leaked a
// scope.
export { CAPABILITY_LABELS as WITHHELD_CAPABILITY_LABELS } from "@liaison/shared"
