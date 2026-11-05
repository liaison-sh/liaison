// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Load one app's PDF templates into the in-memory registry from the persisted
// source of truth: the active version's `kernel.apps_installed.pdf_templates`
// jsonb column. Templates are instance-wide (keyed by app and kind), so
// nothing loads at boot and no org is walked: a render that misses loads its
// app here (render.ts), and an activation replaces the app's entries
// (activation.ts).

import { and, eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import {
  appsActiveVersion,
  appsInstalled,
  type InstalledPdfTemplate,
} from "~/db/schema/kernel/apps-installed"
import { pdfLogger as log } from "~/lib/logger"
import { getTemplate, registerTemplate } from "./registry"

/** Register the app's templates from its active version, the ones this process lacks. */
export async function loadAppTemplates(appId: string): Promise<void> {
  const [row] = await withSystemDb("pdf-registry-app-load", (db) =>
    db
      .select({ pdfTemplates: appsInstalled.pdfTemplates })
      .from(appsInstalled)
      .innerJoin(
        appsActiveVersion,
        and(
          eq(appsActiveVersion.name, appsInstalled.name),
          eq(appsActiveVersion.version, appsInstalled.version),
        ),
      )
      .where(eq(appsInstalled.name, appId))
      .limit(1),
  )
  const templates: InstalledPdfTemplate[] = row?.pdfTemplates ?? []
  for (const tpl of templates) {
    if (getTemplate(appId, tpl.kind) === undefined) registerTemplate(appId, tpl.kind, tpl.source)
  }
  log.debug({ appId, registered: templates.length }, "pdf templates loaded for an app")
}
