// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Project template rows written as they sit in the database, whatever shape
// `structure` has: a test of the template reader needs a stored legacy or
// unreadable structure that the projects app's own writer would no longer
// produce, so the row goes in directly.
import { withSystemDb } from "~/db/privileged"
import { projectTemplates } from "~/db/schema/app_projects"

export type ProjectTemplateSeed = typeof projectTemplates.$inferInsert

/** One project template row; its id. */
export async function seedProjectTemplateRow(row: ProjectTemplateSeed): Promise<string> {
  const [created] = await withSystemDb("seed-project-template-row", (db) =>
    db.insert(projectTemplates).values(row).returning({ id: projectTemplates.id }),
  )
  return created?.id as string
}
