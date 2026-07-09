// M8 집계 쿼리 계층 테스트. 실 트랜스크립트/실 DB 를 읽지 않는다 - 전부 손계산 가능한 합성 픽스처.
// 픽스처는 쓰기 핸들로 시딩한 뒤 닫고, **읽기 전용으로 다시 연 핸들**로 쿼리한다.
// 쿼리가 쓰기를 시도하면 여기서 터진다 (읽기 측 계약, 003 축 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../collector/db.ts';
import {
  projectLabel,
  abandonedHeadroom,
  scopeRanking,
  attributionByProject,
  attributionByModel,
  hourlyUsage,
  collectionGaps,
  billableTokens,
} from './queries.ts';

const ROOTS = ['/root/workspace'];
const at = (iso: string) => Date.parse(iso);

function seededReadOnlyDb(seed: (db: DatabaseSync) => void): DatabaseSync {
  const path = join(mkdtempSync(join(tmpdir(), 'claude-monitor-m8-')), 'test.sqlite');
  const writer = openDb(path);
  seed(writer);
  writer.close();
  return new DatabaseSync(path, { readOnly: true });
}

function insertSnapshot(db: DatabaseSync, capturedAtIso: string, raw: unknown): void {
  db.prepare('INSERT INTO snapshot (captured_at, raw_json) VALUES (?, ?)')
    .run(at(capturedAtIso), JSON.stringify(raw));
}

let nextMessageId = 0;
function insertEvent(db: DatabaseSync, override: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    message_id: `m-${nextMessageId++}`,
    captured_at: at('2026-07-01T12:00:00Z'),
    source_id: 'wsl',
    session_id: 'sess-1',
    cwd: '/root/workspace/aurora-api',
    git_branch: 'main',
    model: 'claude-opus-4-8',
    service_tier: 'standard',
    speed: 'standard',
    is_sidechain: 0,
    request_id: 'req-1',
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_creation_5m_tokens: 0,
    cache_creation_1h_tokens: 0,
    raw_usage_json: '{}',
    ...override,
  };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO usage_event (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...(Object.values(row) as Array<string | number>));
}

function insertRun(db: DatabaseSync, status: string, startedAtMs: number, kind = 'snapshot'): void {
  db.prepare('INSERT INTO collector_run (started_at, finished_at, kind, status) VALUES (?, ?, ?, ?)')
    .run(startedAtMs, startedAtMs + 1, kind, status);
}

// ---- 1. projectLabel (004 C8) ----

test('projectLabel: root child -> first segment under the root, never the full cwd', () => {
  assert.equal(projectLabel('/root/workspace/foo/bar', ROOTS), 'foo');
  assert.equal(projectLabel('/root/workspace/aurora-api', ROOTS), 'aurora-api');
});

test('projectLabel: outside every root -> last path segment only (no full path leak)', () => {
  assert.equal(projectLabel('/somewhere/else/proj', ROOTS), 'proj');
});

test('projectLabel: null cwd -> <unknown>', () => {
  assert.equal(projectLabel(null, ROOTS), '<unknown>');
});

test('projectLabel: /root/workspaceX is NOT under /root/workspace (path boundary)', () => {
  // 경계 없는 startsWith 매칭이면 'X' 가 나온다. 올바른 답은 마지막 세그먼트 'foo'.
  assert.equal(projectLabel('/root/workspaceX/foo', ROOTS), 'foo');
});

// ---- 2. abandonedHeadroom (완료 기준 5, 첫 질문) ----

test('abandonedHeadroom: mean of 40/50/60 is 50, abandoned 50', () => {
  const db = seededReadOnlyDb((w) => {
    insertSnapshot(w, '2026-07-01T00:00:00Z', { seven_day: { utilization: 40 } });
    insertSnapshot(w, '2026-07-02T00:00:00Z', { seven_day: { utilization: 50 } });
    insertSnapshot(w, '2026-07-03T00:00:00Z', { seven_day: { utilization: 60 } });
  });
  const r = abandonedHeadroom(db, at('2026-07-01T00:00:00Z'), at('2026-07-04T00:00:00Z'));
  assert.equal(r.samples, 3);
  assert.equal(r.meanUtilization, 50);
  assert.equal(r.abandonedPct, 50);
});

