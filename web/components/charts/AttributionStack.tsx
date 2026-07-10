'use client';

// 귀속 100% 스택 바 (프로젝트별/모델별 공용). 가로 한 줄, 세그먼트 = 엔티티.
// 색은 엔티티의 고정 인덱스를 따른다 - 값 순위가 아니다 (recolor-on-filter 금지의 정신).
// 세그먼트 사이 2px 서피스 갭, 바깥 모서리만 둥글게 (clipPath).
import { useId, useState } from 'react';
import { useMeasure } from './useMeasure';
import { ChartTooltip, type TooltipState } from './ChartTooltip';
import { compactTokens } from '../../lib/format';

export interface StackItem {
  label: string;
  /** 고정 색 슬롯 (엔티티의 알파벳순 인덱스에서 부여) */
  color: string;
  events: number;
  billable: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

const BAR_H = 24;
const GAP = 2;

export function AttributionStack({ items, unitLabel }: { items: StackItem[]; unitLabel: string }) {
  const [ref, width] = useMeasure(360);
  const [tip, setTip] = useState<TooltipState | null>(null);
  const clipId = useId();

  const total = items.reduce((s, it) => s + it.billable, 0);
  if (total === 0) {
    return <p className="text-sm text-mute">이 구간에는 이벤트가 없습니다.</p>;
  }

  // 표시 순서 = 몫 내림차순. 색은 이미 엔티티에 고정돼 있어 순서와 무관하다.
  const sorted = [...items].sort((a, b) => b.billable - a.billable);

  let cursor = 0;
  const segs = sorted.map((it) => {
    const w = (it.billable / total) * width;
    const seg = { ...it, x: cursor, w };
    cursor += w;
    return seg;
  });

  function show(seg: (typeof segs)[number]) {
    setTip({
      x: seg.x + seg.w / 2,
      y: 0,
      value: `${compactTokens(seg.billable)} tokens`,
      label: `${seg.label} · ${((seg.billable / total) * 100).toFixed(0)}%`,
      detail: `${seg.events} events`,
      color: seg.color,
    });
  }

  return (
    <figure>
      <div ref={ref} className="relative">
        <ChartTooltip tip={tip} width={width} />
        <svg
          width="100%"
          viewBox={`0 0 ${width} ${BAR_H}`}
          role="img"
          aria-label={`${unitLabel} billable 토큰 귀속. ${sorted
            .map((it) => `${it.label} ${((it.billable / total) * 100).toFixed(0)}%`)
            .join(', ')}`}
          className="block"
          onPointerLeave={() => setTip(null)}
        >
          <title>{`${unitLabel} billable 토큰 귀속 (100% 스택)`}</title>
          <defs>
            <clipPath id={clipId}>
              <rect x={0} y={0} width={width} height={BAR_H} rx={4} />
            </clipPath>
          </defs>
          <g clipPath={`url(#${clipId})`}>
            {segs.map((seg, i) => (
              <rect
                key={seg.label}
                x={seg.x + (i === 0 ? 0 : GAP / 2)}
                y={0}
                width={Math.max(seg.w - (i === 0 || i === segs.length - 1 ? GAP / 2 : GAP), 1)}
                height={BAR_H}
                fill={seg.color}
                tabIndex={0}
                aria-label={`${seg.label}: ${compactTokens(seg.billable)} 토큰, ${((seg.billable / total) * 100).toFixed(0)}%`}
                onPointerMove={() => show(seg)}
                onFocus={() => show(seg)}
                onBlur={() => setTip(null)}
              />
            ))}
          </g>
        </svg>
      </div>

      {/* 범례: 2개 이상 시리즈 - 항상 존재. 스와치 + 라벨 + 몫 (텍스트는 텍스트 토큰) */}
      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {sorted.map((it) => (
          <span key={it.label} className="flex items-center gap-1.5 text-ink2">
            <span aria-hidden className="h-2.5 w-2.5 rounded-[3px]" style={{ background: it.color }} />
            {it.label}
            <span className="text-mute">{((it.billable / total) * 100).toFixed(0)}%</span>
          </span>
        ))}
      </figcaption>

      <details className="chart-table mt-2 text-xs text-mute">
        <summary>표로 보기</summary>
        <table className="mt-2">
          <thead>
            <tr>
              <th scope="col">{unitLabel}</th>
              <th scope="col">billable</th>
              <th scope="col">몫</th>
              <th scope="col">events</th>
              <th scope="col">input</th>
              <th scope="col">output</th>
              <th scope="col">cache read</th>
              <th scope="col">cache write</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((it) => (
              <tr key={it.label}>
                <td>{it.label}</td>
                <td>{it.billable.toLocaleString('en-US')}</td>
                <td>{((it.billable / total) * 100).toFixed(1)}%</td>
                <td>{it.events.toLocaleString('en-US')}</td>
                <td>{it.inputTokens.toLocaleString('en-US')}</td>
                <td>{it.outputTokens.toLocaleString('en-US')}</td>
                <td>{it.cacheReadTokens.toLocaleString('en-US')}</td>
                <td>{it.cacheCreationTokens.toLocaleString('en-US')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
