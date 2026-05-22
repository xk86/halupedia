/**
 * Strictly-typed node factory.
 *
 * Every pipeline node is defined via `defineNode`, which forces three things
 * at compile time and one thing at runtime:
 *
 *   1. The `reads` and `writes` arrays must be subsets of `PipelineStateKey`.
 *   2. The `run` function receives a typed `inputs` view that includes ONLY
 *      the declared `reads` fields — accessing anything else is a TS error.
 *   3. The `run` function MUST return a patch whose keys are a subset of the
 *      declared `writes` fields — accidentally writing something undeclared
 *      is a TS error.
 *   4. At runtime, the graph runner asserts (1)–(3) again as a safety net
 *      for paths that escape the type system (e.g. dynamic patches).
 *
 * These constraints are what makes the system traceable without manual
 * logging: the runtime knows exactly what each node read and what it wrote.
 *
 * Nodes are stateless. All side effects (DB, LLM, filesystem) come in via
 * `deps`, which is the typed dependency bag a workflow supplies at compile
 * time. This keeps nodes pure-by-shape and trivially testable.
 */

import type { PipelineState, PipelineStateKey, PipelineStatePatch } from "../state";

/** Categories used by the graph viz + trace UI; not enforced semantically. */
export type NodeKind = "read" | "llm" | "transform" | "validate" | "write";

/**
 * The subset of `PipelineState` that contains only the keys in `K`.
 * Required fields stay required; everything else is removed.
 */
export type StateSubset<K extends PipelineStateKey> = {
  [P in K]: PipelineState[P];
};

/**
 * The patch a node returns. Only declared `writes` are allowed.
 * `undefined` is permitted so a node can explicitly clear a sidecar field.
 */
export type StatePatch<W extends PipelineStateKey> = {
  [P in W]?: PipelineState[P];
};

/**
 * Definition of a pipeline node. `Deps` is the dependency bag (db, llm, etc.)
 * — narrowly typed by each node so a node that only needs the light LLM
 * client can't accidentally call the heavy one.
 */
export interface NodeDefinition<
  Reads extends PipelineStateKey,
  Writes extends PipelineStateKey,
  Deps,
> {
  /**
   * Stable, unique node name. Used as the LangGraph node id and as the
   * primary key for trace rows. Convention: `category.action` — for example
   * `read.article`, `llm.generate_article`, `transform.normalize_links`.
   */
  name: string;
  kind: NodeKind;
  /** Human-readable single sentence describing what this node does. */
  description?: string;
  reads: readonly Reads[];
  writes: readonly Writes[];
  /**
   * The actual work. Receives the declared subset of state plus deps.
   * Returns a patch — fields the node updates. The runtime merges this
   * patch into the state and records the diff.
   *
   * Throw on invariant violation (validation nodes especially). Throws
   * surface in the trace as the run's failure cause.
   */
  run(
    inputs: StateSubset<Reads>,
    deps: Deps,
  ): Promise<StatePatch<Writes>> | StatePatch<Writes>;
}

/**
 * Erased node type for storage inside a graph definition. The Reads/Writes
 * parameters are widened to `PipelineStateKey` so heterogeneous nodes can
 * sit in the same array, but the original generic bindings are preserved
 * inside `definition` for inspection.
 */
export interface CompiledNode<Deps = unknown> {
  name: string;
  kind: NodeKind;
  description?: string;
  reads: readonly PipelineStateKey[];
  writes: readonly PipelineStateKey[];
  run(
    inputs: Partial<PipelineState>,
    deps: Deps,
  ): Promise<PipelineStatePatch> | PipelineStatePatch;
}

/**
 * Define a node. Use this for every read/llm/transform/validate/write node.
 *
 * Example:
 *
 *   export const loadArticleNode = defineNode({
 *     name: "read.article",
 *     kind: "read",
 *     reads: ["input"] as const,
 *     writes: ["loadedArticle"] as const,
 *     run: ({ input }, deps: { db: DatabaseSync }) => {
 *       const article = input.slug ? loadArticle(deps.db, input.slug) : null;
 *       return { loadedArticle: article };
 *     },
 *   });
 */
export function defineNode<
  Reads extends PipelineStateKey,
  Writes extends PipelineStateKey,
  Deps,
>(def: NodeDefinition<Reads, Writes, Deps>): CompiledNode<Deps> {
  // Sanity check: no duplicate declarations.
  const readSet = new Set(def.reads);
  const writeSet = new Set(def.writes);
  if (readSet.size !== def.reads.length) {
    throw new Error(`node ${def.name}: duplicate keys in reads`);
  }
  if (writeSet.size !== def.writes.length) {
    throw new Error(`node ${def.name}: duplicate keys in writes`);
  }

  return {
    name: def.name,
    kind: def.kind,
    description: def.description,
    reads: def.reads,
    writes: def.writes,
    async run(state, deps) {
      // Build the read-only inputs view. Even though TS forbids accessing
      // undeclared fields inside `run`, we copy explicitly so runtime
      // tampering with the source state cannot leak in either.
      const inputs = {} as StateSubset<Reads>;
      for (const key of def.reads) {
        (inputs as Record<string, unknown>)[key] = (
          state as Record<string, unknown>
        )[key];
      }
      const patch = await def.run(inputs, deps);

      // Runtime guard: reject undeclared writes. This protects against
      // dynamic patch shapes (e.g. nodes that compute their patch object).
      for (const key of Object.keys(patch)) {
        if (!writeSet.has(key as Writes)) {
          throw new Error(
            `node ${def.name}: returned undeclared write '${key}' ` +
              `(declared writes: ${def.writes.join(", ") || "<none>"})`,
          );
        }
      }
      return patch as PipelineStatePatch;
    },
  };
}
