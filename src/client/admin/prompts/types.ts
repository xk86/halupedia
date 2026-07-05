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

export interface PromptContent extends PromptMeta {
  system: string;
  user: string;
  path: string;
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
