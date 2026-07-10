'use client';

// 시간대별(UTC 0-23) billable 토큰 히트맵 스트립. sequential = 단일 색상 밝음→어두움,
// 다크 모드 앵커 뒤집기는 CSS 변수(--seq-*)가 처리한다. 무지개 금지.
import { useState } from 'react';
import { useMeasure } from './useMeasure';
import { ChartTooltip, type TooltipState } from './ChartTooltip';
import { SEQ_VARS } from '../../lib/palette';
import { compactTokens } from '../../lib/format';
import type { HourlyUsage } from '../../../shared/queries.ts';

const CELL_H = 36;
const GAP = 2;
const LABEL_H = 18;

export function HourHeatmap({ hourly }: { hourly: HourlyUsage[] }) {
  const [ref, width] = useMeasure(360);
  const [tip, setTip] = useState<TooltipState | null>(null);

  const byHour = new Map(hourly.map((h) => [h.hourUtc, h]));
  const max = Math.max(...hourly.map((h) => h.billableTokens), 0);
  const cellW = (width - GAP * 23) / 24;

  function fillFor(v: number): string {
    if (v <= 0 || max === 0) return 'var(--page)';
    const bucket = Math.min(Math.ceil((v / max) * SEQ_VARS.length), SEQ_VARS.length);
    return SEQ_VARS[bucket - 1];
  }

  function show(hour: number, cx: number) {
    const cell = byHour.get(hour);
    setTip({
      x: cx,
      y: 0,
      value: cell === undefined ? '0 tokens' : `${compactTokens(cell.billableTokens)} tokens`,
      label: `${String(hour).padStart(2, '0')}:00-${String((hour + 1) % 24).padStart(2, '0')}:00 UTC`,
      detail: cell === undefined ? 'events 0' : `events ${cell.events}`,
    });
  }

  return (
    <figure>
      <div ref={ref} className="relative">
        <ChartTooltip tip={tip} width={width} />
        <svg
          width="100%"
          viewBox={`0 0 ${width} ${CELL_H + LABEL_H}`}
          role="img"
          aria-label="시간대별 billable 토큰 히트맵 (UTC). 값은 표로 보기에서 전부 읽을 수 있다."
          className="block"
          onPointerLeave={() => setTip(null)}
        >
          <title>시간대별 billable 토큰 (UTC)</title>
          {Array.from({ length: 24 }, (_, h) => {
            const cx = h * (cellW + GAP);
            const v = byHour.get(h)?.billableTokens ?? 0;
            return (
              <g key={h}>
                <rect
                  x={cx}
                  y={0}
                  width={cellW}
                  height={CELL_H}
                  rx={3}
                  fill={fillFor(v)}
                  stroke={v <= 0 ? 'var(--grid)' : 'none'}
                  strokeWidth={1}
                  role="img"
                  tabIndex={0}
                  aria-label={`${h}시 (UTC): ${compactTokens(v)} 토큰`}
                  onPointerMove={() => show(h, cx + cellW / 2)}
                  onFocus={() => show(h, cx + cellW / 2)}
                  onBlur={() => setTip(null)}
                />
                {h % 6 === 0 || h === 23 ? (
                  <text
                    x={cx + cellW / 2}
                    y={CELL_H + 13}
                    textAnchor="middle"
                    fontSize={10}
                    fill="var(--mute)"
                    fontFamily="var(--font-mono)"
                  >
                    {String(h).padStart(2, '0')}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>

      <figcaption className="mt-2 flex items-center gap-2 text-xs text-mute">
        UTC 기준 (KST = UTC+9) · 적음
        <span aria-hidden className="flex gap-px">
          {SEQ_VARS.map((v) => (
            <span key={v} className="h-2.5 w-2.5" style={{ background: v }} />
          ))}
        </span>
        많음
      </figcaption>

      <details className="chart-table mt-2 text-xs text-mute">
        <summary>표로 보기</summary>
        <table className="mt-2">
          <thead>
            <tr>
              <th scope="col">시각 (UTC)</th>
              <th scope="col">billable</th>
              <th scope="col">events</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 24 }, (_, h) => {
              const cell = byHour.get(h);
              return (
                <tr key={h}>
                  <td>{String(h).padStart(2, '0')}:00</td>
                  <td>{(cell?.billableTokens ?? 0).toLocaleString('en-US')}</td>
                  <td>{cell?.events ?? 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