test('abandonedHeadroom: zero samples yields null, not 0 ("헤드룸 100% 버렸다"는 거짓말이다)', () => {
  const db = seededReadOnlyDb(() => {});
  const r = abandonedHeadroom(db, 0, at('2026-07-04T00:00:00Z'));
  assert.equal(r.samples, 0);
  assert.equal(r.meanUtilization, null);
  assert.equal(r.abandonedPct, null);
});

test('abandonedHeadroom: rows with NULL weekly_all_pct are excluded from the mean', () => {
  const db = seededReadOnlyDb((w) => {
    insertSnapshot(w, '2026-07-01T00:00:00Z', { seven_day: { utilization: 40 } });
    insertSnapshot(w, '2026-07-02T00:00:00Z', { five_hour: { utilization: 99 } }); // seven_day 없음
    insertSnapshot(w, '2026-07-03T00:00:00Z', { seven_day: { utilization: 60 } });
  });
  const r = abandonedHeadroom(db, at('2026-07-01T00:00:00Z'), at('2026-07-04T00:00:00Z'));
  assert.equal(r.samples, 2);
  assert.equal(r.meanUtilization, 50);
  assert.equal(r.abandonedPct, 50);
});

// ---- 3. scopeRanking (완료 기준 5, 둘째 질문) ----

// 실 응답 형태를 모사하되, limits[] 원소에는 percent 만 있다 (utilization 키를 넣지 않는다).
// 구현이 limits[] 안에서 utilization 을 읽으면 percent 가 전부 NULL 이 되어 이 테스트가 잡는다.
const LIMITS_RAW = {
  five_hour: { utilization: 28, resets_at: '2026-07-01T05:00:00Z' },
  seven_day: { utilization: 45, resets_at: '2026-07-03T00:00:00Z' },
  limits: [
    { kind: 'session', group: 'session', percent: 28, is_active: false, resets_at: '2026-07-01T05:00:00Z', scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 45, is_active: false, resets_at: '2026-07-03T00:00:00Z', scope: null },
    {
      kind: 'weekly_scoped', group: 'weekly', percent: 68, is_active: true,
      resets_at: '2026-07-03T00:00:00Z', scope: { model: { display_name: 'Fable', id: null }, surface: null },
    },
  ],
};

test('scopeRanking: limits[] of the latest snapshot, ordered by percent descending', () => {
  const db = seededReadOnlyDb((w) => {
    // 더 오래된 스냅샷 - 최신이 아니므로 무시되어야 한다.
    insertSnapshot(w, '2026-07-01T00:00:00Z', {
      limits: [{ kind: 'session', percent: 1, is_active: false, resets_at: null, scope: null }],
    });
    insertSnapshot(w, '2026-07-01T06:00:00Z', LIMITS_RAW);
    // atOrBeforeMs 이후의 스냅샷 - 미래이므로 무시되어야 한다.
    insertSnapshot(w, '2026-07-02T00:00:00Z', {
      limits: [{ kind: 'session', percent: 99, is_active: false, resets_at: null, scope: null }],
    });
  });

  const ranks = scopeRanking(db, at('2026-07-01T12:00:00Z'));

  assert.deepEqual(ranks, [
    { kind: 'weekly_scoped', percent: 68, isActive: true, resetsAt: '2026-07-03T00:00:00Z', scopeModel: 'Fable' },
    { kind: 'weekly_all', percent: 45, isActive: false, resetsAt: '2026-07-03T00:00:00Z', scopeModel: null },
    { kind: 'session', percent: 28, isActive: false, resetsAt: '2026-07-01T05:00:00Z', scopeModel: null },
  ]);
});

