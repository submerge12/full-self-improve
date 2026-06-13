import { getRuntimePublicWikiPageSummaries } from "../../_shared/page-data.js";

export const dynamic = "force-dynamic";

export default function PublicWikiPage() {
  const pages = getRuntimePublicWikiPageSummaries();

  return (
    <section>
      <h1>Public wiki</h1>
      {pages.length === 0 ? (
        <p>No public wiki pages exist yet.</p>
      ) : (
        <ul>
          {pages.map((page) => (
            <li key={page.id}>
              <article>
                <h2>
                  <a href={`/wiki/${page.id}`}>{page.conceptName}</a>
                </h2>
                <p>{page.excerpt}</p>
                <p>Version {page.version}</p>
              </article>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
