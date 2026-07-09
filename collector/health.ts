// M4: 수집기가 조용히 죽지 않았는지 본다. 개입성 알림이 아니라 파이프라인 관측이다.
// 결손율의 분모는 "cron 이 발화했고 토큰이 유효했던 슬롯"이다 (ROADMAP 완료 기준 1).
// auth_skip 은 수집기의 결함이 아니므로 분자·분모 어디에도 넣지 않는다.
// 다만 데이터에 실제로 뚫린 구멍이므로 반드시 함께 보고한다 - 가리면 대시보드가 거짓말을 한다.
import type { DatabaseSync } from 'node:sqlite';

export interface Health {
  ok: number;
  failed: number;      // error + http_error
  authSkip: number;
  gapPct: number;      // failed / (ok + failed)
  heartbeatAgeMs: number | null;
  healthy: boolean;
}

export interface HealthDeps {
  db: DatabaseSync;
  heartbeatMtimeMs: number | null;
  now: number;
  maxGapPct: number;
  maxHeartbeatAgeMs: number;
}

export function health(deps: HealthDeps): Health {
  const rows = deps.db
    .prepare(`SELECT status, count(*) AS n FROM collector_run WHERE kind = 'snapshot' GROUP BY status`)
    .all() as Array<{ status: string; n: number }>;

  const count = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  const ok = count('ok');
  const failed = count('error') + count('http_error');
  const authSkip = count('auth_skip');

  const denom = ok + failed;
  const gapPct = denom === 0 ? 0 : (failed / denom) * 100;
  const heartbeatAgeMs = deps.heartbeatMtimeMs === null ? null : deps.now - deps.heartbeatMtimeMs;

  const heartbeatStale = heartbeatAgeMs === null || heartbeatAgeMs > deps.maxHeartbeatAgeMs;
  return { ok, failed, authSkip, gapPct, heartbeatAgeMs, healthy: !heartbeatStale && gapPct <= deps.maxGapPct };
}

export function formatHealth(h: Health): string {
  const age = h.heartbeatAgeMs === null ? 'never' : `${Math.round(h.heartbeatAgeMs / 60_000)}m ago`;
  return `collector ${h.healthy ? 'healthy' : 'UNHEALTHY'}: `
    + `ok=${h.ok} failed=${h.failed} gap=${h.gapPct.toFixed(2)}% `
    + `auth_skip=${h.authSkip} heartbeat=${age}`;
}
