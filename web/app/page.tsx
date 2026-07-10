// 한 화면, 두 질문 (완료 기준 5 / 003 축 6 레이아웃 C).
// RSC 가 DB 를 읽고(라이브: 읽기 전용 / 데모: in-memory 시드) 직렬화된 결과만 내려보낸다.
import { connection } from 'next/server';
import { Card, PanelHeading } from '../components/Card';
import { ThemeToggle } from '../components/ThemeToggle';
import { HeadroomTrend } from '../components/charts/HeadroomTrend';
import { ScopeGauge } from '../components/charts/ScopeGauge';
import { AttributionStack, type StackItem } from '../components/charts/AttributionStack';
import { HourHeatmap } from '../components/charts/HourHeatmap';
import { getDashboardData, MODE } from '../lib/data';
import { formatUsd, untilReset, utcDate, utcDateTime } from '../lib/format';
import { SERIES_VARS } from '../lib/palette';
import { billableTokens, type TokenTotals } from '../../shared/queries.ts';

const SCOPE_LABEL: Record<string, string> = {
  session: 'session (5시간 창)',
  weekly_all: 'weekly_all (주간 전체)',
  weekly_scoped: 'weekly_scoped',
};

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

export default async function Page() {
  // 라이브는 요청 시점 렌더 (수집이 계속 쌓인다). 데모 빌드에서 이 분기는 실행되지 않아 정적이다.
  if (MODE === 'live') await connection();
  const d = getDashboardData();

  const abandoned = d.headroom.abandonedPct;
  const used = d.headroom.meanUtilization;

  const projectItems = toStackItems(d.projects.map((p) => ({ ...p, label: p.project })));
  const modelItems = toStackItems(d.models.map((m) => ({ ...m, label: m.model ?? '(모델 미상)' })));
  const sidechainTotal = d.projects.reduce((s, p) => s + p.sidechainEvents, 0);
  const eventTotal = d.projects.reduce((s, p) => s + p.events, 0);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      {/* 헤더 */}
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3 border-b border-hairline pb-4">
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
            Claude Max 한도 소진율과 사용 귀속의 장기 기록
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
                <span className="text-6xl font-bold leading-none tracking-tight">
                  {abandoned.toFixed(0)}
                  <span className="text-3xl font-semibold text-ink2">%</span>
                </span>
                <span className="text-sm text-ink2">
                  버려진 헤드룸
                  <br />
                  <span className="text-xs text-mute">= 100% - weekly_all 구간 평균 ({d.headroom.samples.toLocaleString('en-US')} 샘플)</span>
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

              <div className="mt-5">
                <HeadroomTrend
                  series={d.series}
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
                const name =
                  s.kind === 'weekly_scoped' && s.scopeModel !== null
                    ? `weekly_scoped · ${s.scopeModel}`
                    : (SCOPE_LABEL[s.kind] ?? s.kind);
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

      {/* 귀속 행 */}
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <h3 className="micro mb-3">프로젝트별 귀속</h3>
          <AttributionStack items={projectItems} unitLabel="프로젝트" />
          <p className="mt-2 text-xs text-mute">
            서브에이전트(sidechain) 이벤트 {sidechainTotal.toLocaleString('en-US')} / {eventTotal.toLocaleString('en-US')}건 포함
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

      {/* 뮤트 밴드: 환산가치 면책 + 수집 결손 (숨기지 않는다) */}
      <footer className="mt-6 rounded-xl border border-hairline bg-surface px-5 py-4 text-xs leading-relaxed text-mute">
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
          토큰 만료로 건너뛴 슬롯 {d.gaps.authSkip.toLocaleString('en-US')}개 - 이 슬롯의 시간대는 데이터에
          실제로 뚫린 구멍이다.
          {d.mode === 'demo' && ' · 이 화면은 완전 합성 시드다 (실데이터 아님).'}
        </p>
      </footer>
    </main>
  );
}
