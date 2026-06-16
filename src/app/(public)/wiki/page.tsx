import { getRuntimePublicWikiPageSummaries } from "../../_shared/page-data.js";

export const dynamic = "force-dynamic";

export default function PublicWikiPage() {
  const pages = getRuntimePublicWikiPageSummaries();

  return (
    <section>
      <h1>公开知识库</h1>
      {pages.length === 0 ? (
        <p>还没有公开知识库页面。</p>
      ) : (
        <ul>
          {pages.map((page) => (
            <li key={page.id}>
              <article>
                <h2>
                  <a href={`/wiki/${page.id}`}>{page.conceptName}</a>
                </h2>
                <p>{page.excerpt}</p>
                <p>版本 {page.version}</p>
              </article>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
