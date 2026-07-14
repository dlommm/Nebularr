import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { ActionErrorProvider } from "./ActionErrorContext";
import { useActionError } from "../hooks/useActionError";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe("runAction", () => {
  let queryClient: QueryClient;
  let invalidateSpy: MockInstance;

  const wrapper = ({ children }: { children: ReactNode }): JSX.Element => (
    <QueryClientProvider client={queryClient}>
      <ActionErrorProvider>{children}</ActionErrorProvider>
    </QueryClientProvider>
  );

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient();
    invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  });

  it("toasts on success only when a message is provided and invalidates extra keys", async () => {
    const { result } = renderHook(() => useActionError(), { wrapper });
    await act(async () => {
      await result.current.runAction(async () => "ok", "test action", {
        successMessage: "Done!",
        invalidate: [["shows"], ["movies"]],
      });
    });
    expect(toast.success).toHaveBeenCalledWith("Done!");
    const invalidated = invalidateSpy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(invalidated).toContain(JSON.stringify(["shows"]));
    expect(invalidated).toContain(JSON.stringify(["movies"]));
    expect(invalidated).toContain(JSON.stringify(["work-status"]));
  });

  it("stays quiet on success without a message", async () => {
    const { result } = renderHook(() => useActionError(), { wrapper });
    await act(async () => {
      await result.current.runAction(async () => "ok", "quiet action");
    });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("records the error and toasts on failure", async () => {
    const { result } = renderHook(() => useActionError(), { wrapper });
    await act(async () => {
      await result.current.runAction(async () => {
        throw new Error("backend exploded");
      }, "failing action");
    });
    expect(result.current.lastError).toBe("backend exploded");
    expect(result.current.errorContext).toBe("failing action");
    expect(toast.error).toHaveBeenCalledWith("failing action failed");
  });
});
