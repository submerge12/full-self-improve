export interface DocRef {
  adapterId: string;
  id: string;
  kind: string;
  path: string;
  title: string;
}

export interface RawDoc {
  ref: DocRef;
  text: string;
  links: string[];
  mediaRefs: string[];
  metadata: Record<string, unknown>;
}

export interface SourceAdapter {
  readonly id: string;
  readonly kind: string;
  listDocuments(): AsyncIterable<DocRef>;
  readDocument(ref: DocRef): Promise<RawDoc>;
  fingerprint(ref: DocRef): string;
}
