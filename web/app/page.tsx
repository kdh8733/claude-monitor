// 탭으로 전환하는 상세 화면. 기본 탭(개요)은 여전히 한 화면에서 두 질문에 답한다
// (완료 기준 5 / 003 축 6 레이아웃 C). 탭은 URL 없이 클라이언트 상태다 (output: export).
// 모든 패널이 SSR 로 index.html 에 남으므로 카나리의 필수 문자열 검사는 그대로 유효하다.
// RSC 가 DB 를 읽고(라이브: 읽기 전용 / 데모: in-memory 시드) 직렬화된 결과만 내려보낸다.
import { connection } from 'next/server';
import { Card, PanelHeading } from '../components/Card';
import { ThemeToggle } from '../components/ThemeToggle';
import { Tabs } from '../components/Tabs';
import { ReportActions } from '../components/ReportActions';
import { AttributionTable, type AttributionRow } from '../components/AttributionTable';
import { CapacityReadout } from '../components/CapacityReadout';
import { ConsumptionByHour } from '../components/charts/ConsumptionByHour';
import { HeadroomTrend } from '../components/charts/HeadroomTrend';
import { ScopeGauge } from '../components/charts/ScopeGauge';
import { AttributionStack, type StackItem } from '../components/charts/AttributionStack';
import { HourHeatmap } from '../components/charts/HourHeatmap';
import { RunStrip } from '../components/charts/RunStrip';
import { getDashboardData, MODE, type DashboardData } from '../lib/data';
import { formatUsd, scopeName, untilReset, utcDate, utcDateTime } from '../lib/format';
import { SERIES_VARS } from '../lib/palette';
import { billableTokens, type TokenTotals } from '../../shared/queries.ts';
import { buildReportJson, buildReportMarkdown, type ReportInput } from '../../shared/report.ts';

/**
 * 귀속 그룹 -> 스택 아이템. 색은 엔티티의 알파벳순 인덱스에 고정된다 (순위가 아니다).
 * categorical 슬롯은 4개다 - 넘치면 하위를 '기타'로 접는다. 9번째 색을 생성하지 않는다.
 */
function toStackItems(groups: Array<TokenTotals & { label: string }>): StackItem[] {
  const withBillable = groups.map((g) => ({
    ...g,
    billable: billableTokens({
      inputTokens: g.inputTokens,
      outputTokens: g.outputTokens,
      cacheCreationTokens: g.cacheCreationTokens,
    }),
  }));
  let kept = withBillable;
  let folded: StackItem | null = null;
  if (withBillable.length > SERIES_VARS.length) {
    const byValue = [...withBillable].sort((a, b) => b.billable - a.billable);
    kept = byValue.slice(0, SERIES_VARS.length - 1);
    const rest = byValue.slice(SERIES_VARS.length - 1);
    folded = {
      label: '기타',
      color: 'var(--baseline)',
      events: rest.reduce((s, g) => s + g.events, 0),
      billable: rest.reduce((s, g) => s + g.billable, 0),
      inputTokens: rest.reduce((s, g) => s + g.inputTokens, 0),
      outputTokens: rest.reduce((s, g) => s + g.outputTokens, 0),
      cacheReadTokens: rest.reduce((s, g) => s + g.cacheReadTokens, 0),
      cacheCreationTokens: rest.reduce((s, g) => s + g.cacheCreationTokens, 0),
    };
  }
  const alphabetical = [...kept].sort((a, b) => (a.label < b.label ? -1 : 1));
  const items: StackItem[] = alphabetical.map((g, i) => ({
    label: g.label,
    color: SERIES_VARS[i],
    events: g.events,
    billable: g.billable,
    inputTokens: g.inputTokens,
    outputTokens: g.outputTokens,
    cacheReadTokens: g.cacheReadTokens,
    cacheCreationTokens: g.cacheCreationTokens,
  }));
  if (folded !== null) items.push(folded);
  return items;
}

const num = (v: number) => v.toLocaleString('en-US');

// ---- 개요 탭 (기본. 두 질문 + 요약 + LLM export) ----