test('scopeRanking: reads percent, not utilization, inside limits[] (실측된 함정)', () => {
  const db = seededReadOnlyDb((w) => {
    insertSnapshot(w, '2026-07-01T06:00:00Z', LIMITS_RAW);
  });
  const ranks = scopeRanking(db, at('2026-07-01T12:00:00Z'));
  // 픽스처의 limits[] 에는 percent 만 있으므로, utilization 을 읽는 구현은 여기서 전부 null 이 된다.
  for (const r of ranks) {
    assert.notEqual(r.percent, null, `${r.kind} 의 percent 가 null - limits[] 에서 잘못된 필드를 읽었다`);
  }
});

test('scopeRanking: no snapshot at or before the cutoff -> empty array', () => {
  const db = seededReadOnlyDb((w) => {
    insertSnapshot(w, '2026-07-02T00:00:00Z', LIMITS_RAW); // 컷오프 이후뿐
  });
  assert.deepEqual(scopeRanking(db, at('2026-07-01T00:00:00Z')), []);
});

// ---- 4. 귀속 집계 ----

const JULY = [at('2026-07-01T00:00:00Z'), at('2026-07-02T00:00:00Z')] as const;

test('attributionByModel: each model is priced at its own rate (손계산)', () => {
  const db = seededReadOnlyDb((w) => {
    insertEvent(w, { model: 'claude-opus-4-8', input_tokens: 1_000_000 });  // $5/MTok input -> 5
    insertEvent(w, { model: 'claude-haiku-4-5', input_tokens: 1_000_000 }); // $1/MTok input -> 1
  });
  const rows = attributionByModel(db, ...JULY);
  assert.equal(rows.length, 2);
  const opus = rows.find((r) => r.model === 'claude-opus-4-8')!;
  const haiku = rows.find((r) => r.model === 'claude-haiku-4-5')!;
  assert.equal(opus.events, 1);
  assert.equal(opus.inputTokens, 1_000_000);
  assert.equal(opus.apiEquivalentUsd, 5);
  assert.equal(haiku.apiEquivalentUsd, 1);
});

test('attributionByModel: events in different price periods are priced at the rate in effect then', () => {
  // 시점 버전 (핵심). claude-sonnet-5 도입가(~2026-08-31) input $2, 표준가(2026-09-01~) input $3.
  // 현재가 소급 계산이면 3+3=6 이 나와 실패한다. 옳은 답은 2+3=5.
  const db = seededReadOnlyDb((w) => {
    insertEvent(w, { model: 'claude-sonnet-5', captured_at: at('2026-07-01T00:00:00Z'), input_tokens: 1_000_000 });
    insertEvent(w, { model: 'claude-sonnet-5', captured_at: at('2026-09-15T00:00:00Z'), input_tokens: 1_000_000 });
  });
  const rows = attributionByModel(db, at('2026-06-01T00:00:00Z'), at('2026-10-01T00:00:00Z'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].events, 2);
  assert.equal(rows[0].apiEquivalentUsd, 5);
});

test('one unpriced event (unknown model, tokens > 0) makes the whole group null - no partial sums', () => {
  const db = seededReadOnlyDb((w) => {
    const cwd = '/root/workspace/aurora-api';
    insertEvent(w, { cwd, model: 'claude-opus-4-8', input_tokens: 1_000_000 });
    insertEvent(w, { cwd, model: 'claude-unknown-9', input_tokens: 1_000 }); // 단가 미상
    insertEvent(w, { cwd: '/root/workspace/widget-shop', model: 'claude-haiku-4-5', input_tokens: 1_000_000 });
  });
  const rows = attributionByProject(db, ...JULY, ROOTS);
  const poisoned = rows.find((r) => r.project === 'aurora-api')!;
  const clean = rows.find((r) => r.project === 'widget-shop')!;
  assert.equal(poisoned.apiEquivalentUsd, null);      // 부분합 5 가 아니다
  assert.equal(poisoned.inputTokens, 1_001_000);      // 토큰 합은 그대로 (모른다 != 없다)
  assert.equal(clean.apiEquivalentUsd, 1);            // 오염은 그룹 단위다
});

