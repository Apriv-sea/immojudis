import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc },
}));

import {
  dispatchDuePipeline,
  retryAfterAt,
  retryableDispatchStatus,
} from "@/lib/pipeline-dispatch";

const run = {
  id: "11111111-1111-4111-8111-111111111111",
  source: "licitor",
  mode: "collect" as const,
  attempt: 1,
  max_attempts: 4,
};

describe("autonomous GitHub dispatch retries", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_SCROLL_TOKEN", "dispatch-token");
    vi.stubEnv("GITHUB_SCROLL_REPOSITORY", "Aprivi-dev/immojudis");
    vi.stubEnv("GITHUB_SCROLL_REF", "main");
    mocks.rpc.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("records an accepted dispatch and never schedules a retry", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: run, error: null })
      .mockResolvedValueOnce({ data: { updated: true, state: "accepted" }, error: null });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchImpl);

    await expect(dispatchDuePipeline()).resolves.toMatchObject({
      dispatched: true,
      runId: run.id,
      attempt: 1,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      "record_autonomous_pipeline_dispatch",
      expect.objectContaining({ p_run_id: run.id, p_attempt: 1, p_outcome: "accepted" }),
    );
  });

  it("stores Retry-After while retaining the 15-minute minimum", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T09:00:00.000Z"));
    mocks.rpc
      .mockResolvedValueOnce({ data: run, error: null })
      .mockResolvedValueOnce({ data: { updated: true, state: "retry_wait" }, error: null });
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 500, headers: { "Retry-After": "3600" } })),
    );

    await expect(dispatchDuePipeline()).rejects.toThrow(
      "retry scheduled for 2026-09-13T10:00:00.000Z",
    );
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      "record_autonomous_pipeline_dispatch",
      expect.objectContaining({
        p_outcome: "rejected",
        p_status: 500,
        p_retryable: true,
        p_retry_after_at: "2026-09-13T10:00:00.000Z",
      }),
    );
  });

  it("retries persistence of a known HTTP result without losing status or Retry-After", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T09:00:00.000Z"));
    mocks.rpc
      .mockResolvedValueOnce({ data: run, error: null })
      .mockRejectedValueOnce(new Error("result RPC transport uncertain"))
      .mockResolvedValueOnce({ data: { updated: true, state: "retry_wait" }, error: null });
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 500, headers: { "Retry-After": "7200" } })),
    );

    await expect(dispatchDuePipeline()).rejects.toThrow(
      "retry scheduled for 2026-09-13T11:00:00.000Z",
    );
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      3,
      "record_autonomous_pipeline_dispatch",
      expect.objectContaining({
        p_run_id: run.id,
        p_attempt: 1,
        p_outcome: "rejected",
        p_status: 500,
        p_retry_after_at: "2026-09-13T11:00:00.000Z",
        p_retryable: true,
      }),
    );
  });

  it("does not rapidly repeat credential and permission failures", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: run, error: null })
      .mockResolvedValueOnce({ data: { updated: true, state: "terminal" }, error: null });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 })),
    );

    await expect(dispatchDuePipeline()).rejects.toThrow("operator action required");
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      "record_autonomous_pipeline_dispatch",
      expect.objectContaining({ p_status: 403, p_retryable: false }),
    );
  });

  it("records a timeout as uncertain so a later tick can retry the same run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T09:00:00.000Z"));
    mocks.rpc
      .mockResolvedValueOnce({ data: run, error: null })
      .mockResolvedValueOnce({ data: { updated: true, state: "retry_wait" }, error: null });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("request timed out")));

    await expect(dispatchDuePipeline()).rejects.toThrow("request timed out");
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      "record_autonomous_pipeline_dispatch",
      expect.objectContaining({
        p_run_id: run.id,
        p_attempt: 1,
        p_outcome: "unknown",
        p_retry_after_at: null,
      }),
    );
  });

  it("does not claim or fetch when the dispatch token is missing", async () => {
    vi.stubEnv("GITHUB_SCROLL_TOKEN", "");
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchImpl);

    await expect(dispatchDuePipeline()).rejects.toThrow("Pipeline dispatch token missing");
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("dispatch retry helpers", () => {
  it("parses seconds and HTTP dates", () => {
    const now = new Date("2026-09-13T09:00:00.000Z");
    expect(retryAfterAt("60", now)?.toISOString()).toBe("2026-09-13T09:01:00.000Z");
    expect(retryAfterAt("Sun, 13 Sep 2026 10:00:00 GMT", now)?.toISOString()).toBe(
      "2026-09-13T10:00:00.000Z",
    );
    expect(retryAfterAt("invalid", now)).toBeNull();
  });

  it("keeps 401 and 403 out of the transient retry class", () => {
    expect(retryableDispatchStatus(401)).toBe(false);
    expect(retryableDispatchStatus(403)).toBe(false);
    expect(retryableDispatchStatus(429)).toBe(true);
    expect(retryableDispatchStatus(500)).toBe(true);
  });
});
