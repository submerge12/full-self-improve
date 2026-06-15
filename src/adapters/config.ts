import type { SourceAdapter } from "../engine/source-adapter.js";
import { GitRepoAdapter } from "./git-repo.js";
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
export const DEFAULT_GIT_REPO_ADAPTER_ID = "git-repo";

export type AdapterRuntimeEnv = Record<string, string | undefined>;

export function createConfiguredSourceAdapters(env: AdapterRuntimeEnv = process.env): Record<string, SourceAdapter> | undefined {
  const adapters: Record<string, SourceAdapter> = {};
  const markdownRootDir = env.KNOWLEDGE_LOOP_VAULT_ROOT?.trim();
  if (markdownRootDir !== undefined && markdownRootDir.length > 0) {
    const id = env.KNOWLEDGE_LOOP_ADAPTER_ID?.trim() || DEFAULT_MARKDOWN_VAULT_ADAPTER_ID;
    const include = parseGlobList(env.KNOWLEDGE_LOOP_VAULT_INCLUDE) ?? DEFAULT_MARKDOWN_VAULT_INCLUDE;
    const exclude = parseGlobList(env.KNOWLEDGE_LOOP_VAULT_EXCLUDE) ?? DEFAULT_MARKDOWN_VAULT_EXCLUDE;

    adapters[id] = new MarkdownVaultAdapter({
      id,
      rootDir: markdownRootDir,
      include,
      exclude
    });
  }

  const gitRepoRootDir = env.KNOWLEDGE_LOOP_GIT_REPO_ROOT?.trim();
  if (gitRepoRootDir !== undefined && gitRepoRootDir.length > 0) {
    const id = env.KNOWLEDGE_LOOP_GIT_REPO_ADAPTER_ID?.trim() || DEFAULT_GIT_REPO_ADAPTER_ID;
    const include = parseGlobList(env.KNOWLEDGE_LOOP_GIT_REPO_INCLUDE);
    const exclude = parseGlobList(env.KNOWLEDGE_LOOP_GIT_REPO_EXCLUDE);

    adapters[id] = new GitRepoAdapter({
      id,
      rootDir: gitRepoRootDir,
      ...(include !== undefined ? { include } : {}),
      ...(exclude !== undefined ? { exclude } : {})
    });
  }

  if (Object.keys(adapters).length === 0) {
    return undefined;
  }

  return adapters;
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
