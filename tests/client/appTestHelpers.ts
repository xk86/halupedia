import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

export function setPath(path: string) {
  window.history.replaceState({}, "", path);
}

// The article/instruction editors are ProseKit (WYSIWYG) — its contenteditable
// surface can't be driven in jsdom, but its "Raw markdown" footer toggle reveals
// a plain textarea that round-trips the same value. Use that to set editor text
// deterministically. Pass an index when more than one editor is on screen.
export async function setRichEditorMarkdown(
  markdown: string,
  editorIndex = 0,
) {
  const toggles = screen.getAllByRole("button", { name: "Raw markdown" });
  await userEvent.click(toggles[editorIndex]);
  const textareas = document.querySelectorAll<HTMLTextAreaElement>(
    ".mdedit-raw-textarea",
  );
  const textarea =
    textareas[textareas.length === toggles.length ? editorIndex : 0];
  fireEvent.change(textarea, { target: { value: markdown } });
}

// Minimal well-shaped stand-ins for the homepage/top-articles endpoints —
// Homepage reads `data.didYouKnow.length` / `data.articles`, so a shared
// article-page payload (wrong shape) crashes it with "Cannot read properties
// of undefined (reading 'length')".
export function emptyHomepagePayload() {
  return {
    featured: null,
    didYouKnow: [],
    generatedAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
  };
}
export function emptyTopArticlesPayload() {
  return { articles: [] };
}

// The Sidebar subscribes to /api/article/:slug/live as soon as an article
// route is active — concurrently with the page-data fetch. Test fixtures
// built around a single shared mocked Response (mockResolvedValue / a fixed
// Response instance returned for every URL) break once that body is read
// twice ("Body is unusable: Body has already been read"). Wrapping the test's
// fetch implementation so /live requests short-circuit with a non-ok response
// (Sidebar bails out on `!res.ok` without touching the body) keeps the shared
// fixture pattern working without each test having to special-case /live.
export function withLiveBypass(
  impl: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response> | Response,
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (/\/live(\?|$)/.test(String(input))) {
      return new Response(null, { status: 404 });
    }
    return impl(input, init);
  });
}

export function pagePayload(overrides: Partial<any> = {}) {
  return {
    cached: true,
    article: {
      slug: "test-article",
      canonicalSlug: "test-article",
      title: "Test Article",
      html: '<h1>Test Article</h1><p>Body copy with <a href="/wiki/Linked_Article">Linked Article</a>.</p>',
      markdown:
        '# Test Article\n\nBody copy with [Linked Article](halu:linked-article "Hidden hint").',
      plain_text: "Body copy with Linked Article.",
      generated_at: 1715000000000,
    },
    backlinks: {
      existing: [
        {
          slug: "linking-article",
          title: "Linking Article",
          visibleLabel: "Test Article",
          hiddenHint: "Seed backlink",
          createdAt: 1715000000001,
        },
      ],
      unwritten: [],
    },
    ...overrides,
  };
}

export function ndjsonResponse(events: unknown[]) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8" },
  });
}
