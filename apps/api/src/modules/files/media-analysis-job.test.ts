// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { sql } from "~/db"
import { _setEdition } from "~/lib/edition"
import {
  type GenaiFilesClient,
  type MediaAnalysisJobDeps,
  type MediaAnalysisJobPayload,
  processMediaAnalysisJob,
} from "~/modules/files/media-analysis-job"

const ORG = "00000000-0000-4000-8000-0000000c0001"
const USER = "00000000-0000-4000-8000-0000000c0002"

const NIL = "00000000-0000-0000-0000-000000000000"

function makeMp4(extra = 0): Buffer {
  const header = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  ])
  return extra > 0 ? Buffer.concat([header, Buffer.alloc(extra)]) : header
}

async function seedVideo(id: string): Promise<void> {
  await sql`INSERT INTO kernel.files
    (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key, analysis_status)
    VALUES (${id}, ${ORG}, 'tickets', 'message', 'm1', 'clip.mp4', 'video/mp4', 26214400,
            ${`orgs/${ORG}/tickets/message/${id}/clip.mp4`}, 'pending')`
}

function basePayload(
  id: string,
  over: Partial<MediaAnalysisJobPayload> = {},
): MediaAnalysisJobPayload {
  return {
    fileId: id,
    orgId: ORG,
    storageKey: `orgs/${ORG}/tickets/message/${id}/clip.mp4`,
    modelId: "gemini-flash-lite-latest",
    context: "broken hinge",
    userId: USER,
    ...over,
  }
}

/** A fake genai client whose files.get returns the given state sequence. */
function fakeClient(states: string[], over: Partial<GenaiFilesClient> = {}): GenaiFilesClient {
  let i = 0
  return {
    files: {
      upload: mock(async (_args: { file: Blob | string }) => ({
        name: "files/abc123",
        state: "PROCESSING",
      })),
      get: mock(async (_args: { name: string }) => {
        const s = states[Math.min(i, states.length - 1)]
        i++
        return {
          name: "files/abc123",
          uri: "https://files/abc123",
          mimeType: "video/mp4",
          state: s,
        }
      }),
    },
    models: {
      generateContent: mock(async () => ({
        text: "Shows a snapped hinge near the left bezel.",
        usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 80 },
      })),
    },
    ...over,
  }
}

async function creditRows(): Promise<number> {
  const rows = await sql`SELECT count(*)::int AS n FROM kernel.credit_transactions
    WHERE org_id = ${ORG} AND model = 'gemini-flash-lite-latest'`
  return (rows[0]?.n as number | undefined) ?? 0
}

