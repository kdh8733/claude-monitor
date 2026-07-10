// M8 집계 쿼리 계층. 읽기 측 - 이 모듈은 DB 에 절대 쓰지 않는다 (호출자가 읽기 전용으로 연다).
//
// 분할선 (003 축 1, 확정): SQL = 집합 집계·범위 필터, TS = 단가 적용 + 성형.
// materialized 없음 - 요청 시 계산이므로 단가 개정은 재조회일 뿐, backfill 이 없다 (CLAUDE.md 5항).
//
// 환산가치 계산 규칙: 단가는 이벤트마다 다르다 (모델·speed·tier·시각의 함수).
// 토큰을 먼저 합산한 뒤 단가를 곱하면 틀린다 - **이벤트별로** apiEquivalentUsd 를 계산해 더한다.
// 그래서 귀속 집계는 SQL GROUP BY 가 아니라 범위 필터 후 TS fold 다.
// 단가 미상 이벤트가 하나라도 있으면 그 그룹의 합은 null 이다 (부분합은 거짓말이다).
import type { DatabaseSync } from 'node:sqlite';
import { apiEquivalentUsd } from './pricing.ts';

// 모든 시간 구간은 반open [fromMs, toMs) 이다 (UTC ms).

// ============================================================================
// billable 토큰 정의 - **읽기 측이 소유한다** (002 불변식 I7).
//
//   billable = input_tokens + output_tokens + cache_creation_input_tokens
//   cache_read_input_tokens 는 **제외**한다.
//
// 완료 기준 3의 오라클(원본 JSONL 독립 재계산)은 이 정의와 일치해야 한다.
// 정의를 바꾸면 오라클 스크립트도 함께 바꿔라.
// ============================================================================

/** billable 을 구성하는 usage_event 컬럼. SQL 합산식은 이 목록에서 파생한다. */
export const BILLABLE_TOKEN_COLUMNS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
] as const;

const BILLABLE_SQL = BILLABLE_TOKEN_COLUMNS.join(' + ');

/** billable 토큰 정의의 TS 형태. BILLABLE_TOKEN_COLUMNS 와 같은 항이어야 한다. */
export function billableTokens(e: {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
}): number {
  return e.inputTokens + e.outputTokens + e.cacheCreationTokens;
}

// ---- 프로젝트 라벨 (004 C8) ----

/**
 * cwd 를 설정된 루트 목록에 상대화해 프로젝트 라벨을 얻는다.
 * 어느 루트에도 안 걸리면 마지막 경로 세그먼트만 쓴다.
 * **cwd 전문을 그대로 반환하지 않는다** - 데모/스크린샷에 실 경로가 새는 경로다 (완료 기준 6).
 */
export function projectLabel(cwd: string | null, roots: string[]): string {
  if (cwd === null) return '<unknown>';
  for (const root of roots) {
    // 경로 경계를 지킨다: /root/workspaceX 는 /root/workspace 의 하위가 아니다.
    const prefix = root.endsWith('/') ? root : `${root}/`;
    if (cwd.startsWith(prefix)) {
      const first = cwd.slice(prefix.length).split('/')[0];
      if (first !== '') return first;
    }
  }
  const segments = cwd.split('/').filter((s) => s !== '');
  return segments.length > 0 ? segments[segments.length - 1] : '<unknown>';
}

// ---- 버려진 헤드룸 (완료 기준 5, 첫 질문) ----

export interface HeadroomSummary {
  samples: number;
  meanUtilization: number | null;
  abandonedPct: number | null;
}

/**
 * 구간 내 snapshot.weekly_all_pct 의 산술 평균과 그 여집합(버려진 헤드룸).
 * 파생 컬럼이 NULL 인 행(응답에 seven_day 가 없던 경우)은 제외한다 - count()/avg() 가 NULL 을 무시한다.
 * 샘플 0 이면 둘 다 null 이다. 0 이 아니다 - "헤드룸 100% 버렸다"는 거짓말이다.
 */
export function abandonedHeadroom(db: DatabaseSync, fromMs: number, toMs: number): HeadroomSummary {
  const row = db.prepare(`
    SELECT count(weekly_all_pct) AS samples, avg(weekly_all_pct) AS mean
    FROM snapshot
    WHERE captured_at >= ? AND captured_at < ?
  `).get(fromMs, toMs) as { samples: number; mean: number | null };
  if (row.samples === 0 || row.mean === null) {
    return { samples: 0, meanUtilization: null, abandonedPct: null };
  }
  return { samples: row.samples, meanUtilization: row.mean, abandonedPct: 100 - row.mean };
}

// ---- 헤드룸 시계열 (M10 - 리셋 톱니의 원자료) ----

export interface HeadroomPoint {
  t: number;
  weeklyAllPct: number;
  weeklyReset: string | null;
}

