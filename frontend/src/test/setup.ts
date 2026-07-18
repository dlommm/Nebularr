import "@testing-library/jest-dom/vitest";

// Recent Node versions ship an experimental *native* `localStorage` global
// that requires a `--localstorage-file` flag to actually persist; without
// it, `setItem`/`clear`/etc. are missing entirely. When that global exists
// before jsdom's environment is set up, vitest's jsdom pool ends up exposing
// this broken object as `window.localStorage` instead of jsdom's own working
// Storage implementation — breaking every localStorage-backed hook/component
// regardless of the host Node version's webstorage default. Swap in a small
// in-memory Storage so tests are independent of that host quirk.
function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key, value) => void store.set(key, String(value)),
    removeItem: (key) => void store.delete(key),
    clear: () => store.clear(),
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function ensureWorkingStorage(name: "localStorage" | "sessionStorage"): void {
  if (typeof window[name]?.setItem === "function") return;
  Object.defineProperty(window, name, { value: createMemoryStorage(), configurable: true });
}

ensureWorkingStorage("localStorage");
ensureWorkingStorage("sessionStorage");

// jsdom doesn't implement PointerEvent; base-ui's Checkbox/Switch/etc. read
// pointer-specific fields (pointerType, button) in their click handlers, so a
// plain MouseEvent-based click from userEvent throws "PointerEvent is not
// defined" instead of toggling. A minimal MouseEvent-backed polyfill is
// enough for those handlers to run in tests.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    pointerType: string;
    isPrimary: boolean;

    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
      this.pointerType = params.pointerType ?? "mouse";
      this.isPrimary = params.isPrimary ?? true;
    }
  }
  Object.defineProperty(window, "PointerEvent", { value: PointerEventPolyfill, configurable: true });
}