function OverviewPanel({ d, reportMarkdown, reportJson }: {
  d: DashboardData;
  reportMarkdown: string;
  reportJson: string;
}) {
  const abandoned = d.headroom.abandonedPct;
  const used = d.headroom.meanUtilization;
  // 마커와 경고는 이 차트의 시리즈(weekly_all) 리셋만 본다. session 톱니는 주간 평균과 무관하다.
  const weeklyResets = d.resets.filter((r) => r.kind === 'weekly_all');
  const projectItems = toStackItems(d.projects.map((p) => ({ ...p, label: p.project })));
  const modelItems = toStackItems(d.models.map((m) => ({ ...m, label: m.model ?? '(모델 미상)' })));
  const sidechainTotal = d.projects.reduce((s, p) => s + p.sidechainEvents, 0);
  const eventTotal = d.projects.reduce((s, p) => s + p.events, 0);

  return (
    <>
      {/* 두 질문 패널 */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <PanelHeading kicker="Q1" title="요금제를 얼마나 놀리나?" />
          {abandoned === null || used === null ? (
            <p className="text-sm text-mute">구간에 스냅샷이 없어 계산할 수 없습니다.</p>
          ) : (
            <>
              {/* 히어로 - 화면에서 가장 큰 숫자는 이것이어야 한다 (CLAUDE.md 6항) */}
              <p className="flex items-baseline gap-3">
                <span className="text-6xl font-bold leading-none tracking-tight tabular-nums">
                  {abandoned.toFixed(0)}
                  <span className="text-3xl font-semibold text-ink2">%</span>
                </span>
                <span className="text-sm text-ink2">
                  버려진 헤드룸
                  <br />
                  <span className="text-xs text-mute">= 100% - weekly_all 구간 평균 ({num(d.headroom.samples)} 샘플)</span>
                </span>
              </p>

              {/* 쓴/버린 미터: 채움 = 같은 램프의 두 단계 */}
              <div className="mt-4" role="img" aria-label={`쓴 ${used.toFixed(0)}%, 버린 ${abandoned.toFixed(0)}%`}>
                <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full">
                  <div
                    style={{
                      width: `${used}%`,
                      background: 'color-mix(in oklab, var(--accent) 30%, var(--surface))',
                    }}
                  />
                  <div style={{ width: `${abandoned}%`, background: 'var(--accent)' }} />
                </div>
                <div className="mt-1.5 flex justify-between text-xs text-mute">
                  <span>쓴 {used.toFixed(0)}%</span>
                  <span className="text-ink2">버린 {abandoned.toFixed(0)}%</span>
                </div>
              </div>

              {/* 관측 구간이 리셋을 걸치면 평균이 리셋 직후 값에 눌린다 - 히어로를 가리지 않고 맥락만 준다 (CLAUDE.md 6항의 연장). */}
              {weeklyResets.length > 0 && (
                <p className="mt-2 text-xs text-mute">
                  <span aria-hidden className="mr-1">⚠</span>
                  이 구간에 주간 리셋 {weeklyResets.length}회 - 평균이 리셋 직후 값에 눌릴 수
                  있음 (버려진 헤드룸 과대평가 가능).
                </p>
              )}

              <div className="mt-5">
                <HeadroomTrend
                  series={d.series}
                  resets={weeklyResets}
                  fromMs={d.fromMs}
                  toMs={d.anchorMs + 1}
                  meanUtilization={used}
                />
              </div>
            </>
          )}
        </Card>

        <Card>
          <PanelHeading kicker="Q2" title="무엇이 먼저 바닥나나?" />
          {d.scopes.length === 0 ? (
            <p className="text-sm text-mute">스냅샷의 limits[] 가 비어 있습니다.</p>
          ) : (
            <ol className="divide-y divide-grid">
              {d.scopes.map((s, i) => {
                const name = scopeName(s.kind, s.scopeModel);
                const reset = untilReset(s.resetsAt, d.anchorMs);
                return (
                  <li key={s.kind + (s.scopeModel ?? '')} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                    <span className="micro w-5 text-center">{i + 1}</span>
                    <ScopeGauge percent={s.percent ?? 0} label={name} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">
                        {name}
                        {i === 0 && <span aria-hidden className="ml-1.5 text-accent">◀</span>}
                        {i === 0 && <span className="sr-only">(가장 먼저 바닥나는 스코프)</span>}
                      </p>
                      <p className="mt-0.5 text-xs text-mute">
                        {reset !== null && <>리셋까지 {reset}</>}
                        {s.isActive && (
                          <span className="ml-2 rounded-sm border border-hairline px-1 py-px text-ink2">
                            지금 바인딩
                          </span>
                        )}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          <p className="mt-3 border-t border-grid pt-2 text-xs text-mute">
            소진율은 /api/oauth/usage 스냅샷의 limits[].percent. &quot;지금 바인딩&quot;(is_active)의
            의미는 추정이며 관측 중이다 (ROADMAP 열린 질문).
          </p>
        </Card>
      </div>

      {/* 쓰기 좋은 때 - 관측 패널. 상태 리드아웃(Q3) + 소비 시간대(Q4). 예측이 아니라 관측이다. */}
      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <PanelHeading kicker="Q3" title="지금 얼마나 비어 있나?" />
          <CapacityReadout capacity={d.capacity} />
          <p className="mt-3 border-t border-grid pt-2 text-xs text-mute">
            최신 스냅샷의 limits[] 관측치. 카운트다운은 마지막 수집 시각 기준이다 (벽시계 아님).
          </p>
        </Card>
        <Card className="lg:col-span-3">
          <PanelHeading kicker="Q4" title="언제가 습관적으로 비나?" />
          <ConsumptionByHour data={d.sessionByHour} />
          <p className="mt-3 border-t border-grid pt-2 text-xs text-mute">
            관측치이지 예측이 아니다. 웹/데스크톱 사용도 같은 한도를 소모하며 이 게이지 신호에
            포함되어 있다. 관측 {d.rangeDays}일치.
          </p>
        </Card>
      </div>

      {/* 귀속 행 */}
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <h3 className="micro mb-3">프로젝트별 귀속</h3>
          <AttributionStack items={projectItems} unitLabel="프로젝트" />
          <p className="mt-2 text-xs text-mute">
            서브에이전트(sidechain) 이벤트 {num(sidechainTotal)} / {num(eventTotal)}건 포함
          </p>
        </Card>
        <Card>
          <h3 className="micro mb-3">모델별 귀속</h3>
          <AttributionStack items={modelItems} unitLabel="모델" />
        </Card>
        <Card>
          <h3 className="micro mb-3">시간대별 사용</h3>
          <HourHeatmap hourly={d.hourly} />
        </Card>
      </div>

      {/* LLM 분석용 export - 통계를 복사해 LLM 에 붙여넣는다 */}
      <div className="mt-4 rounded-xl border border-hairline bg-surface px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="micro">LLM 분석용 통계</h3>
            <p className="mt-1 text-xs text-mute">
              이 구간의 통계 요약 (마크다운). LLM 대화창에 붙여넣어 분석시키는 용도다.
            </p>
          </div>
        </div>
        <div className="mt-3">
          <ReportActions
            markdown={reportMarkdown}
            json={reportJson}
            filename={`claude-monitor-report-${utcDate(d.anchorMs)}.json`}
          />
        </div>
      </div>

      {/* 뮤트 밴드: 환산가치 면책 + 수집 결손 (숨기지 않는다) */}
      <footer className="mt-4 rounded-xl border border-hairline bg-surface px-5 py-4 text-xs leading-relaxed text-mute">
        <p>
          <span className="font-semibold text-ink2">
            API 환산가치(참고용):{' '}
            {d.apiEquivalentUsd === null ? '계산 불가 - 단가 미상 이벤트 포함 (모른다 ≠ 0)' : formatUsd(d.apiEquivalentUsd)}
          </span>{' '}
          - 같은 사용량을 API 종량제로 계산한 가상 수치다. 이 구독은 정액제(stripe_subscription)라{' '}
          <span className="text-ink2">실제 청구액이 아니며</span>, 한도를 넘으면 요금이 아니라 작업이
          막힌다.
        </p>
        <p className="mt-1.5">
          수집 결손율 {d.gaps.gapPct.toFixed(1)}% (실패 {d.gaps.failed} / 발화 {d.gaps.ok + d.gaps.failed}) ·
          토큰 만료로 건너뛴 슬롯 {num(d.gaps.authSkip)}개 - 이 슬롯의 시간대는 데이터에
          실제로 뚫린 구멍이다.
          {d.mode === 'demo' && ' · 이 화면은 완전 합성 시드다 (실데이터 아님).'}
        </p>
      </footer>
    </>
  );
}

// ---- 귀속 상세 탭 ----

function AttributionPanel({ d }: { d: DashboardData }) {
  const projectRows: AttributionRow[] = d.projects.map((p) => ({
    label: p.project,
    events: p.events,
    sidechainEvents: p.sidechainEvents,
    inputTokens: p.inputTokens,
    outputTokens: p.outputTokens,
    cacheReadTokens: p.cacheReadTokens,
    cacheCreationTokens: p.cacheCreationTokens,
    billable: billableTokens(p),
    apiEquivalentUsd: p.apiEquivalentUsd,
  }));
  const modelRows: AttributionRow[] = d.models.map((m) => ({
    label: m.model ?? '(모델 미상)',
    events: m.events,
    sidechainEvents: null,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    cacheReadTokens: m.cacheReadTokens,
    cacheCreationTokens: m.cacheCreationTokens,
    billable: billableTokens(m),
    apiEquivalentUsd: m.apiEquivalentUsd,
  }));
  const sidechainTotal = d.projects.reduce((s, p) => s + p.sidechainEvents, 0);
  const eventTotal = d.projects.reduce((s, p) => s + p.events, 0);
  const withSidechain = d.projects.filter((p) => p.sidechainEvents > 0);

  return (
    <>
      <div className="grid gap-4">
        <Card>
          <PanelHeading kicker="ATTRIBUTION" title="프로젝트별 상세" />
          <AttributionTable rows={projectRows} unitLabel="프로젝트" />
        </Card>
        <Card>
          <PanelHeading kicker="ATTRIBUTION" title="모델별 상세" />
          <AttributionTable rows={modelRows} unitLabel="모델" />
        </Card>
        <Card>
          <PanelHeading kicker="SIDECHAIN" title="서브에이전트 이벤트" />
          <p className="mb-3 text-xs text-mute">
            isSidechain=1 로 기록된 이벤트 - 서브에이전트가 소비한 몫이다. 전체 귀속에서 제외하지
            않고 따로 센다. 구간 합계 {num(sidechainTotal)} / {num(eventTotal)}건.
          </p>
          {withSidechain.length === 0 ? (
            <p className="text-sm text-mute">이 구간에는 sidechain 이벤트가 없습니다.</p>
          ) : (
            <table className="w-full max-w-xl border-collapse text-xs">
              <thead>
                <tr>
                  <th scope="col" className="border-b border-grid px-2 py-1.5 text-left font-semibold text-ink2">프로젝트</th>
                  <th scope="col" className="border-b border-grid px-2 py-1.5 text-right font-semibold text-ink2">sidechain</th>
                  <th scope="col" className="border-b border-grid px-2 py-1.5 text-right font-semibold text-ink2">전체 events</th>
                  <th scope="col" className="border-b border-grid px-2 py-1.5 text-right font-semibold text-ink2">비율</th>
                </tr>
              </thead>
              <tbody>
                {withSidechain.map((p) => (
                  <tr key={p.project}>
                    <th scope="row" className="border-b border-grid px-2 py-1.5 text-left font-normal text-ink">{p.project}</th>
                    <td className="border-b border-grid px-2 py-1.5 text-right tabular-nums text-ink2">{num(p.sidechainEvents)}</td>
                    <td className="border-b border-grid px-2 py-1.5 text-right tabular-nums text-ink2">{num(p.events)}</td>
                    <td className="border-b border-grid px-2 py-1.5 text-right tabular-nums text-ink2">
                      {((p.sidechainEvents / p.events) * 100).toFixed(0)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      <p className="mt-4 text-xs text-mute">
        billable = input + output + cache write (cache read 제외). API 환산가치는 실제 청구액이
        아니다 - 이 구독은 정액제다. &quot;미상&quot; = 단가 미상 이벤트 포함 (모른다 ≠ 0).
      </p>
    </>
  );
}

// ---- 수집 상태 탭 ----

const RESET_ROWS_MAX = 20;

function CollectionPanel({ d }: { d: DashboardData }) {
  const fired = d.gaps.ok + d.gaps.failed;
  // 최신이 위로. session 톱니가 다수라 표는 최근 N건만 - 전체 수는 함께 밝힌다.
  const resetsDesc = [...d.resets].sort((a, b) => b.t - a.t);
  const resetRows = resetsDesc.slice(0, RESET_ROWS_MAX);
  const unpredictedTotal = d.resets.filter((r) => !r.predicted).length;
  const tiles: Array<{ label: string; value: string; note: string; warn?: boolean }> = [
    { label: '결손율', value: `${d.gaps.gapPct.toFixed(1)}%`, note: `실패 ${num(d.gaps.failed)} / 발화 ${num(fired)}` },
    { label: '성공 슬롯', value: num(d.gaps.ok), note: 'status = ok' },
    { label: '실패 슬롯', value: num(d.gaps.failed), note: 'error + http_error' },
    { label: 'auth_skip 슬롯', value: num(d.gaps.authSkip), note: '토큰 만료 - 데이터 구멍', warn: true },
  ];
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label}>
            <p className="micro">{t.label}</p>
            <p className="mt-2 text-3xl font-bold leading-none tracking-tight tabular-nums">
              {t.value}
            </p>
            <p className="mt-2 text-xs text-mute">
              {t.warn === true && <span aria-hidden className="mr-1">⚠</span>}
              {t.note}
            </p>
          </Card>
        ))}
      </div>

      <Card>
        <PanelHeading kicker="RESET" title="관측된 리셋 이벤트" />
        <p className="mb-3 text-xs text-mute">
          스냅샷 간 소진율이 5%p 이상 하락한 지점 (완료 기준 2). 구간 전체 {num(d.resets.length)}건
          중 예고 없음 {num(unpredictedTotal)}건 - 예고 없음은 직전 스냅샷의 resets_at 이
          예고하지 않은 리셋이다 (실측상 존재한다).
        </p>
        {d.resets.length === 0 ? (
          <p className="text-sm text-mute">이 구간에 관측된 리셋 톱니가 없습니다.</p>
        ) : (
          <>
            <table className="w-full max-w-xl border-collapse text-xs">
              <thead>
                <tr>
                  <th scope="col" className="border-b border-grid px-2 py-1.5 text-left font-semibold text-ink2">시각 (UTC)</th>
                  <th scope="col" className="border-b border-grid px-2 py-1.5 text-left font-semibold text-ink2">스코프</th>
                  <th scope="col" className="border-b border-grid px-2 py-1.5 text-right font-semibold text-ink2">소진율 변화</th>
                  <th scope="col" className="border-b border-grid px-2 py-1.5 text-left font-semibold text-ink2">예고 여부</th>
                </tr>
              </thead>
              <tbody>
                {resetRows.map((r) => (
                  <tr key={`${r.t}-${r.kind}`}>
                    <td className="border-b border-grid px-2 py-1.5 tabular-nums text-ink2">{utcDateTime(r.t)}</td>
                    <td className="border-b border-grid px-2 py-1.5 text-ink">{r.kind}</td>
                    <td className="border-b border-grid px-2 py-1.5 text-right tabular-nums text-ink2">
                      {r.fromPct.toFixed(0)}% -&gt; {r.toPct.toFixed(0)}%
                    </td>
                    <td className="border-b border-grid px-2 py-1.5 text-ink2">
                      {r.predicted ? '예고됨' : (
                        <span title="resets_at 이 예고하지 않은 리셋">
                          <span aria-hidden className="mr-1">⚠</span>예고 없음
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d.resets.length > RESET_ROWS_MAX && (
              <p className="mt-2 text-xs text-mute">
                최근 {RESET_ROWS_MAX}건만 표시 (전체 {num(d.resets.length)}건 - session 톱니 포함).
              </p>
            )}
          </>
        )}
      </Card>

      <Card>
        <PanelHeading kicker="HEARTBEAT" title="일 단위 수집 상태" />
        <RunStrip runDaily={d.runDaily} fromMs={d.fromMs} toMs={d.anchorMs + 1} />
        <p className="mt-3 border-t border-grid pt-2 text-xs text-mute">
          마지막 발화 {d.lastRunAt === null ? '기록 없음' : `${utcDateTime(d.lastRunAt)} UTC`} ·
          마지막 적재 {utcDateTime(d.anchorMs)} UTC
        </p>
      </Card>

      <div className="rounded-xl border border-hairline bg-surface px-5 py-4 text-xs leading-relaxed text-mute">
        <p>
          결손율의 분모는 &quot;cron 이 발화했고 accessToken 이 유효했던 슬롯&quot;이다 (완료 기준 1).
          auth_skip 은 그 분모에서 빠지지만 <span className="text-ink2">데이터에 실제로 뚫린 구멍</span>이라
          여기 그대로 노출한다. 수집기는 refreshToken 을 소비하지 않으므로(ride-along) 유휴 구간에
          구멍이 생긴다 - 해소 경로는 수집기 전용 자격증명(ROADMAP T4)이다.
        </p>
      </div>
    </div>
  );
}

export default async function Page() {
  // 라이브는 요청 시점 렌더 (수집이 계속 쌓인다). 데모 빌드에서 이 분기는 실행되지 않아 정적이다.
  if (MODE === 'live') await connection();
  const d = getDashboardData();

  // 리포트는 순수 함수로 서버에서 굽는다. 클라이언트는 문자열만 받는다.
  const reportInput: ReportInput = {
    mode: d.mode,
    anchorMs: d.anchorMs,
    fromMs: d.fromMs,
    rangeDays: d.rangeDays,
    headroom: d.headroom,
    scopes: d.scopes,
    projects: d.projects,
    models: d.models,
    gaps: d.gaps,
    apiEquivalentUsd: d.apiEquivalentUsd,
  };
  const reportMarkdown = buildReportMarkdown(reportInput);
  const reportJson = JSON.stringify(buildReportJson(reportInput), null, 2);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      {/* 헤더 */}
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3 pb-1">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold tracking-tight">claude-monitor</h1>
            <span
              className={`micro rounded-full border px-2 py-0.5 ${
                d.mode === 'demo' ? 'border-accent text-accent' : 'border-good text-good'
              }`}
            >
              {d.mode === 'demo' ? 'DEMO · 합성 시드' : 'LIVE'}
            </span>
          </div>
          <p className="mt-1 text-sm text-ink2">
            Claude 구독 한도 소진율 모니터링
          </p>
        </div>
        <div className="flex items-center gap-4">
          <p className="micro text-right">
            최근 {d.rangeDays}일 · {utcDate(d.fromMs)} ~ {utcDate(d.anchorMs)}
            <br />
            마지막 수집 {utcDateTime(d.anchorMs)} UTC
          </p>
          <ThemeToggle />
        </div>
      </header>

      <Tabs
        listLabel="대시보드 뷰"
        tabs={[
          {
            id: 'overview',
            label: '개요',
            content: <OverviewPanel d={d} reportMarkdown={reportMarkdown} reportJson={reportJson} />,
          },
          { id: 'attribution', label: '귀속 상세', content: <AttributionPanel d={d} /> },
          { id: 'collection', label: '수집 상태', content: <CollectionPanel d={d} /> },
        ]}
      />
    </main>
  );
}
