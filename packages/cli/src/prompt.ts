// SPDX-License-Identifier: FSL-1.1-ALv2
import { createInterface } from "node:readline/promises"
import { CliError } from "./http"

/**
 * Ask for a typed confirmation on the terminal. Never a default yes: an empty
 * answer, another word, or no terminal at all (a pipe, an assistant's shell
 * without a TTY) is a no, unless the caller passed an explicit --yes.
 */
export async function confirmTyped(question: string, expected: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new CliError(
      "This needs a person's confirmation and there is no terminal to ask it on. Run it in a terminal, or pass --yes if the person has read the text above and agreed.",
    )
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(question)).trim()
    return answer === expected
  } finally {
    rl.close()
  }
}