/**
 * 구간 내 weekly_all 소진율 시계열. 파생 컬럼이 NULL 인 행(응답에 seven_day 가 없던 경우)은
 * 점이 아니라 구멍이므로 제외한다. weekly_reset 은 리셋 경계 마커용 - 값이 바뀌는 지점이 경계다.
 */
export function headroomSeries(db: DatabaseSync, fromMs: number, toMs: number): HeadroomPoint[] {
  const rows = db.prepare(`
    SELECT captured_at, weekly_all_pct, weekly_reset
    FROM snapshot
    WHERE captured_at >= ? AND captured_at < ? AND weekly_all_pct IS NOT NULL
    ORDER BY captured_at
  `).all(fromMs, toMs) as Array<{ captured_at: number; weekly_all_pct: number; weekly_reset: string | null }>;
  return rows.map((r) => ({ t: r.captured_at, weeklyAllPct: r.weekly_all_pct, weeklyReset: r.weekly_reset }));
}

/**
 * 최신 스냅샷 시각. 대시보드의 시간 앵커다 - 벽시계(Date.now)가 아니라 데이터의 끝을 쓴다.
 * 데모 빌드가 결정적이어야 하고(같은 시드 = 같은 화면), 라이브도 "수집된 마지막 시점"이 정직하다.
 */
export function latestCapturedAt(db: DatabaseSync): number | null {
  const row = db.prepare('SELECT max(captured_at) AS t FROM snapshot').get() as { t: number | null };
  return row.t;
}

// ---- 가장 먼저 차는 스코프 (완료 기준 5, 둘째 질문) ----

export interface ScopeRank {
  kind: string;
  percent: number | null;
  isActive: boolean;
  resetsAt: string | null;
  scopeModel: string | null;
}

/**
 * atOrBeforeMs 이전의 가장 최근 스냅샷 1건에서 limits[] 를 percent 내림차순으로 편다.
 *
 * limits[] 는 배열이다 - $.limits[N] 인덱스 경로는 원소 순서가 바뀌면 조용히 틀린다.
 * 반드시 json_each 로 펼친다 (004 C3).
 * 소진율 필드는 최상위와 달리 utilization 이 아니라 **percent** 다 (2026-07-09 실측, ROADMAP).
 */
export function scopeRanking(db: DatabaseSync, atOrBeforeMs: number): ScopeRank[] {
  const snap = db.prepare(`
    SELECT id FROM snapshot
    WHERE captured_at <= ?
    ORDER BY captured_at DESC, id DESC
    LIMIT 1
  `).get(atOrBeforeMs) as { id: number } | undefined;
  if (snap === undefined) return [];

  const rows = db.prepare(`
    SELECT
      json_extract(je.value, '$.kind')      AS kind,
      json_extract(je.value, '$.percent')   AS percent,
      json_extract(je.value, '$.is_active') AS is_active,
      json_extract(je.value, '$.resets_at') AS resets_at,
      json_extract(je.value, '$.scope.model.display_name') AS scope_model
    FROM snapshot AS s, json_each(s.raw_json, '$.limits') AS je
    WHERE s.id = ?
    ORDER BY percent DESC
  `).all(snap.id) as Array<{
    kind: string;
    percent: number | null;
    is_active: number | null;
    resets_at: string | null;
    scope_model: string | null;
  }>;

  return rows.map((r) => ({
    kind: r.kind,
    percent: r.percent,
    isActive: r.is_active === 1,
    resetsAt: r.resets_at,
    scopeModel: r.scope_model,
  }));
}

// ---- 귀속 집계 (프로젝트/모델/시간대) ----

interface EventRow {
  captured_at: number;
  cwd: string | null;
  model: string | null;
  service_tier: string | null;
  speed: string | null;
  is_sidechain: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_creation_5m_tokens: number;
  cache_creation_1h_tokens: number;
}

function eventsInRange(db: DatabaseSync, fromMs: number, toMs: number): EventRow[] {
  return db.prepare(`
    SELECT captured_at, cwd, model, service_tier, speed, is_sidechain,
           input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
           cache_creation_5m_tokens, cache_creation_1h_tokens
    FROM usage_event
    WHERE captured_at >= ? AND captured_at < ?
  `).all(fromMs, toMs) as unknown as EventRow[];
}

export interface TokenTotals {
  events: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** null = 그룹에 단가 미상 이벤트가 있다. "모른다"이지 0 이 아니다. **청구액이 아니다** (CLAUDE.md 6항). */
  apiEquivalentUsd: number | null;
}

function emptyTotals(): TokenTotals {
  return { events: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, apiEquivalentUsd: 0 };
}

