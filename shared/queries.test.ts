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
  resetEvents,
  currentCapacity,
  gaugeConsumptionByHour,
  attributionByProject,
  attributionByModel,
  hourlyUsage,
  collectionGaps,
  billableTokens,
  headroomSeries,
  latestCapturedAt,
  collectorRunDaily,
  latestRunAt,
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

// Windows 트랜스크립트의 cwd 는 `C:\Users\<user>\...` 형태다. `/` 로만 자르면 경로 전체가
// 라벨이 되어 사용자명이 화면·리포트·스크린샷에 그대로 나간다 (실 DB 에서 18건 관측).
test('projectLabel: windows paths do not leak as labels', () => {
  assert.equal(projectLabel('C:\\Users\\alice\\dev\\widget', ROOTS), 'widget');
  assert.equal(projectLabel('C:\\Users\\alice', ROOTS), 'alice');
  assert.equal(projectLabel('D:\\work\\proj\\', ROOTS), 'proj');
});

test('projectLabel: no label ever contains a separator or a drive letter', () => {
  const inputs = [
    '/root/workspace/foo', '/root/.config/anthropic', '/root',
    'C:\\Users\\alice\\dev\\widget', 'D:\\x', '/a/b/c', null,
  ];
  for (const cwd of inputs) {
    const label = projectLabel(cwd, ROOTS);
    assert.equal(/[\\/]/.test(label), false, `${cwd} -> ${label} 에 구분자가 있다`);
    assert.equal(/^[A-Za-z]:/.test(label), false, `${cwd} -> ${label} 이 드라이브 문자로 시작한다`);
  }
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

// ---- 3b. resetEvents (완료 기준 2) ----

function rawWithLimits(limits: Array<{ kind: string; percent: number; resets_at: string | null }>): unknown {
  return { five_hour: { utilization: 0 }, seven_day: { utilization: 0 }, limits };
}

test('resetEvents: a drop at the predicted resets_at is flagged predicted', () => {
  const reset = '2026-07-10T13:00:00Z';
  const db = seededReadOnlyDb((w) => {
    insertSnapshot(w, '2026-07-10T12:55:00Z', rawWithLimits([{ kind: 'weekly_all', percent: 8, resets_at: reset }]));
    insertSnapshot(w, '2026-07-10T13:00:00Z', rawWithLimits([{ kind: 'weekly_all', percent: 0, resets_at: null }]));
  });
  const ev = resetEvents(db, 0, Date.parse('2026-07-11T00:00:00Z'));
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.kind, 'weekly_all');
  assert.equal(ev[0]!.predicted, true);
  assert.equal(ev[0]!.fromPct, 8);
  assert.equal(ev[0]!.toPct, 0);
});

// 실측 반례: 2026-07-09 18:00 에 예고 없이 전면 리셋이 일어났다. 이걸 predicted 로 잘못 표시하면
// 대시보드가 "resets_at 이 항상 맞다"고 거짓말한다.
test('resetEvents: a drop with no matching resets_at is flagged NOT predicted', () => {
  const db = seededReadOnlyDb((w) => {
    insertSnapshot(w, '2026-07-09T17:55:00Z', rawWithLimits([{ kind: 'weekly_all', percent: 49, resets_at: '2026-07-11T13:00:00Z' }]));
    insertSnapshot(w, '2026-07-09T18:00:00Z', rawWithLimits([{ kind: 'weekly_all', percent: 0, resets_at: null }]));
  });
  const ev = resetEvents(db, 0, Date.parse('2026-07-10T00:00:00Z'));
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.predicted, false);
});

test('resetEvents: a small dip below the threshold is not a reset', () => {
  const db = seededReadOnlyDb((w) => {
    insertSnapshot(w, '2026-07-10T12:00:00Z', rawWithLimits([{ kind: 'weekly_all', percent: 50, resets_at: null }]));
    insertSnapshot(w, '2026-07-10T12:05:00Z', rawWithLimits([{ kind: 'weekly_all', percent: 48, resets_at: null }]));
  });
  assert.equal(resetEvents(db, 0, Date.parse('2026-07-11T00:00:00Z'), 5).length, 0);
});

test('resetEvents: each scope is tracked independently', () => {
  const r = '2026-07-10T13:00:00Z';
  const db = seededReadOnlyDb((w) => {
    insertSnapshot(w, '2026-07-10T12:55:00Z', rawWithLimits([
      { kind: 'session', percent: 75, resets_at: r },
      { kind: 'weekly_all', percent: 8, resets_at: r },
    ]));
    insertSnapshot(w, '2026-07-10T13:00:00Z', rawWithLimits([
      { kind: 'session', percent: 0, resets_at: null },
      { kind: 'weekly_all', percent: 8, resets_at: r },
    ]));
  });
  const ev = resetEvents(db, 0, Date.parse('2026-07-11T00:00:00Z'));
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.kind, 'session');
});

