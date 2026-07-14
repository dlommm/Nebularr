import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { api } from "./api";

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("api request contract", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let timeoutSpy: MockInstance;

  beforeEach(() => {
    fetchMock = vi.fn(async () => okJson({ status: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    timeoutSpy = vi.spyOn(AbortSignal, "timeout");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("runSync queues via wait=false so the UI never blocks on a long sync", async () => {
    await api.runSync("sonarr", "incremental");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("/api/sync/sonarr/incremental?wait=false");
  });

  it("uses the default 30s timeout for ordinary requests", async () => {
    await api.status();
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  });

  it("raises the timeout for known long-running blocking calls", async () => {
    await api.triggerMalTagSync();
    expect(timeoutSpy).toHaveBeenCalledWith(300_000);
  });

  it("keeps the fast default timeout for queued (wait=false) backlog imports", async () => {
    await api.triggerMalIngestBacklog({ import_all: true, wait: false });
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  });

  it("surfaces the API detail message on failures", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "sync already running" }), { status: 409 }),
    );
    await expect(api.runSync("sonarr", "full")).rejects.toThrow("sync already running");
  });
});
