// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"
import { schemaRef } from "~/db/schema-ref"

export function ticketsRel(name: string): ReturnType<typeof drizzleSql.raw> {
  return drizzleSql.raw(`${schemaRef("app_tickets")}.${name}`)
}

export function kernelRel(name: string): ReturnType<typeof drizzleSql.raw> {
  return drizzleSql.raw(`${schemaRef("kernel")}.${name}`)
}
