export const OPTIONAL_OLLAMA_PARAMETER_DEFINITIONS = [
  { key: "num_ctx", type: "int", min: 1, step: 1 },
  { key: "repeat_last_n", type: "int", min: -1, step: 1 },
  { key: "repeat_penalty", type: "float", step: 0.1 },
  { key: "seed", type: "int", step: 1 },
  { key: "draft_num_predict", type: "int", min: 0, step: 1 },
  { key: "top_k", type: "int", min: 0, step: 1 },
  { key: "top_p", type: "float", min: 0, step: 0.01 },
  { key: "min_p", type: "float", min: 0, step: 0.01 },
] as const;

export type OptionalOllamaParameterKey =
  (typeof OPTIONAL_OLLAMA_PARAMETER_DEFINITIONS)[number]["key"];

export const OPTIONAL_OLLAMA_PARAMETER_KEYS =
  OPTIONAL_OLLAMA_PARAMETER_DEFINITIONS.map(
    ({ key }) => key,
  ) as readonly OptionalOllamaParameterKey[];