test('attributionByProject: splits by project, counts sidechain events separately without excluding them', () => {
  const db = seededReadOnlyDb((w) => {
    insertEvent(w, { cwd: '/root/workspace/aurora-api/sub', input_tokens: 100, output_tokens: 10 });
    insertEvent(w, { cwd: '/root/workspace/aurora-api', input_tokens: 200, output_tokens: 20, is_sidechain: 1 });
    insertEvent(w, { cwd: '/root/workspace/widget-shop', input_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 3, cache_creation_5m_tokens: 3 });
  });
  const rows = attributionByProject(db, ...JULY, ROOTS);
  assert.equal(rows.length, 2);

  const aurora = rows.find((r) => r.project === 'aurora-api')!;
  assert.equal(aurora.events, 2);            // 사이드체인 포함
  assert.equal(aurora.sidechainEvents, 1);   // 따로 센다
  assert.equal(aurora.inputTokens, 300);
  assert.equal(aurora.outputTokens, 30);

  const widget = rows.find((r) => r.project === 'widget-shop')!;
  assert.equal(widget.events, 1);
  assert.equal(widget.sidechainEvents, 0);
  assert.equal(widget.cacheReadTokens, 5);
  assert.equal(widget.cacheCreationTokens, 3);
});

test('hourlyUsage: splits by UTC hour; billable = input + output + cache_creation, cache_read excluded', () => {
  // billable 정의 (002 I7, 읽기 측 소유) 를 함수로도 직접 단언한다.
  assert.equal(billableTokens({ inputTokens: 10, outputTokens: 20, cacheCreationTokens: 30 }), 60);

  const db = seededReadOnlyDb((w) => {
    insertEvent(w, { captured_at: at('2026-07-01T05:15:00Z'), input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 999 });
    insertEvent(w, { captured_at: at('2026-07-01T05:45:00Z'), input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3 });
    insertEvent(w, { captured_at: at('2026-07-01T23:10:00Z'), input_tokens: 100 });
  });
  const rows = hourlyUsage(db, ...JULY);
  assert.deepEqual(rows, [
    { hourUtc: 5, events: 2, billableTokens: 66 },   // (10+20+30) + (1+2+3). cache_read 999 는 제외
    { hourUtc: 23, events: 1, billableTokens: 100 },
  ]);
});

// ---- 5. collectionGaps (대시보드가 거짓말하지 않게) ----

test('collectionGaps: ok=98, error=1, http_error=1, auth_skip=90 -> gapPct=2, authSkip=90', () => {
  const base = at('2026-07-01T00:00:00Z');
  const db = seededReadOnlyDb((w) => {
    let t = base;
    for (let i = 0; i < 98; i++) insertRun(w, 'ok', t++);
    insertRun(w, 'error', t++);
    insertRun(w, 'http_error', t++);
    for (let i = 0; i < 90; i++) insertRun(w, 'auth_skip', t++);
    insertRun(w, 'error', t++, 'archive');            // kind != snapshot 은 제외
    insertRun(w, 'error', at('2026-08-01T00:00:00Z')); // 구간 밖은 제외
  });
  const r = collectionGaps(db, base, at('2026-07-02T00:00:00Z'));
  assert.equal(r.ok, 98);
  assert.equal(r.failed, 2);
  assert.equal(r.authSkip, 90); // 결손율 분모에서 빠지지만 반드시 함께 노출한다
  assert.equal(r.gapPct, 2);
});

test('collectionGaps: all auth_skip -> gapPct=0 without dividing by zero, authSkip intact', () => {
  const base = at('2026-07-01T00:00:00Z');
  const db = seededReadOnlyDb((w) => {
    for (let i = 0; i < 5; i++) insertRun(w, 'auth_skip', base + i);
  });
  const r = collectionGaps(db, base, at('2026-07-02T00:00:00Z'));
  assert.equal(r.ok, 0);
  assert.equal(r.failed, 0);
  assert.equal(r.authSkip, 5);
  assert.equal(r.gapPct, 0);
});
