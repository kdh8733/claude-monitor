// "지금 쓰기 좋은가" 리드아웃. 서버 컴포넌트 - 상호작용 없음, 모든 값이 직접 라벨이다.
// 최신 스냅샷의 limits[] 관측치 + 리셋 카운트다운(anchorMs 기준으로 이미 분으로 환산됨)을
// 보여줄 뿐, 지시("지금 돌려라")를 하지 않는다. session 이 가장 크다 - 몰아 쓸 때
// 먼저 차는 병목이 5시간 창이라서다 (실측 분석, 2026-07).
import { severityColor } from '../lib/palette';
import { approxAfter, scopeName } from '../lib/format';
import type { CapacityLimit } from '../../shared/queries.ts';

/** 카운트다운 텍스트. minutesToReset null = 리셋 시각 미상(0% 직후 등) - 음수를 만들지 않는다. */
function resetText(l: CapacityLimit): string {
  return l.minutesToReset === null ? '리셋 시각 -' : `리셋까지 ${approxAfter(l.minutesToReset)}`;
}

function Meter({ percent, name, height }: { percent: number; name: string; height: string }) {
  const clamped = Math.min(Math.max(percent, 0), 100);
  const fill = severityColor(clamped);
  return (
    <div
      role="img"
      aria-label={`${name} 소진율 ${clamped.toFixed(0)}%`}
      className={`w-full overflow-hidden rounded-full ${height}`}
      style={{ background: `color-mix(in oklab, ${fill} 15%, var(--surface))` }}
    >
      <div className="h-full rounded-full" style={{ width: `${clamped}%`, background: fill }} />
    </div>
  );
}

function ActiveBadge() {
  return (
    <span className="rounded-sm border border-hairline px-1 py-px text-ink2">지금 바인딩</span>
  );
}

export function CapacityReadout({ capacity }: { capacity: CapacityLimit[] }) {
  if (capacity.length === 0) {
    return <p className="text-sm text-mute">최신 스냅샷의 limits[] 가 비어 있습니다.</p>;
  }
  const session = capacity.find((l) => l.kind === 'session') ?? null;
  const rest = capacity.filter((l) => l !== session);

  return (
    <div>
      {session !== null && (
        <div className="border-b border-grid pb-4">
          <p className="micro">SESSION · 몰아 쓸 때 가장 먼저 차는 5시간 창</p>
          <p className="mt-2 flex items-baseline gap-3">
            <span className="text-5xl font-bold leading-none tracking-tight tabular-nums">
              {session.percent === null ? '-' : session.percent.toFixed(0)}
              <span className="text-2xl font-semibold text-ink2">%</span>
            </span>
            <span className="text-sm text-ink2">
              소진 관측
              {session.percent !== null && (
                <>
                  <br />
                  <span className="text-xs text-mute">
                    여유 {(100 - Math.min(Math.max(session.percent, 0), 100)).toFixed(0)}%p
                  </span>
                </>
              )}
            </span>
          </p>
          <div className="mt-3">
            <Meter percent={session.percent ?? 0} name={scopeName(session.kind, session.scopeModel)} height="h-3" />
          </div>
          <p className="mt-1.5 flex items-center gap-2 text-xs text-mute">
            <span className="tabular-nums">{resetText(session)}</span>
            {session.isActive && <ActiveBadge />}
          </p>
        </div>
      )}

      <ol className="divide-y divide-grid">
        {rest.map((l) => {
          const name = scopeName(l.kind, l.scopeModel);
          return (
            <li key={l.kind + (l.scopeModel ?? '')} className="py-3 last:pb-0">
              <div className="flex items-baseline justify-between gap-3">
                <p className="min-w-0 truncate text-sm font-semibold">{name}</p>
                <p className="text-sm font-semibold tabular-nums">
                  {l.percent === null ? '-' : `${l.percent.toFixed(0)}%`}
                </p>
              </div>
              <div className="mt-1.5">
                <Meter percent={l.percent ?? 0} name={name} height="h-1.5" />
              </div>
              <p className="mt-1 flex items-center gap-2 text-xs text-mute">
                <span className="tabular-nums">{resetText(l)}</span>
                {l.isActive && <ActiveBadge />}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
