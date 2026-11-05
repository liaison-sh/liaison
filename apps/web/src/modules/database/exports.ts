// SPDX-License-Identifier: FSL-1.1-ALv2
// Every component the database manifest declares (its settings custom block)
// must be exported here: a missing export aborts the whole manifest-app
// registration.
import { lazy } from "solid-js"

/** Settings custom block "Report access": per-domain access to curated reads. */
export const DatabaseReportAccess = lazy(() => import("./DatabaseReportAccess"))