// ---- 3c. currentCapacity / gaugeConsumptionByHour (관측 강화 A) ----

test('currentCapacity: latest snapshot limits with minutes-to-reset from the anchor', () => {
  const anchor = Date.parse('2026-07-13T00:00:00Z');
  const db = seededReadOnlyDb((w) => {
    insertSnapshot(w, '2026-07-12T23:55:00Z', {
      five_hour: { utilization: 0 }, seven_day: { utilization: 0 },
      limits: [
        { kind: 'session', percent: 14, is_active: true, resets_at: '2026-07-13T00:30:00Z', scope: null },
        { kind: 'weekly_all', percent: 4, is_active: false, resets_at: '2026-07-17T13:00:00Z', scope: null },
        { kind: 'weekly_scoped', percent: 3, is_active: false, resets_at: '2026-07-17T13:00:00Z', scope: { model: { display_name: 'Fable' } } },
      ],
    });
  });
  const cap = currentCapacity(db, anchor);
  assert.equal(cap.length, 3);
  const session = cap.find((c) => c.kind === 'session')!;
  assert.equal(session.percent, 14);
  assert.equal(session.isActive, true);
  assert.equal(session.minutesToReset, 30); // 00:00 -> 00:30
  assert.equal(cap.find((c) => c.kind === 'weekly_scoped')!.scopeModel, 'Fable');
});

test('currentCapacity: a reset already in the past yields null minutes, not negative', () => {
  const anchor = Date.parse('2026-07-13T00:00:00Z');
  const db = seededReadOnlyDb((w) => {
    insertSnapshot(w, '2026-07-12T23:55:00Z', {
      limits: [{ kind: 'session', percent: 0, is_active: true, resets_at: '2026-07-12T20:00:00Z', scope: null }],
    });
  });
  assert.equal(currentCapacity(db, anchor)[0]!.minutesToReset, null);
});

test('currentCapacity: empty db -> empty array', () => {
  const db = seededReadOnlyDb(() => {});
  assert.deepEqual(currentCapacity(db, Date.now()), []);
});

// 게이지 상승분이 권위 있는 소비 신호다. 리셋(음의 델타)은 소비가 아니다.
test('gaugeConsumptionByHour: sums positive deltas, ignores resets', () => {
  const db = seededReadOnlyDb((w) => {
    const at = (iso: string, pct: number) => insertSnapshot(w, iso, { limits: [{ kind: 'session', percent: pct, is_active: true, resets_at: null, scope: null }] });
    at('2026-07-12T05:00:00Z', 10); // 05시 UTC 기준점
    at('2026-07-12T05:30:00Z', 30); // +20 소비 -> 05시
    at('2026-07-12T06:00:00Z', 50); // +20 소비 -> 06시
    at('2026-07-12T06:30:00Z', 0);  // 리셋(-50) -> 소비 아님, 06시 표본만
  });
  const h = gaugeConsumptionByHour(db, 0, Date.parse('2026-07-13T00:00:00Z'));
  assert.equal(h[5]!.consumption, 20);
  assert.equal(h[6]!.consumption, 20); // 리셋 델타는 안 더해짐
  assert.equal(h.reduce((s, x) => s + x.consumption, 0), 40);
});

test('gaugeConsumptionByHour: a NULL gap breaks continuity (no phantom delta)', () => {
  const db = seededReadOnlyDb((w) => {
    insertSnapshot(w, '2026-07-12T05:00:00Z', { limits: [{ kind: 'session', percent: 60, is_active: true, resets_at: null, scope: null }] });
    // session 이 없는 스냅샷 (응답 구멍) - 연속성이 끊겨야 한다
    insertSnapshot(w, '2026-07-12T05:30:00Z', { limits: [] });
    insertSnapshot(w, '2026-07-12T06:00:00Z', { limits: [{ kind: 'session', percent: 10, is_active: true, resets_at: null, scope: null }] });
  });
  // 60 -> (구멍) -> 10 이 -50 이나 +? 로 이어지면 안 된다. 총 소비 0.
  assert.equal(gaugeConsumptionByHour(db, 0, Date.parse('2026-07-13T00:00:00Z')).reduce((s, x) => s + x.consumption, 0), 0);
});

