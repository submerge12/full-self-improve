import type { SourceAdapter } from "../engine/source-adapter.js";
import { MarkdownVaultAdapter } from "./markdown-vault.js";

export const DEFAULT_MARKDOWN_VAULT_ADAPTER_ID = "holly-vault";
export const DEFAULT_MARKDOWN_VAULT_INCLUDE = ["**/*.md"];
export const DEFAULT_MARKDOWN_VAULT_EXCLUDE = [
  "90_待确认/**",
  "private/**",
  "draft/**",
  "**/drafts/**",
  "**/draft-*"
];

export type AdapterRuntimeEnv = Record<string, string | undefined>;

export function createConfiguredSourceAdapters(env: AdapterRuntimeEnv = process.env): Record<string, SourceAdapter> | undefined {
  const rootDir = env.KNOWLEDGE_LOOP_VAULT_ROOT?.trim();
  if (rootDir === undefined || rootDir.length === 0) {
    return undefined;
  }

  const id = env.KNOWLEDGE_LOOP_ADAPTER_ID?.trim() || DEFAULT_MARKDOWN_VAULT_ADAPTER_ID;
  const include = parseGlobList(env.KNOWLEDGE_LOOP_VAULT_INCLUDE) ?? DEFAULT_MARKDOWN_VAULT_INCLUDE;
  const exclude = parseGlobList(env.KNOWLEDGE_LOOP_VAULT_EXCLUDE) ?? DEFAULT_MARKDOWN_VAULT_EXCLUDE;

  return {
    [id]: new MarkdownVaultAdapter({
      id,
      rootDir,
      include,
      exclude
    })
  };
}

function parseGlobList(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const patterns = value
    .split(",")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);

  return patterns.length > 0 ? patterns : undefined;
}
