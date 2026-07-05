/**
 * Surgical `config/ontology.toml` edits for the vocabulary review tool: append
 * new `[[predicates]]` blocks, remove existing ones by name, and route
 * label_predicates additions through the generic dotted-table editor. Scoped
 * to exactly this file's two table shapes — not a general TOML writer (see
 * `tomlEdit.ts`'s header comment for why: preserving the hand-written comments
 * in this file matters more than a from-scratch regeneration would save).
 */
import { setTomlTableValue } from "../tomlEdit";
import type { PredicateAdditionProposal } from "./vocabularyReview";

const HEADER_RE = /^\s*\[\[predicates\]\]\s*(#.*)?$/;
const ANY_HEADER_RE = /^\s*\[/;
const NAME_RE = /^\s*name\s*=\s*["']([^"']+)["']/;

function eolOf(source: string): string {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

/** Render one `[[predicates]]` block, omitting unset optional keys — matches
 *  the style of the hand-written blocks in ontology.toml. */
function renderPredicateBlock(p: PredicateAdditionProposal): string[] {
  const lines = [
    "[[predicates]]",
    `name = ${JSON.stringify(p.name)}`,
    `arity = ${JSON.stringify(p.arity)}`,
    `subject = ${JSON.stringify(p.subject)}`,
    `object = ${JSON.stringify(p.object)}`,
    `label = ${JSON.stringify(p.label)}`,
  ];
  if (p.symmetric) lines.push("symmetric = true");
  if (p.transitive) lines.push("transitive = true");
  if (p.inverse) lines.push(`inverse = ${JSON.stringify(p.inverse)}`);
  return lines;
}

/**
 * Append `[[predicates]]` blocks for each addition, inserted right before the
 * `[label_predicates]` table (so predicates stay grouped together as in the
 * hand-authored file) or at end of file if that table isn't present. Also
 * writes each addition's `labelMappings` into `[label_predicates]`.
 */
export function appendPredicates(source: string, additions: PredicateAdditionProposal[]): string {
  if (additions.length === 0) return source;
  const eol = eolOf(source);
  const lines = source.split(/\r?\n/);
  const labelPredicatesIdx = lines.findIndex((l) => /^\s*\[label_predicates\]\s*(#.*)?$/.test(l));

  const blocks: string[] = [];
  for (const addition of additions) {
    blocks.push(...renderPredicateBlock(addition), "");
  }

  let next: string;
  if (labelPredicatesIdx === -1) {
    const sep = source.length > 0 && !source.endsWith("\n") ? eol + eol : eol;
    next = `${source}${sep}${blocks.join(eol)}${eol}`;
  } else {
    const before = lines.slice(0, labelPredicatesIdx);
    const after = lines.slice(labelPredicatesIdx);
    next = [...before, ...blocks, ...after].join(eol);
  }

  for (const addition of additions) {
    for (const label of addition.labelMappings) {
      next = setTomlTableValue(next, "label_predicates", label, addition.name);
    }
  }
  return next;
}

/** Remove the `[[predicates]]` blocks matching any of `names`, whole block
 *  (header through its trailing blank line) — everything else untouched. */
export function removePredicates(source: string, names: string[]): string {
  if (names.length === 0) return source;
  const wanted = new Set(names);
  const eol = eolOf(source);
  const lines = source.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (HEADER_RE.test(lines[i])) {
      let end = i + 1;
      while (end < lines.length && !ANY_HEADER_RE.test(lines[end])) end++;
      const block = lines.slice(i, end);
      const nameLine = block.find((l) => NAME_RE.test(l));
      const name = nameLine?.match(NAME_RE)?.[1];
      if (name && wanted.has(name)) {
        // Drop the block and one immediately-following blank separator line,
        // so removing a predicate doesn't leave a double-blank gap.
        i = end < lines.length && lines[end].trim() === "" ? end + 1 : end;
        continue;
      }
    }
    out.push(lines[i]);
    i++;
  }
  return out.join(eol);
}
