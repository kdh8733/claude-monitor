'use client';

// 시간대별 session 게이지 상승분(%p) 막대 차트. **트랜스크립트 히트맵(HourHeatmap)과 다른
// 신호다** - 한도 게이지 기반이라 웹/데스크톱 사용까지 포함한다 (권위 있는 소비 신호).
// 표시는 사용자 로컬(KST = UTC+9) 고정, 데이터는 hourUtc 로 받는다.
// 소비 0 + 표본 있음 = "습관적으로 비는 창" - 색이 아니라 모양(빈 원 마커)으로 구분한다.
// 표본이 적은 시간대는 흐리게 + 툴팁/표에 표본 수를 밝힌다.
import { useMemo, useState } from 'react';
import { useMeasure } from './useMeasure';
import { ChartTooltip, type TooltipState } from './ChartTooltip';
import type { HourConsumption } from '../../../shared/queries.ts';

const PLOT_H = 110;
const TOP_PAD = 14;
const LABEL_H = 18;
const GAP = 2;

const kstLabel = (h: number) => `${String(h).padStart(2, '0')}시`;

export function ConsumptionByHour({ data }: { data: HourConsumption[] }) {
  const [ref, width] = useMeasure(360);
  const [tip, setTip] = useState<TooltipState | null>(null);

  // data 에만 의존하는 파생값 - 툴팁 pointermove 리렌더 경로에서 제외한다.
  const { byKst, max, maxSamples, emptyCount } = useMemo(() => {
    // KST(UTC+9) 순서로 재배열. hourUtc 는 그대로 들고 가서 툴팁/표에 함께 밝힌다.
    const sorted = [...data]
      .map((d) => ({ ...d, hourKst: (d.hourUtc + 9) % 24 }))
      .sort((a, b) => a.hourKst - b.hourKst);
    return {
      byKst: sorted,
      max: Math.max(...sorted.map((d) => d.consumption), 0),
      maxSamples: Math.max(...sorted.map((d) => d.samples), 0),
      emptyCount: sorted.filter((d) => d.consumption === 0 && d.samples > 0).length,
    };
  }, [data]);
  const cellW = (width - GAP * 23) / 24;
  const baseY = TOP_PAD + PLOT_H;

  const lowSample = (s: number) => maxSamples > 0 && s < maxSamples / 2;
  const emptyWindow = (d: { consumption: number; samples: number }) =>
    d.consumption === 0 && d.samples > 0;

  function show(d: (typeof byKst)[number], cx: number) {
    const flags: string[] = [`표본 ${d.samples}${lowSample(d.samples) ? ' (적음 - 신뢰도 낮음)' : ''}`];
    if (emptyWindow(d)) flags.push('관측상 소비 0');
    setTip({
      x: cx,
      y: TOP_PAD,
      value: `+${d.consumption.toFixed(1)}%p`,
      label: `${kstLabel(d.hourKst)} KST (UTC ${String(d.hourUtc).padStart(2, '0')}시)`,
      detail: flags.join(' · '),
    });
  }

  return (
    <figure>
      <div ref={ref} className="relative">
        <ChartTooltip tip={tip} width={width} />
        <svg
          width="100%"
          viewBox={`0 0 ${width} ${TOP_PAD + PLOT_H + LABEL_H}`}
          role="img"
          aria-label="KST 시간대별 session 게이지 상승분 막대 차트. 값은 표로 보기에서 전부 읽을 수 있다."
          className="block"
          onPointerLeave={() => setTip(null)}
        >
          <title>시간대별 session 게이지 상승분 (KST)</title>
          {/* 최대값 그리드라인 하나만 - 선택적 직접 라벨 */}
          {max > 0 && (
            <>
              <line x1={0} x2={width} y1={TOP_PAD} y2={TOP_PAD} stroke="var(--grid)" strokeDasharray="2 4" />
              <text x={0} y={TOP_PAD - 4} fontSize={10} fill="var(--mute)" fontFamily="var(--font-mono)">
                +{max.toFixed(0)}%p
              </text>
            </>
          )}
          <line x1={0} x2={width} y1={baseY} y2={baseY} stroke="var(--baseline)" />
          {byKst.map((d, i) => {
            const x = i * (cellW + GAP);
            const barH = max > 0 ? (d.consumption / max) * PLOT_H : 0;
            const dim = lowSample(d.samples);
            const label =
              `${kstLabel(d.hourKst)} (KST): 상승분 ${d.consumption.toFixed(1)}%p, 표본 ${d.samples}` +
              `${emptyWindow(d) ? ' - 습관적으로 비는 창' : ''}`;
            return (
              <g key={d.hourKst}>
                {d.consumption > 0 && (
                  <rect
                    x={x}
                    y={baseY - barH}
                    width={cellW}
                    height={barH}
                    rx={2}
                    fill="var(--series-1)"
                    opacity={dim ? 0.45 : 1}
                  />
                )}
                {emptyWindow(d) && (
                  <circle
                    cx={x + cellW / 2}
                    cy={baseY - 5}
                    r={3}
                    fill="none"
                    stroke="var(--mute)"
                    strokeWidth={1.5}
                  />
                )}
                {/* 히트 타겟은 마크보다 크다 - 열 전체 */}
                <rect
                  x={x}
                  y={0}
                  width={cellW + GAP}
                  height={TOP_PAD + PLOT_H}
                  fill="transparent"
                  tabIndex={0}
                  role="img"
                  aria-label={label}
                  onPointerMove={() => show(d, x + cellW / 2)}
                  onFocus={() => show(d, x + cellW / 2)}
                  onBlur={() => setTip(null)}
                />
                {d.hourKst % 6 === 0 || d.hourKst === 23 ? (
                  <text
                    x={x + cellW / 2}
                    y={baseY + 13}
                    textAnchor="middle"
                    fontSize={10}
                    fill="var(--mute)"
                    fontFamily="var(--font-mono)"
                  >
                    {String(d.hourKst).padStart(2, '0')}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>

      <figcaption className="mt-2 text-xs text-mute">
        시간대 (KST, UTC+9) · 한도 게이지 상승분 기반 (웹 사용 포함) - 트랜스크립트
        히트맵과 다른 신호 ·{' '}
        <svg aria-hidden width="10" height="10" viewBox="0 0 10 10" className="inline-block align-baseline">
          <circle cx="5" cy="5" r="3" fill="none" stroke="var(--mute)" strokeWidth="1.5" />
        </svg>{' '}
        = 소비 0 인데 표본 있음 (습관적으로 비는 창{emptyCount > 0 ? ` ${emptyCount}개` : ' - 이 구간엔 없음'}) ·
        흐린 막대 = 표본 적음
      </figcaption>

      <details className="chart-table mt-2 text-xs text-mute">
        <summary>표로 보기</summary>
        <table className="mt-2">
          <thead>
            <tr>
              <th scope="col">시각 (KST)</th>
              <th scope="col">UTC</th>
              <th scope="col">상승분 (%p)</th>
              <th scope="col">표본</th>
            </tr>
          </thead>
          <tbody>
            {byKst.map((d) => (
              <tr key={d.hourKst}>
                <td>{String(d.hourKst).padStart(2, '0')}:00</td>
                <td>{String(d.hourUtc).padStart(2, '0')}:00</td>
                <td>{d.consumption.toFixed(1)}</td>
                <td>{d.samples}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
