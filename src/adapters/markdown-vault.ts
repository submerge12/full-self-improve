import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { DocRef, RawDoc, SourceAdapter } from "../engine/source-adapter.js";

export interface MarkdownVaultAdapterOptions {
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

export class MarkdownVaultAdapter implements SourceAdapter {
  readonly id: string;
  readonly kind = "markdown-vault";

  private readonly rootDir: string;
  private readonly include: string[];
  private readonly exclude: string[];

  constructor(options: MarkdownVaultAdapterOptions) {
    this.id = options.id;
    this.rootDir = path.resolve(options.rootDir);
    this.include = options.include ?? ["**/*.md"];
    this.exclude = options.exclude ?? [];
  }

  async *listDocuments(): AsyncIterable<DocRef> {
    for (const relativePath of this.listMarkdownPaths(this.rootDir)) {
      if (!this.isIncluded(relativePath)) {
        continue;
      }

      yield this.createRef(relativePath);
    }
  }

  async readDocument(ref: DocRef): Promise<RawDoc> {
    const absolutePath = this.resolveInsideRoot(ref.path);
    const parsed = parseMarkdown(readFileSync(absolutePath, "utf8"));

    return {
      ref: this.createRef(toPosixPath(path.relative(this.rootDir, absolutePath))),
      text: parsed.text,
      links: parsed.links,
      mediaRefs: parsed.mediaRefs,
      metadata: parsed.metadata
    };
  }

  fingerprint(ref: DocRef): string {
    const absolutePath = this.resolveInsideRoot(ref.path);
    const bytes = readFileSync(absolutePath);
    const relativePath = toPosixPath(path.relative(this.rootDir, absolutePath));

    return createHash("sha256").update(relativePath).update("\0").update(bytes).digest("hex");
  }

  private listMarkdownPaths(directory: string): string[] {
    const entries = readdirSync(directory, { withFileTypes: true });
    const paths: string[] = [];

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        paths.push(...this.listMarkdownPaths(absolutePath));
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        paths.push(toPosixPath(path.relative(this.rootDir, absolutePath)));
      }
    }

    return paths.sort((left, right) => left.localeCompare(right, "en"));
  }

  private createRef(relativePath: string): DocRef {
    const absolutePath = this.resolveInsideRoot(relativePath);
    const parsed = parseMarkdown(readFileSync(absolutePath, "utf8"));
    const title = typeof parsed.metadata.title === "string" ? parsed.metadata.title : titleFromPath(relativePath);

    return {
      adapterId: this.id,
      id: relativePath,
      kind: this.kind,
      path: relativePath,
      title
    };
  }

  private isIncluded(relativePath: string): boolean {
    return (
      this.include.some((pattern) => matchesGlob(relativePath, pattern)) &&
      !this.exclude.some((pattern) => matchesGlob(relativePath, pattern))
    );
  }

  private resolveInsideRoot(relativePath: string): string {
    const absolutePath = path.resolve(this.rootDir, relativePath);
    const relativeToRoot = path.relative(this.rootDir, absolutePath);

    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
      throw new Error(`Document path is outside the vault root: ${relativePath}`);
    }

    const stats = statSync(absolutePath);
    if (!stats.isFile()) {
      throw new Error(`Document path is not a file: ${relativePath}`);
    }

    return absolutePath;
  }
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
  if (pattern === "**/*.md") {
    return relativePath.endsWith(".md");
  }

  if (pattern.endsWith("/**")) {
    return relativePath.startsWith(pattern.slice(0, -2));
  }

  if (pattern.startsWith("**/")) {
    return matchesSegmentPattern(relativePath, pattern.slice(3));
  }

  if (pattern.includes("*")) {
    return new RegExp(`^${escapeRegex(pattern).replaceAll("\\*", "[^/]*")}$`).test(relativePath);
  }

  return relativePath === pattern;
}

function matchesSegmentPattern(relativePath: string, segmentPattern: string): boolean {
  const expression = new RegExp(`(^|/)${escapeRegex(segmentPattern).replaceAll("\\*", "[^/]*")}`);
  return expression.test(relativePath);
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function titleFromPath(relativePath: string): string {
  return path.posix.basename(relativePath, path.posix.extname(relativePath));
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}
