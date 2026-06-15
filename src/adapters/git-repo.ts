import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import type { DocRef, RawDoc, SourceAdapter } from "../engine/source-adapter.js";

export interface GitRepoAdapterOptions {
  id: string;
  rootDir: string;
  include?: string[];
  exclude?: string[];
}

interface ParsedMarkdown {
  text: string;
  metadata: Record<string, unknown>;
  links: string[];
  mediaRefs: string[];
}

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".mdx",
  ".json",
  ".yaml",
  ".yml",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py"
]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"]);
const DEFAULT_EXCLUDE = [".git/**"];

export class GitRepoAdapter implements SourceAdapter {
  readonly id: string;
  readonly kind = "git-repo";

  private readonly rootDir: string;
  private readonly include: string[];
  private readonly exclude: string[];

  constructor(options: GitRepoAdapterOptions) {
    this.id = options.id;
    this.rootDir = realpathSync(path.resolve(options.rootDir));
    this.include = options.include ?? ["**/*"];
    this.exclude = [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])];
  }

  async *listDocuments(): AsyncIterable<DocRef> {
    for (const relativePath of this.listTextPaths(this.rootDir)) {
      if (!this.isIncluded(relativePath)) {
        continue;
      }

      yield this.createRef(relativePath);
    }
  }

  async readDocument(ref: DocRef): Promise<RawDoc> {
    const absolutePath = this.resolveInsideRoot(ref.path);
    const relativePath = toPosixPath(path.relative(this.rootDir, absolutePath));
    const extension = extensionForPath(relativePath);
    const content = readFileSync(absolutePath, "utf8");
    const parsed = isMarkdownLike(relativePath) ? parseMarkdown(content) : emptyParsedText(content);

    return {
      ref: this.createRef(relativePath),
      text: parsed.text,
      links: parsed.links,
      mediaRefs: parsed.mediaRefs,
      metadata: {
        ...parsed.metadata,
        extension,
        repositoryPath: relativePath
      }
    };
  }

  fingerprint(ref: DocRef): string {
    const absolutePath = this.resolveInsideRoot(ref.path);
    const bytes = readFileSync(absolutePath);
    const relativePath = toPosixPath(path.relative(this.rootDir, absolutePath));

    return createHash("sha256").update(relativePath).update("\0").update(bytes).digest("hex");
  }

  private listTextPaths(directory: string): string[] {
    const entries = readdirSync(directory, { withFileTypes: true });
    const paths: string[] = [];

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        const relativePath = toPosixPath(path.relative(this.rootDir, absolutePath));
        const realRelativePath = this.realRelativePathInsideRoot(absolutePath);
        if (
          this.shouldPruneDirectory(relativePath) ||
          realRelativePath === undefined ||
          hasGitPathSegment(realRelativePath)
        ) {
          continue;
        }

        paths.push(...this.listTextPaths(absolutePath));
        continue;
      }

      if (entry.isFile() && isTextLike(absolutePath)) {
        paths.push(toPosixPath(path.relative(this.rootDir, absolutePath)));
      }
    }

    return paths.sort(compareRepositoryPaths);
  }

  private createRef(relativePath: string): DocRef {
    const absolutePath = this.resolveInsideRoot(relativePath);
    const title = this.titleForPath(relativePath, absolutePath);

    return {
      adapterId: this.id,
      id: relativePath,
      kind: this.kind,
      path: relativePath,
      title
    };
  }

  private titleForPath(relativePath: string, absolutePath: string): string {
    if (!isMarkdownLike(relativePath)) {
      return titleFromPath(relativePath);
    }

    const parsed = parseMarkdown(readFileSync(absolutePath, "utf8"));
    return typeof parsed.metadata.title === "string" ? parsed.metadata.title : titleFromPath(relativePath);
  }

  private isIncluded(relativePath: string): boolean {
    return (
      this.include.some((pattern) => matchesGlob(relativePath, pattern)) &&
      !this.exclude.some((pattern) => matchesGlob(relativePath, pattern))
    );
  }

  private shouldPruneDirectory(relativePath: string): boolean {
    const descendantProbe = path.posix.join(relativePath, "__adapter_probe__");
    if (hasGitPathSegment(relativePath)) {
      return true;
    }

    return this.exclude.some((pattern) => matchesGlob(relativePath, pattern) || matchesGlob(descendantProbe, pattern));
  }

  private realRelativePathInsideRoot(absolutePath: string): string | undefined {
    const realPath = realpathSync(absolutePath);
    const relativeToRoot = path.relative(this.rootDir, realPath);

    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
      return undefined;
    }

    return toPosixPath(relativeToRoot);
  }

  private resolveInsideRoot(relativePath: string): string {
    const absolutePath = path.resolve(this.rootDir, relativePath);
    const relativeToRoot = path.relative(this.rootDir, absolutePath);

    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
      throw new Error(`Document path is outside the repository root: ${relativePath}`);
    }

    const repositoryPath = toPosixPath(relativeToRoot);
    if (hasGitPathSegment(repositoryPath)) {
      throw new Error(`Document path is excluded from the repository adapter: ${relativePath}`);
    }

    const realRepositoryPath = this.realRelativePathInsideRoot(absolutePath);
    if (realRepositoryPath === undefined) {
      throw new Error(`Document path is outside the repository root: ${relativePath}`);
    }

    if (hasGitPathSegment(realRepositoryPath)) {
      throw new Error(`Document path is excluded from the repository adapter: ${relativePath}`);
    }

    const stats = statSync(absolutePath);
    if (!stats.isFile()) {
      throw new Error(`Document path is not a file: ${relativePath}`);
    }

    if (!isTextLike(absolutePath)) {
      throw new Error(`Document path is not a supported text file: ${relativePath}`);
    }

    if (!this.isIncluded(repositoryPath)) {
      throw new Error(`Document path is excluded from the repository adapter: ${relativePath}`);
    }

    return absolutePath;
  }
}

