'use client';

/**
 * 차트 공용 툴팁. 값이 주연, 라벨이 조연 (dataviz interaction 규칙).
 * 내용은 전부 textContent 로 들어간다 - 라벨은 신뢰하지 않는 데이터다.
 */
export interface TooltipState {
  x: number;
  y: number;
  /** 주연: 값 */
  value: string;
  /** 조연: 시리즈/카테고리 이름 */
  label: string;
  /** 부가 줄 (옵션) */
  detail?: string;
  /** 시리즈 키 색 (선 키) */
  color?: string;
}

export function ChartTooltip({ tip, width }: { tip: TooltipState | null; width: number }) {
  if (tip === null) return null;
  const left = Math.min(Math.max(tip.x, 60), width - 60);
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-md border border-hairline bg-surface px-2.5 py-1.5 text-xs shadow-sm"
      style={{ left, top: Math.max(tip.y - 8, 0), transform: 'translate(-50%, -100%)' }}
    >
      <div className="flex items-center gap-1.5 whitespace-nowrap">
        {tip.color !== undefined && (
          <span aria-hidden className="inline-block h-0.5 w-3" style={{ background: tip.color }} />
        )}
        <span className="font-semibold text-ink">{tip.value}</span>
        <span className="text-ink2">{tip.label}</span>
      </div>
      {tip.detail !== undefined && (
        <div className="mt-0.5 whitespace-nowrap text-mute">{tip.detail}</div>
      )}
    </div>
  );
}
