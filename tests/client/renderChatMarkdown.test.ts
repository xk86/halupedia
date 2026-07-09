import { describe, expect, it } from "vitest";
import { renderChatMarkdown } from "../../src/client/chat/renderChatMarkdown";
import type { ChatReference } from "../../src/client/chat/types";

const refs: ChatReference[] = [
  { slug: "test-10", title: "Test 10" },
  { slug: "bingus-test", title: "Bingus test" },
];

describe("renderChatMarkdown", () => {
  it("resolves a well-formed [Title](ref:slug) citation to a real /wiki/ link", () => {
    const html = renderChatMarkdown("See [Test 10](ref:test-10) for details.", refs);
    expect(html).toContain('href="/wiki/Test_10"');
    expect(html).toContain("Test 10");
  });

  it("corrects a raw-slug link text to the reference's real title", () => {
    const html = renderChatMarkdown("See [test-10](ref:test-10) for details.", refs);
    expect(html).toContain('href="/wiki/Test_10"');
    expect(html).not.toMatch(/>test-10</);
  });

  it("promotes a bare [slug] bracket naming a known reference to a real link", () => {
    const html = renderChatMarkdown("A bare [test-10] artifact.", refs);
    expect(html).toContain('href="/wiki/Test_10"');
  });

  it("leaves a non-slug-shaped bare bracket untouched", () => {
    const html = renderChatMarkdown("The term is used loosely [sic] here.", refs);
    expect(html).toContain("[sic]");
  });

  it("promotes a bracket-less 'Title (ref:slug)' citation to a real link", () => {
    const html = renderChatMarkdown(
      "Research points to protocols like Test 10 (ref:test-10), which helps.",
      refs,
    );
    expect(html).toContain('href="/wiki/Test_10"');
    expect(html).not.toMatch(/\(ref:test-10\)/);
    // The redundant preceding "Test 10" text is folded into the single link,
    // not duplicated.
    expect(html.match(/Test 10/g)?.length).toBe(1);
  });

  it("promotes a bracket-less citation for a multi-word title", () => {
    const html = renderChatMarkdown(
      "Furthermore, there is information on the Bingus test (ref:bingus-test) here.",
      refs,
    );
    expect(html).toContain('href="/wiki/Bingus_test"');
    expect(html.match(/Bingus test/g)?.length).toBe(1);
  });

  it("still emits a well-formed URL for an unknown bracket-less citation", () => {
    const html = renderChatMarkdown("See Extreme testing (ref:extreme-testing) too.", refs);
    expect(html).toContain('href="/wiki/Extreme_testing"');
  });
});
