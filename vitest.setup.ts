import "@testing-library/jest-dom/vitest";

Object.defineProperty(window, "scrollTo", {
  writable: true,
  value: () => {},
});

// jsdom lacks the pointer-capture / scroll APIs that Base UI's popups (Select,
// etc.) call during open/close. Stub them so component interaction tests work.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
// ProseKit's inline-popover web component (via aria-ui) calls getAnimations on
// the host element when it connects; jsdom doesn't implement the Web Animations
// API, so stub it to an empty list.
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
// jsdom doesn't expose localStorage under an opaque document origin (which is
// what vitest's jsdom environment uses by default). Theme persistence tests
// need it, so provide a minimal in-memory Storage when it's absent.
if (!("localStorage" in window) || window.localStorage == null) {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => void store.delete(key),
    setItem: (key, value) => void store.set(key, String(value)),
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
