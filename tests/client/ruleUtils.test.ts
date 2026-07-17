import { describe, expect, it } from "vitest";
import {
  humanizeRuleId,
  slugifyRuleId,
} from "../../src/client/admin/prompts/ruleUtils";

describe("rules editor utilities", () => {
  it("slugifies human rule text into a bounded snake-case id", () => {
    expect(slugifyRuleId("  Never Hedge — or Disclaim! ")).toBe(
      "never_hedge_or_disclaim",
    );
  });

  it("turns stored rule ids into human-readable names", () => {
    expect(humanizeRuleId("no_fictional_label")).toBe("No fictional label");
  });
});
