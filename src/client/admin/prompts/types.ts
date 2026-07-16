export interface PromptMeta {
  key: string;
  scope: "runnable" | "shared";
  description: string;
  usedBy: string[];
  model?: "heavy" | "light";
  thinking?: boolean;
  json?: boolean;
  hasModes: boolean;
}

export interface RuleSpec {
  categories: string[];
  rules?: string[];
}

export interface RuleDefinition {
  id: string;
  category?: string;
  tier: 1 | 2 | 3 | 4;
  text: string;
  overrides?: string[];
  examples?: RuleExample[];
}

export interface RuleExample {
  description: string;
  text: string;
}

export interface RuleCategory {
  id: string;
  title: string;
  description: string;
  order: number;
  rules: RuleDefinition[];
}

export interface PromptContent extends PromptMeta {
  system: string;
  user: string;
  path: string;
  rules?: RuleSpec;
  localRules?: RuleDefinition[];
  rulesPreview?: string;
}

export interface RuleLibraryPayload {
  categories: RuleCategory[];
  rules: RuleDefinition[];
}

export interface PromptList {
  runnable: PromptMeta[];
  shared: PromptMeta[];
}

export interface PromptRevision {
  id: number;
  scope: string;
  key: string;
  createdAt: number;
  source: string;
  sourceRevisionId: number | null;
}
