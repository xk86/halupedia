import { describe, expect, it } from "vitest";
import { toWikiSegment, articleInputToWikiSegment } from "../../src/client/wikiPath";

describe("toWikiSegment", () => {
  it("replaces spaces with underscores", () => {
    expect(toWikiSegment("hello world")).toBe("Hello_world");
  });

  it("capitalises the first letter", () => {
    expect(toWikiSegment("structural coatings")).toBe("Structural_coatings");
  });

  it("preserves existing underscores and hyphens", () => {
    expect(toWikiSegment("human-horse hybrids")).toBe("Human-horse_hybrids");
  });

  it("preserves emoji", () => {
    expect(toWikiSegment("cat 🐱 article")).toBe("Cat_🐱_article");
  });

  it("preserves unicode letters", () => {
    expect(toWikiSegment("союз советских")).toBe("Союз_советских");
  });

  it("preserves accented characters", () => {
    expect(toWikiSegment("le béton")).toBe("Le_béton");
  });

  it("strips bare control characters but keeps safe punctuation", () => {
    expect(toWikiSegment("title (disambiguation)")).toBe("Title_(disambiguation)");
  });

  it("strips markdown syntax characters like asterisks", () => {
    expect(toWikiSegment("*Algebra*")).toBe("Algebra");
    expect(toWikiSegment("**Bold Title**")).toBe("Bold_Title");
  });
});

describe("articleInputToWikiSegment", () => {
  it("normalises a plain title with spaces", () => {
    expect(articleInputToWikiSegment("Differences in penis size")).toBe("Differences_in_penis_size");
  });

  it("normalises a title that contains hyphens (previous bug: was returned raw with spaces)", () => {
    // Before fix: contained '-' so the early-return path left spaces in the segment.
    expect(articleInputToWikiSegment("Differences in penis size between humans and human-horse hybrids"))
      .toBe("Differences_in_penis_size_between_humans_and_human-horse_hybrids");
  });

  it("strips /wiki/ prefix from a pasted URL", () => {
    expect(articleInputToWikiSegment("/wiki/Structural_coatings")).toBe("Structural_coatings");
  });

  it("strips full origin + /wiki/ prefix", () => {
    expect(articleInputToWikiSegment("http://cat-macbook:8787/wiki/Structural_coatings")).toBe("Structural_coatings");
  });

  it("handles emoji in title", () => {
    expect(articleInputToWikiSegment("cats 🐱 and dogs")).toBe("Cats_🐱_and_dogs");
  });

  it("returns empty string for empty input", () => {
    expect(articleInputToWikiSegment("")).toBe("");
    expect(articleInputToWikiSegment("   ")).toBe("");
  });

  it("strips query string and hash from pasted URL", () => {
    expect(articleInputToWikiSegment("/wiki/Foo_bar?ref=x#section")).toBe("Foo_bar");
  });
});
