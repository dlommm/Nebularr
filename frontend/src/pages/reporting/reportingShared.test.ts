import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadCsv } from "./reportingShared";

// jsdom lacks the object-URL APIs and Blob.text(); stub Blob to capture the
// CSV string directly and mock createObjectURL/revoke to observe calls.
const blobParts: string[] = [];
const createObjectURL = vi.fn(() => "blob:mock");
const revokeObjectURL = vi.fn();

beforeEach(() => {
  blobParts.length = 0;
  createObjectURL.mockClear();
  URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
  vi.stubGlobal(
    "Blob",
    class {
      constructor(parts: string[]) {
        blobParts.push(parts.join(""));
      }
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("downloadCsv", () => {
  it("escapes cells containing commas, quotes, and newlines", () => {
    const created: HTMLAnchorElement[] = [];
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "a") {
        const anchor = { href: "", download: "", click: vi.fn() } as unknown as HTMLAnchorElement;
        created.push(anchor);
        return anchor;
      }
      return origCreate(tag);
    });

    downloadCsv("out.csv", [{ title: "a, b", note: 'has "quote"' }]);

    expect(created[0].download).toBe("out.csv");
    expect(created[0].click).toHaveBeenCalled();
    const text = blobParts[0];
    expect(text.split("\n")[0]).toBe("title,note");
    expect(text).toContain('"a, b"');
    expect(text).toContain('"has ""quote"""');
  });

  it("does nothing for empty rows", () => {
    downloadCsv("out.csv", []);
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
