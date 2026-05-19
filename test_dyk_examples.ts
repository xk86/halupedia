/**
 * Mock dependencies for testing src/server/dyk.ts functions.
 */
import { ensureDykHasSourceLink, normalizeDykLinks, normalizeHomepageFact } from "./server/dyk";

// --- Mocking Dependencies ---

// Mock LlmClient (since we are only testing utility functions)
class MockLlmClient {
    chat(system, user, options) {
        return Promise.resolve("Some mocked LLM response.");
    }
}

// Mock loadConfig
const loadConfig = () => ({
    prompts: {
        did_you_know: {
            model: "default",
            system: "System prompt",
            user: "User prompt",
            thinking: "Thinking prompt"
        }
    }
});

// Mock stripTopLevelSections
const stripTopLevelSections = (markdown, sections) => markdown.substring(0, 100);

// Mock slugify
const slugify = (str) => str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// --- Test Cases ---

console.log("========================================================");
console.log("=== Testing normalizeDykLinks: Link Conversion ===");
console.log("========================================================");

// Case 1: Basic halu: link conversion
const fact1 = "This is a fact about halu:the-world and another one about halu:big-things.";
const normalized1 = normalizeDykLinks(fact1);
console.log(`Input: ${fact1}`);
console.log(`Output: ${normalized1}`);

// Case 2: Link with special characters and no halu: prefix (should be untouched)
const fact2 = "It's a fact about non-halu:links like [Title](https://example.com/test).";
const normalized2 = normalizeDykLinks(fact2);
console.log(`\nInput: ${fact2}`);
console.log(`Output: ${normalized2}`);

// Case 3: Empty link (should be untouched)
const fact3 = "This link is bad: [Title]().";
const normalized3 = normalizeDykLinks(fact3);
console.log(`\nInput: ${fact3}`);
console.log(`Output: ${normalized3}`);


console.log("\n========================================================");
console.log("=== Testing ensureDykHasSourceLink: Linking Logic ===");
console.log("========================================================");

// Setup context for linking tests
const slug = "test-slug";
const title = "Test Article";

// Case 4: Fact with no existing links (should prepend link)
const fact4 = "This is the original fact.";
const linked4 = ensureDykHasSourceLink(fact4, slug, title);
console.log(`\n--- Test 4: No initial links ---`);
console.log(`Input: "${fact4}"`);
console.log(`Result: ${linked4}`);

// Case 5: Fact already containing a plain Markdown link (should preserve it)
const fact5 = "This fact already mentions [Other Title](/other-slug).";
const linked5 = ensureDykHasSourceLink(fact5, slug, title);
console.log(`\n--- Test 5: Preserving existing link ---`);
console.log(`Input: "${fact5}"`);
console.log(`Result: ${linked5}`);

// Case 6: Fact starting with "..." and needing source link
const fact6 = "Amazing stuff!";
const linked6 = ensureDykHasSourceLink(fact6, slug, title);
console.log(`\n--- Test 6: Starting with "..." ---`);
console.log(`Input: "${fact6}"`);
console.log(`Result: ${linked6}`);

console.log("\n========================================================");
console.log("=== Testing normalizeHomepageFact: Cleaning Output ===");
console.log("========================================================");

// Case 7: Raw output with excess whitespace, quotes, and starting filler
const raw7 = '   "  Did You Know.   "    ';
const cleaned7 = normalizeHomepageFact(raw7);
console.log(`\nInput: "${raw7}"`);
console.log(`Output: "${cleaned7}"`);

// Case 8: Raw output that should result in nothing
const raw8 = '... .';
const cleaned8 = normalizeHomepageFact(raw8);
console.log(`\nInput: "${raw8}"`);
console.log(`Output: "${cleaned8}"`);

