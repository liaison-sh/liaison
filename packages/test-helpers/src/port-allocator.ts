// SPDX-License-Identifier: FSL-1.1-ALv2
import { createServer } from "node:net"
import { resolveTestCoordinates } from "./test-namespace"

const MAX_RETRIES = 3

/**
 * Deterministic port allocation based on worker ID.
 * Eliminates race conditions from ephemeral port allocation under parallel workers.
 * The block comes from the run namespace (test-namespace.ts): 14000+ for a bare
 * run, the namespace's leased block for a run started by scripts/test-run.ts.
 */
export function deterministicPorts(
  workerId: number,
  count: number,
  env: Record<string, string | undefined> = process.env,
): number[] {
  return resolveTestCoordinates(env).workerPorts(workerId, count)
}

export async function allocatePorts(count: number): Promise<number[]> {
  const ports: number[] = []
  for (let i = 0; i < count; i++) {
    let allocated = false
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        ports.push(await getEphemeralPort())
        allocated = true
        break
      } catch {
        // Retry on collision
      }
    }
    if (!allocated) {
      throw new Error(
        `Failed to allocate port after ${MAX_RETRIES} retries. Already allocated: [${ports.join(", ")}]`,
      )
    }
  }
  return ports
}

function getEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, () => {
      const addr = server.address()
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("Could not determine port")))
        return
      }
      const port = addr.port
      server.close(() => resolve(port))
    })
    server.on("error", reject)
  })
}