describe("processMediaAnalysisJob", () => {
  // preCheck resolves the Google key before any spend; with no BYOK key on the
  // test org it falls back to GOOGLE_API_KEY, which the test preload
  // (src/tests/test-env-defaults.ts) sets to a placeholder. The model call
  // itself is faked.

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug, settings)
      VALUES (${ORG}, 'JobOrg', ${`job-${ORG}`}, '{}') ON CONFLICT (id) DO UPDATE SET settings = '{}'`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER}, ${ORG}, 'job@test.com', 'Job User', 'x') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.model_pricing
      (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, source)
      VALUES ('google', 'gemini-flash-lite-latest', 'Gemini Flash Lite', '0.09000000', '0.35000000', 1000000, true, 'manual')
      ON CONFLICT (provider, model_id) DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.files WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  beforeEach(async () => {
    await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.files WHERE org_id = ${ORG}`
  })

  function deps(
    client: GenaiFilesClient,
    over: Partial<MediaAnalysisJobDeps> = {},
  ): MediaAnalysisJobDeps {
    return {
      getObjectBuffer: mock(async () => makeMp4(1024)),
      genaiClientFactory: () => client,
      // Deterministic passthrough — the real normalizer would spawn ffmpeg/ffprobe
      // on the fake MP4 fixture. The normalizer is covered by media-normalize.test.ts.
      normalizeMedia: mock(async (buffer: Buffer, detectedMime: string) => ({
        buffer,
        mime: detectedMime,
        kind: "video" as const,
      })),
      pollIntervalMs: 1,
      pollMaxAttempts: 5,
      ...over,
    }
  }

  it("happy path: uploads a Blob, polls to ACTIVE, generates, bills a real user", async () => {
    const id = "00000000-0000-4000-8000-00000000a001"
    await seedVideo(id)
    const client = fakeClient(["PROCESSING", "ACTIVE"])
    // Use the REAL finalizeUsage so the credit_transactions row is written
    // (the PRIMARY row-count assertion); the SDK boundary is still mocked.
    await processMediaAnalysisJob(basePayload(id), deps(client))
    // Upload was fed a Blob, not a raw Buffer.
    const uploadArg = (client.files.upload as unknown as { mock: { calls: [{ file: unknown }][] } })
      .mock.calls[0][0]
    expect(uploadArg.file instanceof Blob).toBe(true)
    const [row] =
      await sql`SELECT analysis_status, analysis_summary, analysis_model FROM kernel.files WHERE id = ${id}`
    expect(row.analysis_status).toBe("done")
    expect(row.analysis_summary).toBeTruthy()
    expect(row.analysis_model).toBe("gemini-flash-lite-latest")
    expect(await creditRows()).toBe(1)
    // Billing user is the real threaded org user — NOT the zero-UUID sentinel.
    const [txn] =
      await sql`SELECT user_id, raw_cost FROM kernel.credit_transactions WHERE org_id = ${ORG}`
    expect(txn.user_id).toBe(USER)
    expect(txn.user_id).not.toBe(NIL)
    expect(Number(txn.raw_cost)).toBeGreaterThan(0)
  })

  it("userId fallback: resolves a real org user when payload.userId is absent", async () => {
    const id = "00000000-0000-4000-8000-00000000a002"
    await seedVideo(id)
    const client = fakeClient(["ACTIVE"])
    await processMediaAnalysisJob(basePayload(id, { userId: undefined }), deps(client))
    expect(await creditRows()).toBe(1)
    const [txn] = await sql`SELECT user_id FROM kernel.credit_transactions WHERE org_id = ${ORG}`
    expect(txn.user_id).toBe(USER)
    expect(txn.user_id).not.toBe(NIL)
  })

  it("FAILED state short-circuits on the first poll (does not burn attempts)", async () => {
    const id = "00000000-0000-4000-8000-00000000a003"
    await seedVideo(id)
    const client = fakeClient(["FAILED"])
    await processMediaAnalysisJob(basePayload(id), deps(client))
    const [row] =
      await sql`SELECT analysis_status, analysis_error FROM kernel.files WHERE id = ${id}`
    expect(row.analysis_status).toBe("error")
    expect(String(row.analysis_error)).toContain("video_processing_failed")
    expect((client.files.get as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(
      1,
    )
    expect(
      (client.models.generateContent as unknown as { mock: { calls: unknown[] } }).mock.calls
        .length,
    ).toBe(0)
    expect(await creditRows()).toBe(0)
  })

  it("never-ACTIVE → video_processing_timeout, no done", async () => {
    const id = "00000000-0000-4000-8000-00000000a004"
    await seedVideo(id)
    const client = fakeClient(["PROCESSING"])
    await processMediaAnalysisJob(basePayload(id), deps(client, { pollMaxAttempts: 3 }))
    const [row] =
      await sql`SELECT analysis_status, analysis_error FROM kernel.files WHERE id = ${id}`
    expect(row.analysis_status).toBe("error")
    expect(String(row.analysis_error)).toContain("video_processing_timeout")
    expect(await creditRows()).toBe(0)
  })

  it("normalize failure → error, no upload, no spend", async () => {
    const id = "00000000-0000-4000-8000-00000000a006"
    await seedVideo(id)
    const client = fakeClient(["ACTIVE"])
    const { NormalizeError } = await import("~/modules/agent/media/media-normalize")
    await processMediaAnalysisJob(
      basePayload(id),
      deps(client, {
        normalizeMedia: mock(async () => {
          throw new NormalizeError("transcode_failed", "ffmpeg transcode failed")
        }),
      }),
    )
    const [row] =
      await sql`SELECT analysis_status, analysis_error FROM kernel.files WHERE id = ${id}`
    expect(row.analysis_status).toBe("error")
    expect(String(row.analysis_error)).toContain("transcode_failed")
    expect(
      (client.files.upload as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
    ).toBe(0)
    expect(await creditRows()).toBe(0)
  })

  it("preCheck failure → error, no upload, no spend", async () => {
    const id = "00000000-0000-4000-8000-00000000a005"
    await seedVideo(id)
    const client = fakeClient(["ACTIVE"])
    const preCheck = mock(async () => ({
      allowed: false as const,
      status: 402 as const,
      persistSystemMessage: false,
      reason: "insufficient credits",
    }))
    await processMediaAnalysisJob(
      basePayload(id),
      deps(client, { preCheck: preCheck as unknown as MediaAnalysisJobDeps["preCheck"] }),
    )
    const [row] = await sql`SELECT analysis_status FROM kernel.files WHERE id = ${id}`
    expect(row.analysis_status).toBe("error")
    expect(
      (client.files.upload as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
    ).toBe(0)
    expect(await creditRows()).toBe(0)
  })

  // A45: the Gemini Files-API slow path never runs on a managed cell (a job
  // queued before the switch, or by any other path, stops with the limit).
  it("managed edition: refused with the inline limit, no key, no upload, no spend", async () => {
    const id = "00000000-0000-4000-8000-00000000a006"
    await seedVideo(id)
    const client = fakeClient(["ACTIVE"])
    const preCheck = mock(async () => ({ allowed: true as const }))
    _setEdition("managed")
    try {
      await processMediaAnalysisJob(
        basePayload(id),
        deps(client, { preCheck: preCheck as unknown as MediaAnalysisJobDeps["preCheck"] }),
      )
    } finally {
      _setEdition(null)
    }
    const [row] =
      await sql`SELECT analysis_status, analysis_error FROM kernel.files WHERE id = ${id}`
    expect(row.analysis_status).toBe("error")
    expect(row.analysis_error).toContain("too large to analyse here")
    expect(preCheck).not.toHaveBeenCalled()
    expect(
      (client.files.upload as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
    ).toBe(0)
    expect(await creditRows()).toBe(0)
  })
})
