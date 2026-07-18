import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { api, ApiError } from "./api";

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

  it("throws an ApiError preserving status and detail for a JSON error body (e.g. 429)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "too many attempts" }), { status: 429 }),
    );
    const failure = api.authLogin("wrong");
    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(failure).rejects.toMatchObject({ status: 429, detail: "too many attempts" });
  });

  it("throws a friendly ApiError when a 2xx response body isn't valid JSON", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    const failure = api.status();
    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(failure).rejects.toMatchObject({ status: 0, detail: "invalid response from server" });
  });

  it("sends X-Setup-Token on setup mutations only when a token is provided", async () => {
    await api.setupSkip("bootstrap-token-123");
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["X-Setup-Token"]).toBe("bootstrap-token-123");

    fetchMock.mockClear();
    await api.setupSkip();
    const headersWithoutToken = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headersWithoutToken?.["X-Setup-Token"]).toBeUndefined();
  });

  it("still sets content-type alongside X-Setup-Token for JSON-bodied setup mutations", async () => {
    await api.setupWizard({ foo: "bar" }, "tok");
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["X-Setup-Token"]).toBe("tok");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("sends X-Setup-Token on setupBootstrapDatabase too (also gated server-side)", async () => {
    await api.setupBootstrapDatabase(
      { admin_database_url: "postgresql://x", database_name: "db", arrapp_password: "pw" },
      "tok",
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["X-Setup-Token"]).toBe("tok");
  });
});

describe("api pagination and export helpers", () => {
  let fetchMock2: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock2 = vi.fn(async () => okJson({ items: [], total: 0, limit: 50, offset: 0, has_more: false }));
    vi.stubGlobal("fetch", fetchMock2);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("webhookJobs requests the paged shape", async () => {
    await api.webhookJobs("retrying", 50, 0);
    const [url] = fetchMock2.mock.calls[0] as [string];
    expect(url).toContain("paged=true");
    expect(url).toContain("status=retrying");
  });

  it("reportingPanelExportUrl keeps limit=0 for full-dataset export", () => {
    const url = api.reportingPanelExportUrl("dash", "panel", { limit: 0 });
    expect(url).toContain("limit=0");
  });
});