function emptyParsedText(content: string): ParsedMarkdown {
  return {
    text: content,
    metadata: {},
    links: [],
    mediaRefs: []
  };
}

function parseMarkdown(content: string): ParsedMarkdown {
  const { text, metadata } = stripFrontmatter(content);

  return {
    text,
    metadata,
    links: extractWikiLinks(text),
    mediaRefs: extractMarkdownMediaRefs(text)
  };
}

function stripFrontmatter(content: string): { text: string; metadata: Record<string, unknown> } {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

  if (!normalized.startsWith("---\n")) {
    return { text: normalized, metadata: {} };
  }

  const endMarker = normalized.indexOf("\n---", 4);
  if (endMarker === -1) {
    return { text: normalized, metadata: {} };
  }

  const frontmatter = normalized.slice(4, endMarker);
  const contentStart = normalized.indexOf("\n", endMarker + 4);
  const text = contentStart === -1 ? "" : normalized.slice(contentStart + 1);

  return {
    text,
    metadata: parseFrontmatter(frontmatter)
  };
}

function parseFrontmatter(frontmatter: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};

  for (const line of frontmatter.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    if (key.length > 0) {
      metadata[key] = parseFrontmatterValue(value);
    }
  }

  return metadata;
}

function parseFrontmatterValue(value: string): unknown {
  const unquoted = value.replace(/^['"]|['"]$/g, "");

  if (unquoted === "true") {
    return true;
  }

  if (unquoted === "false") {
    return false;
  }

  if (/^-?\d+(\.\d+)?$/.test(unquoted)) {
    return Number(unquoted);
  }

  return unquoted;
}

function extractWikiLinks(text: string): string[] {
  return [...text.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map((match) => match[1].trim());
}

function extractMarkdownMediaRefs(text: string): string[] {
  return [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1].trim());
}

function matchesGlob(relativePath: string, pattern: string): boolean {
  if (pattern === "**/*") {
    return true;
  }

  if (pattern === "**/*.md") {
    return relativePath.endsWith(".md");
  }

  if (pattern.startsWith("**/") && pattern.endsWith("/**")) {
    return matchesDescendantSegment(relativePath, pattern.slice(3, -3));
  }

  if (pattern.endsWith("/**")) {
    return relativePath.startsWith(pattern.slice(0, -2));
  }

  if (pattern.startsWith("**/")) {
    return matchesSegmentPattern(relativePath, pattern.slice(3));
  }

  if (pattern.includes("*")) {
    return new RegExp(`^${globPatternToRegexSource(pattern)}$`).test(relativePath);
  }

  return relativePath === pattern;
}

function matchesDescendantSegment(relativePath: string, segmentPattern: string): boolean {
  const expression = new RegExp(`(^|/)${globPatternToRegexSource(segmentPattern)}/`);
  return expression.test(relativePath);
}

function matchesSegmentPattern(relativePath: string, segmentPattern: string): boolean {
  const expression = new RegExp(`(^|/)${globPatternToRegexSource(segmentPattern)}($|/)`);
  return expression.test(relativePath);
}

function globPatternToRegexSource(value: string): string {
  return [...value].map((character) => (character === "*" ? "[^/]*" : escapeRegex(character))).join("");
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function compareRepositoryPaths(left: string, right: string): number {
  return pathDepth(left) - pathDepth(right) || left.localeCompare(right, "en");
}

function pathDepth(value: string): number {
  return value.split("/").length;
}

function hasGitPathSegment(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => segment.toLowerCase() === ".git");
}

function isMarkdownLike(relativePath: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extensionForPath(relativePath));
}

function isTextLike(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(extensionForPath(filePath));
}

function extensionForPath(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

function titleFromPath(relativePath: string): string {
  return path.posix.basename(relativePath, path.posix.extname(relativePath));
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}
