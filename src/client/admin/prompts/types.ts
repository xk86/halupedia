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
  include: string[];
  exclude?: string[];
}

export interface RuleDefinition {
  id: string;
  tier: 1 | 2 | 3 | 4;
  text: string;
  overrides?: string[];
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
  /** Read-only in this editor — see promptEditor.ts for why. */
  localRules?: RuleDefinition[];
  rulesPreview?: string;
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
