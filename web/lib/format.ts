// 표시 포맷. 서버/클라이언트 공용 - 시계를 읽지 않는다 (앵커 기준 상대 시각만).

/** 토큰 수 압축 표기. 1284 -> 1.3K, 12_900_000 -> 12.9M */
export function compactTokens(n: number): string {
  if (n >= 1_000_000_000) return `${trim1(n / 1_000_000_000)}B`;
  if (n >= 1_000_000) return `${trim1(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim1(n / 1_000)}K`;
  return String(n);
}

function trim1(v: number): string {
  const s = v.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

export function formatUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

/** UTC 날짜 라벨 (yyyy-mm-dd). 로케일/타임존 비의존 - 데모 빌드가 결정적이어야 한다. */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** UTC 시각 라벨 (mm-dd hh:mm). */
export function utcDateTime(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

/** 앵커 기준 리셋까지 남은 시간. "D-1 4h" / "3h 20m" / "지남" */
export function untilReset(resetsAtIso: string | null, anchorMs: number): string | null {
  if (resetsAtIso === null) return null;
  const diff = Date.parse(resetsAtIso) - anchorMs;
  if (Number.isNaN(diff)) return null;
  if (diff <= 0) return '지남';
  const totalMin = Math.floor(diff / 60_000);
  const days = Math.floor(totalMin / (24 * 60));
  const hours = Math.floor((totalMin % (24 * 60)) / 60);
  const min = totalMin % 60;
  if (days > 0) return `D-${days} ${hours}h`;
  if (hours > 0) return `${hours}h ${min}m`;
  return `${min}m`;
}
