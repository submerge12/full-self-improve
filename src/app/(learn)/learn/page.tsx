import { getRuntimeLearningDashboardData } from "../../_shared/page-data.js";

export const dynamic = "force-dynamic";

export default function LearningPage() {
  const dashboard = getRuntimeLearningDashboardData();

  return (
    <>
      <h1>知识循环学习台</h1>
      <section aria-labelledby="todays-plan">
        <h2 id="todays-plan">今日计划</h2>
        {dashboard.plan === null ? (
          <p>{dashboard.date} 还没有生成学习计划。</p>
        ) : (
          <>
            <p>状态：{dashboard.plan.status}</p>
            <p>{dashboard.plan.rationale}</p>
            <pre>{JSON.stringify(dashboard.plan.queue, null, 2)}</pre>
          </>
        )}
      </section>
      <section aria-labelledby="mastery">
        <h2 id="mastery">掌握度与薄弱点</h2>
        {dashboard.mastery.length === 0 ? (
          <p>还没有掌握度记录。完成一次测验或 teach-back 后，这里会显示学习状态。</p>
        ) : (
          <ul>
            {dashboard.mastery.map((row) => (
              <li key={row.conceptId}>
                <strong>{row.conceptName}</strong>：得分 {formatPercent(row.score)}，置信度{" "}
                {formatPercent(row.confidence)}，尝试 {row.attemptsN} 次
              </li>
            ))}
          </ul>
        )}
      </section>
      <p>
        <a href="/wiki">查看公开知识库</a>
      </p>
    </>
  );
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