test('gaugeConsumptionByHour: tracks the requested scope, not just session', () => {
  const db = seededReadOnlyDb((w) => {
    const at = (iso: string, s: number, wa: number) => insertSnapshot(w, iso, { limits: [
      { kind: 'session', percent: s, is_active: true, resets_at: null, scope: null },
      { kind: 'weekly_all', percent: wa, is_active: false, resets_at: null, scope: null },
    ] });
    at('2026-07-12T05:00:00Z', 10, 2);
    at('2026-07-12T05:30:00Z', 40, 5); // session +30, weekly_all +3
  });
  assert.equal(gaugeConsumptionByHour(db, 0, Date.parse('2026-07-13T00:00:00Z'), 'weekly_all')[5]!.consumption, 3);
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

// ---- 8. headroomSeries (M10 시계열 - 리셋 톱니의 원자료) ----

test('headroomSeries: in-range rows in time order, NULL weekly_all_pct rows dropped', () => {
  const db = seededReadOnlyDb((w) => {
    insertSnapshot(w, '2026-07-01T10:00:00Z', {
      seven_day: { utilization: 40, resets_at: '2026-07-03T00:00:00Z' },
    });
    insertSnapshot(w, '2026-07-01T09:00:00Z', {
      seven_day: { utilization: 38, resets_at: '2026-07-03T00:00:00Z' },
    });
    insertSnapshot(w, '2026-07-01T09:30:00Z', {}); // seven_day 없음 -> 파생 NULL -> 제외
    insertSnapshot(w, '2026-06-01T00:00:00Z', { seven_day: { utilization: 99 } }); // 구간 밖
  });
  const rows = headroomSeries(db, at('2026-07-01T00:00:00Z'), at('2026-07-02T00:00:00Z'));
  assert.deepEqual(rows, [
    { t: at('2026-07-01T09:00:00Z'), weeklyAllPct: 38, weeklyReset: '2026-07-03T00:00:00Z' },
    { t: at('2026-07-01T10:00:00Z'), weeklyAllPct: 40, weeklyReset: '2026-07-03T00:00:00Z' },
  ]);
});

test('headroomSeries: empty range -> empty array', () => {
  const db = seededReadOnlyDb(() => {});
  assert.deepEqual(headroomSeries(db, 0, at('2026-07-02T00:00:00Z')), []);
});

// ---- 9. latestCapturedAt (대시보드 앵커 - 데모/라이브 공용, 벽시계를 읽지 않는다) ----

test('latestCapturedAt: max snapshot captured_at; null when table is empty', () => {
  const db = seededReadOnlyDb((w) => {
    insertSnapshot(w, '2026-07-01T10:00:00Z', {});
    insertSnapshot(w, '2026-07-02T10:00:00Z', {});
  });
  assert.equal(latestCapturedAt(db), at('2026-07-02T10:00:00Z'));
  const empty = seededReadOnlyDb(() => {});
  assert.equal(latestCapturedAt(empty), null);
});

// ---- 10. collectorRunDaily / latestRunAt (수집 상태 탭 - auth_skip 을 감추지 않는다) ----

test('collectorRunDaily: UTC 일 단위로 ok/failed/auth_skip 을 센다. snapshot 외 kind 와 구간 밖은 제외', () => {
  const db = seededReadOnlyDb((w) => {
    // 7/01: ok 2, http_error 1, auth_skip 1
    insertRun(w, 'ok', at('2026-07-01T01:00:00Z'));
    insertRun(w, 'ok', at('2026-07-01T02:00:00Z'));
    insertRun(w, 'http_error', at('2026-07-01T03:00:00Z'));
    insertRun(w, 'auth_skip', at('2026-07-01T04:00:00Z'));
    // 7/02: error 1 (failed 로 합산), ok 1
    insertRun(w, 'error', at('2026-07-02T01:00:00Z'));
    insertRun(w, 'ok', at('2026-07-02T02:00:00Z'));
    // 제외 대상: snapshot 이 아닌 kind, 구간 밖
    insertRun(w, 'ok', at('2026-07-01T05:00:00Z'), 'prune');
    insertRun(w, 'ok', at('2026-06-30T23:59:59Z'));
  });
  const rows = collectorRunDaily(db, at('2026-07-01T00:00:00Z'), at('2026-07-03T00:00:00Z'));
  assert.deepEqual(rows, [
    { dayUtc: '2026-07-01', ok: 2, failed: 1, authSkip: 1 },
    { dayUtc: '2026-07-02', ok: 1, failed: 1, authSkip: 0 },
  ]);
});

test('collectorRunDaily: empty range -> empty array', () => {
  const db = seededReadOnlyDb(() => {});
  assert.deepEqual(collectorRunDaily(db, 0, at('2026-07-03T00:00:00Z')), []);
});

test('latestRunAt: 마지막 snapshot run 발화 시각 (heartbeat). auth_skip 도 발화다. 빈 테이블은 null', () => {
  const db = seededReadOnlyDb((w) => {
    insertRun(w, 'ok', at('2026-07-01T01:00:00Z'));
    insertRun(w, 'auth_skip', at('2026-07-01T02:00:00Z'));
    insertRun(w, 'ok', at('2026-07-09T00:00:00Z'), 'prune'); // snapshot 이 아닌 kind 는 heartbeat 가 아니다
  });
  assert.equal(latestRunAt(db), at('2026-07-01T02:00:00Z'));
  const empty = seededReadOnlyDb(() => {});
  assert.equal(latestRunAt(empty), null);
});
