import { getRuntimeLearningDashboardData } from "../../_shared/page-data.js";

export const dynamic = "force-dynamic";

export default function LearningPage() {
  const dashboard = getRuntimeLearningDashboardData();

  return (
    <>
      <h1>Knowledge Loop learning</h1>
      <section aria-labelledby="todays-plan">
        <h2 id="todays-plan">Today&apos;s plan</h2>
        {dashboard.plan === null ? (
          <p>No study plan exists for {dashboard.date} yet.</p>
        ) : (
          <>
            <p>Status: {dashboard.plan.status}</p>
            <p>{dashboard.plan.rationale}</p>
            <pre>{JSON.stringify(dashboard.plan.queue, null, 2)}</pre>
          </>
        )}
      </section>
      <section aria-labelledby="mastery">
        <h2 id="mastery">Mastery and weak spots</h2>
        {dashboard.mastery.length === 0 ? (
          <p>No mastery records exist yet. Complete a quiz or teach-back to populate this section.</p>
        ) : (
          <ul>
            {dashboard.mastery.map((row) => (
              <li key={row.conceptId}>
                <strong>{row.conceptName}</strong>: score {formatPercent(row.score)}, confidence{" "}
                {formatPercent(row.confidence)}, attempts {row.attemptsN}
              </li>
            ))}
          </ul>
        )}
      </section>
      <p>
        <a href="/wiki">View public wiki</a>
      </p>
    </>
  );
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
