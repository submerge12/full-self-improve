import { getRuntimePublicWikiPageDetail } from "../../../_shared/page-data.js";

export const dynamic = "force-dynamic";

interface PublicWikiDetailPageProps {
  readonly params?: Promise<{ readonly pageId?: string | string[] }>;
}

export default async function PublicWikiDetailPage({ params }: PublicWikiDetailPageProps) {
  const { pageId } = params === undefined ? {} : await params;
  const normalizedPageId = Array.isArray(pageId) ? pageId[0] : pageId;

  if (normalizedPageId === undefined) {
    return throwNextNotFound();
  }

  const page = getRuntimePublicWikiPageDetail(normalizedPageId);

  if (page === null) {
    return throwNextNotFound();
  }

  return (
    <article>
      <header>
        <h1>{page.conceptName}</h1>
        <p>Version {page.version}</p>
      </header>

      <pre>{page.markdown}</pre>

      <section aria-labelledby="provenance-heading">
        <h2 id="provenance-heading">Provenance</h2>
        <ol>
          {page.citations.map((citation) => (
            <li key={citation.chunkId}>
              <a href={`#citation-${citation.chunkId}`}>
                {citation.sourceTitle} ({citation.docRef}, {citation.adapterId})
              </a>
            </li>
          ))}
        </ol>

        {page.citations.map((citation) => (
          <section id={`citation-${citation.chunkId}`} key={citation.chunkId}>
            <h3>{citation.sourceTitle}</h3>
            <p>
              {citation.docRef}, {citation.adapterId}
            </p>
            <pre>{citation.text}</pre>
          </section>
        ))}
      </section>
    </article>
  );
}

function throwNextNotFound(): never {
  const error = new Error("NEXT_HTTP_ERROR_FALLBACK;404") as Error & { digest?: string };
  error.digest = "NEXT_HTTP_ERROR_FALLBACK;404";
  throw error;
}
