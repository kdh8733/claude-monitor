// 소진율 게이지. SVG arc 수작업 (ROADMAP M10 명시). 서버 컴포넌트 - 상호작용 없음,
// 값은 직접 라벨로 상시 표시된다 (툴팁이 값을 가두지 않는다).
import { severityColor } from '../../lib/palette';

const SWEEP = 240; // 도. 150° 에서 시작해 시계방향 240° (게이지 관례)
const START = 150;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/** startDeg 에서 시계방향으로 deltaDeg 만큼의 원호 path. */
function arcPath(cx: number, cy: number, r: number, startDeg: number, deltaDeg: number): string {
  const [x0, y0] = polar(cx, cy, r, startDeg);
  const [x1, y1] = polar(cx, cy, r, startDeg + deltaDeg);
  const largeArc = deltaDeg > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export function ScopeGauge({ percent, label }: { percent: number; label: string }) {
  const clamped = Math.min(Math.max(percent, 0), 100);
  const fill = severityColor(clamped);
  const cx = 40;
  const cy = 42;
  const r = 30;
  return (
    <svg width={80} height={72} viewBox="0 0 80 72" role="img" aria-label={`${label} 소진율 ${clamped.toFixed(0)}%`}>
      <title>{`${label} 소진율 ${clamped.toFixed(0)}%`}</title>
      {/* 트랙: 채움색의 옅은 단계 - 상태가 바 전체에서 읽힌다 (meter 규칙) */}
      <path
        d={arcPath(cx, cy, r, START, SWEEP)}
        fill="none"
        stroke={`color-mix(in oklab, ${fill} 18%, var(--surface))`}
        strokeWidth={8}
        strokeLinecap="round"
      />
      {clamped > 0 && (
        <path
          d={arcPath(cx, cy, r, START, (SWEEP * clamped) / 100)}
          fill="none"
          stroke={fill}
          strokeWidth={8}
          strokeLinecap="round"
        />
      )}
      <text
        x={cx}
        y={cy + 4}
        textAnchor="middle"
        fontSize={17}
        fontWeight={600}
        fill="var(--ink)"
      >
        {clamped.toFixed(0)}
        <tspan fontSize={10} fill="var(--mute)">
          %
        </tspan>
      </text>
    </svg>
  );
}
