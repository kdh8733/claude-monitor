'use client';

// 수집 상태 스트립: UTC 일 단위 collector_run 상태의 스택 바.
// status 색은 예약 팔레트다 (good/warning/critical) - 시리즈 정체성으로 재사용하지 않고,
// 색만으로 말하지 않는다 (범례 라벨 + 표 뷰 상시 제공).
// auth_skip 은 경고색으로 **항상 보인다** - 데이터에 실제로 뚫린 구멍이다 (완료 기준 1).
import { useState } from 'react';
import { useMeasure } from './useMeasure';
import { ChartTooltip, type TooltipState } from './ChartTooltip';
import { utcDate } from '../../lib/format';
import type { RunDaily } from '../../../shared/queries.ts';

const H = 120;
const LABEL_H = 18;
const GAP = 2;
const DAY = 24 * 60 * 60 * 1000;

export function RunStrip({
  runDaily,
  fromMs,
  toMs,
}: {
  runDaily: RunDaily[];
  fromMs: number;
  toMs: number;
}) {
  const [ref, width] = useMeasure();
  const [tip, setTip] = useState<TooltipState | null>(null);

  // run 이 없는 날도 자리(빈 슬롯)를 갖는다 - 구멍이 보여야 정직하다.
  const days: string[] = [];
  for (let t = fromMs; t < toMs; t += DAY) days.push(utcDate(t));
  const byDay = new Map(runDaily.map((r) => [r.dayUtc, r]));

  const max = Math.max(...days.map((d) => {
    const r = byDay.get(d);
    return r === undefined ? 0 : r.ok + r.failed + r.authSkip;
  }), 1);

  const cellW = Math.max((width - GAP * (days.length - 1)) / days.length, 2);
  const scale = (v: number) => (v / max) * (H - 8);

  function show(day: string, cx: number) {
    const r = byDay.get(day);
    setTip({
      x: cx,
      y: 0,
      value: r === undefined ? '발화 0' : `ok ${r.ok} · 실패 ${r.failed} · auth_skip ${r.authSkip}`,
      label: day,
      detail: r === undefined ? '이 날은 수집기가 한 번도 깨지 않았다' : undefined,
    });
  }

  return (
    <figure>
      <div ref={ref} className="relative">
        <ChartTooltip tip={tip} width={width} />
        <svg
          width="100%"
          viewBox={`0 0 ${width} ${H + LABEL_H}`}
          role="img"
          aria-label="일 단위 수집 상태. 성공/실패/auth_skip 슬롯 수. 값은 표로 보기에서 전부 읽을 수 있다."
          className="block"
          onPointerLeave={() => setTip(null)}
        >
          <title>일 단위 수집 상태 (ok / 실패 / auth_skip)</title>
          <line x1={0} x2={width} y1={H} y2={H} stroke="var(--baseline)" strokeWidth={1} />
          {days.map((day, i) => {
            const r = byDay.get(day);
            const cx = i * (cellW + GAP);
            const okH = scale(r?.ok ?? 0);
            const skipH = scale(r?.authSkip ?? 0);
            const failH = scale(r?.failed ?? 0);
            const total = (r?.ok ?? 0) + (r?.authSkip ?? 0) + (r?.failed ?? 0);
            return (
              <g key={day}>
                {/* 히트 타깃은 마크보다 크다 - 열 전체 */}
                <rect
                  x={cx}
                  y={0}
                  width={cellW}
                  height={H}
                  fill="transparent"
                  role="img"
                  tabIndex={0}
                  aria-label={`${day}: 성공 ${r?.ok ?? 0}, 실패 ${r?.failed ?? 0}, auth_skip ${r?.authSkip ?? 0}`}
                  onPointerMove={() => show(day, cx + cellW / 2)}
                  onFocus={() => show(day, cx + cellW / 2)}
                  onBlur={() => setTip(null)}
                />
                {total === 0 ? (
                  <rect x={cx} y={H - 2} width={cellW} height={2} fill="var(--grid)" pointerEvents="none" />
                ) : (
                  <g pointerEvents="none">
                    <rect x={cx} y={H - okH} width={cellW} height={okH} fill="var(--status-good)" />
                    <rect x={cx} y={H - okH - GAP - skipH} width={cellW} height={skipH} fill="var(--status-warning)" />
                    <rect x={cx} y={H - okH - skipH - GAP * 2 - failH} width={cellW} height={failH} fill="var(--status-critical)" />
                  </g>
                )}
                {i % 7 === 0 && (
                  <text
                    x={cx}
                    y={H + 14}
                    fontSize={10}
                    fill="var(--mute)"
                    fontFamily="var(--font-mono)"
                  >
                    {day.slice(5)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink2">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-2.5 rounded-[3px]" style={{ background: 'var(--status-good)' }} />
          성공 (ok)
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-2.5 rounded-[3px]" style={{ background: 'var(--status-warning)' }} />
          auth_skip (토큰 만료 - 데이터 구멍)
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-2.5 rounded-[3px]" style={{ background: 'var(--status-critical)' }} />
          실패 (error + http_error)
        </span>
      </figcaption>

      <details className="chart-table mt-2 text-xs text-mute">
        <summary>표로 보기 (일 단위)</summary>
        <table className="mt-2">
          <thead>
            <tr>
              <th scope="col">날짜 (UTC)</th>
              <th scope="col">성공</th>
              <th scope="col">실패</th>
              <th scope="col">auth_skip</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => {
              const r = byDay.get(day);
              return (
                <tr key={day}>
                  <td>{day}</td>
                  <td>{r?.ok ?? 0}</td>
                  <td>{r?.failed ?? 0}</td>
                  <td>{r?.authSkip ?? 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
