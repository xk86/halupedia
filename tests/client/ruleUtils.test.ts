import { describe, expect, it } from "vitest";
import {
  parseSelectorList,
  slugifyRuleId,
} from "../../src/client/admin/prompts/ruleUtils";

describe("rules editor utilities", () => {
  it("slugifies human rule text into a bounded snake-case id", () => {
    expect(slugifyRuleId("  Never Hedge — or Disclaim! ")).toBe(
      "never_hedge_or_disclaim",
    );
  });

  it("parses comma and newline separated selectors", () => {
    expect(
      parseSelectorList("tone, canon@1-2\nformatting/no_raw_html"),
    ).toEqual(["tone", "canon@1-2", "formatting/no_raw_html"]);
  });
});
