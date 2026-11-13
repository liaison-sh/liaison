// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * How a routine is named to people (a message's author, an attention item, a run summary): its
 * title when it has one (0304, "Ping logistics on a status"), else its identifier. The identifier
 * (`name`) stays the key tools and URLs use.
 */
export function routineDisplayName(routine: { name: string; title?: string | null }): string {
  return routine.title?.trim() || routine.name
}