function addEvent(acc: TokenTotals, e: EventRow): void {
  acc.events += 1;
  acc.inputTokens += e.input_tokens;
  acc.outputTokens += e.output_tokens;
  acc.cacheReadTokens += e.cache_read_input_tokens;
  acc.cacheCreationTokens += e.cache_creation_input_tokens;
  if (acc.apiEquivalentUsd === null) return; // 이미 오염 - 부분합을 만들지 않는다
  const usd = apiEquivalentUsd(e.model, e.speed, e.service_tier, e.captured_at, {
    inputTokens: e.input_tokens,
    outputTokens: e.output_tokens,
    cacheReadInputTokens: e.cache_read_input_tokens,
    cacheCreation5mTokens: e.cache_creation_5m_tokens,
    cacheCreation1hTokens: e.cache_creation_1h_tokens,
    // 정합성 검사용. 분해되지 않은 잔여분이 있으면 pricing 이 null 을 낸다 (조용한 $0 방지).
    cacheCreationInputTokens: e.cache_creation_input_tokens,
  });
  acc.apiEquivalentUsd = usd === null ? null : acc.apiEquivalentUsd + usd;
}

export interface ProjectAttribution extends TokenTotals {
  project: string;
  /** isSidechain(서브에이전트) 이벤트 수. events 에 포함된 채로 따로 센다 - 제외하지 않는다. */
  sidechainEvents: number;
}

export function attributionByProject(
  db: DatabaseSync,
  fromMs: number,
  toMs: number,
  roots: string[],
): ProjectAttribution[] {
  const groups = new Map<string, ProjectAttribution>();
  for (const e of eventsInRange(db, fromMs, toMs)) {
    const project = projectLabel(e.cwd, roots);
    let acc = groups.get(project);
    if (acc === undefined) {
      acc = { project, sidechainEvents: 0, ...emptyTotals() };
      groups.set(project, acc);
    }
    if (e.is_sidechain === 1) acc.sidechainEvents += 1;
    addEvent(acc, e);
  }
  return [...groups.values()].sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : 0));
}

export interface ModelAttribution extends TokenTotals {
  model: string | null;
}

export function attributionByModel(db: DatabaseSync, fromMs: number, toMs: number): ModelAttribution[] {
  const groups = new Map<string | null, ModelAttribution>();
  for (const e of eventsInRange(db, fromMs, toMs)) {
    let acc = groups.get(e.model);
    if (acc === undefined) {
      acc = { model: e.model, ...emptyTotals() };
      groups.set(e.model, acc);
    }
    addEvent(acc, e);
  }
  return [...groups.values()].sort((a, b) => {
    const ka = a.model ?? '';
    const kb = b.model ?? '';
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export interface HourlyUsage {
  /** UTC 기준 0..23. 이벤트가 없는 시간대는 행이 없다. */
  hourUtc: number;
  events: number;
  billableTokens: number;
}

/** 시간대별 이벤트 수와 billable 토큰. 단가가 없으니 순수 SQL 집계다 (003 축 1). */
export function hourlyUsage(db: DatabaseSync, fromMs: number, toMs: number): HourlyUsage[] {
  const rows = db.prepare(`
    SELECT CAST(strftime('%H', captured_at / 1000, 'unixepoch') AS INTEGER) AS hour_utc,
           count(*) AS events,
           SUM(${BILLABLE_SQL}) AS billable
    FROM usage_event
    WHERE captured_at >= ? AND captured_at < ?
    GROUP BY hour_utc
    ORDER BY hour_utc
  `).all(fromMs, toMs) as Array<{ hour_utc: number; events: number; billable: number }>;
  return rows.map((r) => ({ hourUtc: r.hour_utc, events: r.events, billableTokens: r.billable }));
}

// ---- 결손 리포트 (대시보드가 거짓말하지 않게) ----

export interface CollectionGaps {
  ok: number;
  /** error + http_error. 결손율의 분자다. */
  failed: number;
  /** 토큰 만료로 건너뛴 슬롯. 결손율 분모에서 빠지지만 **반드시 함께 노출한다** - 데이터에 실제로 뚫린 구멍이다 (ROADMAP 완료 기준 1). */
  authSkip: number;
  /** failed / (ok + failed) * 100. 분모 0 이면 0. */
  gapPct: number;
}

export function collectionGaps(db: DatabaseSync, fromMs: number, toMs: number): CollectionGaps {
  const rows = db.prepare(`
    SELECT status, count(*) AS n
    FROM collector_run
    WHERE kind = 'snapshot' AND started_at >= ? AND started_at < ?
    GROUP BY status
  `).all(fromMs, toMs) as Array<{ status: string; n: number }>;

  let ok = 0;
  let failed = 0;
  let authSkip = 0;
  for (const r of rows) {
    if (r.status === 'ok') ok = r.n;
    else if (r.status === 'auth_skip') authSkip = r.n;
    else if (r.status === 'error' || r.status === 'http_error') failed += r.n;
  }
  const denom = ok + failed;
  return { ok, failed, authSkip, gapPct: denom === 0 ? 0 : (failed * 100) / denom };
}
