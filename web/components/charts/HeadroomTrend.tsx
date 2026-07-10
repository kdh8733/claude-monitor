'use client';

// 주간 소진율(weekly_all) 시계열. 리셋 경계에서 값이 떨어지는 톱니가 이 차트의 존재 이유다
// (완료 기준 2 의 형상). 그래서 곡선 보간을 하지 않는다 - curveLinear 만이 톱니를 보존한다.
import { useMemo, useState } from 'react';
import { scaleLinear } from '@visx/scale';
import { AreaClosed, LinePath } from '@visx/shape';
import { Group } from '@visx/group';
import { useMeasure } from './useMeasure';
import { ChartTooltip, type TooltipState } from './ChartTooltip';
import { utcDate, utcDateTime } from '../../lib/format';
import type { HeadroomPoint } from '../../../shared/queries.ts';

const H = 220;
const M = { top: 14, right: 14, bottom: 26, left: 38 };

export function HeadroomTrend({
  series,
  fromMs,
  toMs,
  meanUtilization,
}: {
  series: HeadroomPoint[];
  fromMs: number;
  toMs: number;
  meanUtilization: number | null;
}) {
  const [ref, width] = useMeasure();
  const [idx, setIdx] = useState<number | null>(null);

  const innerW = Math.max(width - M.left - M.right, 10);
  const innerH = H - M.top - M.bottom;

  const x = useMemo(
    () => scaleLinear<number>({ domain: [fromMs, toMs], range: [0, innerW] }),
    [fromMs, toMs, innerW],
  );
  const y = useMemo(() => scaleLinear<number>({ domain: [0, 100], range: [innerH, 0] }), [innerH]);

  // 리셋 경계: weekly_reset 값이 직전 샘플과 달라지는 지점 (json 원본에서 온 파생 - 인덱스 추측 없음).
  const resets = useMemo(() => {
    const out: number[] = [];
    for (let i = 1; i < series.length; i++) {
      if (series[i].weeklyReset !== series[i - 1].weeklyReset) out.push(series[i].t);
    }
    return out;
  }, [series]);

  // 일 단위 표 뷰 (WCAG 쌍둥이): 각 UTC 날짜의 마지막 샘플.
  const daily = useMemo(() => {
    const byDay = new Map<string, HeadroomPoint>();
    for (const p of series) byDay.set(utcDate(p.t), p);
    return [...byDay.entries()];
  }, [series]);

  // 정적 레이어(그리드·리셋선·평균선·Area·Line·베이스라인). 안정 참조라 idx(크로스헤어)
  // 리렌더에서 React 가 이 서브트리 diff 를 건너뛴다 - ~2,700 포인트 line/area d 재생성을 막는다.
  const staticLayer = useMemo(
    () => (
      <>
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={0} x2={innerW} y1={y(v)} y2={y(v)} stroke="var(--grid)" strokeWidth={1} />
            <text
              x={-8}
              y={y(v)}
              dy="0.32em"
              textAnchor="end"
              fontSize={10}
              fill="var(--mute)"
              fontFamily="var(--font-mono)"
            >
              {v}
            </text>
          </g>
        ))}

        {resets.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={0} y2={innerH} stroke="var(--baseline)" strokeWidth={1} />
            <text
              x={x(t)}
              y={innerH + 16}
              textAnchor="middle"
              fontSize={10}
              fill="var(--mute)"
              fontFamily="var(--font-mono)"
            >
              {utcDate(t).slice(5)}
            </text>
          </g>
        ))}

        {/* 구간 평균 - 히어로(버려진 헤드룸)의 근거선. 선별적 직접 라벨 */}
        {meanUtilization !== null && (
          <g>
            <line
              x1={0}
              x2={innerW}
              y1={y(meanUtilization)}
              y2={y(meanUtilization)}
              stroke="var(--mute)"
              strokeWidth={1}
            />
            <text
              x={innerW}
              y={y(meanUtilization) - 5}
              textAnchor="end"
              fontSize={10}
              fill="var(--ink2)"
              fontFamily="var(--font-mono)"
              paintOrder="stroke"
              stroke="var(--surface)"
              strokeWidth={3}
            >
              평균 {meanUtilization.toFixed(0)}%
            </text>
          </g>
        )}

        <AreaClosed
          data={series}
          x={(d) => x(d.t)}
          y={(d) => y(d.weeklyAllPct)}
          yScale={y}
          fill="var(--accent)"
          fillOpacity={0.1}
        />
        <LinePath
          data={series}
          x={(d) => x(d.t)}
          y={(d) => y(d.weeklyAllPct)}
          stroke="var(--accent)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        <line x1={0} x2={innerW} y1={innerH} y2={innerH} stroke="var(--baseline)" strokeWidth={1} />
      </>
    ),
    [series, resets, x, y, innerW, innerH, meanUtilization],
  );

  if (series.length === 0) {
    return <p className="text-sm text-mute">이 구간에는 스냅샷이 없습니다.</p>;
  }

  // 정렬된 시계열에서 포인터에 가장 가까운 인덱스 (이진 탐색 - 크로스헤어가 X 를 찾아준다).
  function nearestIndex(tms: number): number {
    let lo = 0;
    let hi = series.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (series[mid].t < tms) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(series[lo - 1].t - tms) < Math.abs(series[lo].t - tms)) return lo - 1;
    return lo;
  }

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width - M.left;
    setIdx(nearestIndex(x.invert(px)));
  }

  function onKeyDown(e: React.KeyboardEvent<SVGSVGElement>) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const cur = idx ?? series.length - 1;
      const next = e.key === 'ArrowLeft' ? Math.max(cur - 1, 0) : Math.min(cur + 1, series.length - 1);
      setIdx(next);
    } else if (e.key === 'Escape') {
      setIdx(null);
    }
  }

  const p = idx === null ? null : series[idx];
  const tip: TooltipState | null =
    p === null
      ? null
      : {
          x: M.left + x(p.t),
          y: M.top + y(p.weeklyAllPct),
          value: `소진율 ${p.weeklyAllPct.toFixed(0)}%`,
          label: `헤드룸 ${(100 - p.weeklyAllPct).toFixed(0)}%`,
          detail: `${utcDateTime(p.t)} UTC`,
          color: 'var(--accent)',
        };

  return (
    <figure>
      <div ref={ref} className="relative">
        <ChartTooltip tip={tip} width={width} />
        <svg
          width="100%"
          viewBox={`0 0 ${width} ${H}`}
          role="img"
          aria-label={`주간 한도 소진율 시계열. 리셋 경계 ${resets.length}회에서 값이 하락한다.${meanUtilization === null ? '' : ` 구간 평균 ${meanUtilization.toFixed(0)}%.`}`}
          tabIndex={0}
          className="block cursor-crosshair focus:outline-1 focus:outline-offset-2 focus:outline-baseline"
          onPointerMove={onPointerMove}
          onPointerLeave={() => setIdx(null)}
          onFocus={() => setIdx((i) => i ?? series.length - 1)}
          onBlur={() => setIdx(null)}
          onKeyDown={onKeyDown}
        >
          <title>주간 한도 소진율 (weekly_all) 시계열 - 리셋 톱니 포함</title>
          <Group left={M.left} top={M.top}>
            {staticLayer}

            {/* 크로스헤어 + 포커스 점 (8px, 2px 서피스 링) */}
            {p !== null && (
              <g pointerEvents="none">
                <line x1={x(p.t)} x2={x(p.t)} y1={0} y2={innerH} stroke="var(--baseline)" strokeWidth={1} />
                <circle cx={x(p.t)} cy={y(p.weeklyAllPct)} r={6} fill="var(--surface)" />
                <circle cx={x(p.t)} cy={y(p.weeklyAllPct)} r={4} fill="var(--accent)" />
              </g>
            )}
          </Group>
        </svg>
      </div>
      <figcaption className="mt-1 flex items-center gap-3 text-xs text-mute">
        <span aria-hidden className="inline-block h-0.5 w-4 bg-accent" /> weekly_all 소진율 (%)
        <span aria-hidden className="inline-block h-3 w-px bg-baseline" /> 주간 리셋 경계 (톱니)
      </figcaption>

      <details className="chart-table mt-2 text-xs text-mute">
        <summary>표로 보기 (일 단위)</summary>
        <table className="mt-2">
          <thead>
            <tr>
              <th scope="col">날짜 (UTC)</th>
              <th scope="col">일말 소진율</th>
              <th scope="col">헤드룸</th>
            </tr>
          </thead>
          <tbody>
            {daily.map(([day, dp]) => (
              <tr key={day}>
                <td>{day}</td>
                <td>{dp.weeklyAllPct.toFixed(0)}%</td>
                <td>{(100 - dp.weeklyAllPct).toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
