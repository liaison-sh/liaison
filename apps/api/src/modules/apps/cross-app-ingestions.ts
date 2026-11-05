// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A45, FX22 F6. The cross-app calls the kernel recognises as INGESTION paths: an app writing
// what a verified external delivery handed it, with no agent proposing the write and no human
// watching the turn. A handler may skip an approval gate for exactly these, and a pair here
// must ALSO be declared in the calling app's own operator-approved `cross_app_calls`, so this
// list can only ever NARROW what a declaration already permits.
//
// A45's skip asked only "is there a declared caller app", which any future cross-app
// declaration would have inherited: an approval exemption nobody re-read. The manifest carries
// no per-target ingestion flag today, so the recognised pairs are named here and pinned by a
// guard test (cross-app-ingestion-guard.test.ts), which also holds the calls connector's own
// single caller to its webhook delivery path.

export const CROSS_APP_INGESTIONS: Readonly<Record<string, readonly string[]>> = {
  calls: ["knowledge:create"],
}

/** The caller app when THIS dispatch is a recognised ingestion, else "". `declared` is the
 *  caller's own cross_app_calls answer, which the kernel has already computed. */
export function ingestionCallerApp(args: {
  callerApp: string | undefined
  toolName: string
  declared: boolean
}): string {
  const caller = args.callerApp ?? ""
  if (caller === "" || !args.declared) return ""
  return (CROSS_APP_INGESTIONS[caller] ?? []).includes(args.toolName) ? caller : ""
}
