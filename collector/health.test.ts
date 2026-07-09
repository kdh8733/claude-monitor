// M4 관측 로직 테스트. 결손율 정의(ROADMAP 완료 기준 1)가 핵심이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import { health, formatHealth } from './health.ts';

const HOUR = 3_600_000;
const DEFAULTS = { now: 1_000 * HOUR, maxGapPct: 1, maxHeartbeatAgeMs: 2 * HOUR };

function dbWith(statuses: string[]): DatabaseSync {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'claude-monitor-h-')), 'test.sqlite'));
  const ins = db.prepare(
    `INSERT INTO collector_run (started_at, kind, status) VALUES (?, 'snapshot', ?)`,
  );
  statuses.forEach((s, i) => ins.run(i, s));
  return db;
}

test('auth_skip is excluded from both numerator and denominator', () => {
  // 성공 10, 실패 0, auth_skip 90. 밤새 토큰이 만료된 상황.
  const db = dbWith([...Array(10).fill('ok'), ...Array(90).fill('auth_skip')]);
  const h = health({ db, heartbeatMtimeMs: DEFAULTS.now - 60_000, ...DEFAULTS });

  assert.equal(h.gapPct, 0, 'auth_skip 이 결손율을 오염시켰다');
  assert.equal(h.authSkip, 90, 'auth_skip 을 보고에서 빠뜨렸다');
  assert.equal(h.healthy, true);
});

test('http_error and error both count as gap', () => {
  const db = dbWith([...Array(98).fill('ok'), 'error', 'http_error']);
  const h = health({ db, heartbeatMtimeMs: DEFAULTS.now - 60_000, ...DEFAULTS });

  assert.equal(h.failed, 2);
  assert.equal(h.gapPct, 2);
  assert.equal(h.healthy, false, '결손율 2% 는 기준(1%) 초과다');
});

test('gap exactly at the threshold is healthy', () => {
  const db = dbWith([...Array(99).fill('ok'), 'error']);
  const h = health({ db, heartbeatMtimeMs: DEFAULTS.now - 60_000, ...DEFAULTS });
  assert.equal(h.gapPct, 1);
  assert.equal(h.healthy, true);
});

test('stale heartbeat is unhealthy even with a perfect gap', () => {
  const db = dbWith(Array(100).fill('ok'));
  const h = health({ db, heartbeatMtimeMs: DEFAULTS.now - 3 * HOUR, ...DEFAULTS });
  assert.equal(h.gapPct, 0);
  assert.equal(h.healthy, false, '수집기가 3시간째 죽어 있는데 healthy 라고 했다');
});

test('missing heartbeat is unhealthy', () => {
  const db = dbWith(Array(100).fill('ok'));
  const h = health({ db, heartbeatMtimeMs: null, ...DEFAULTS });
  assert.equal(h.heartbeatAgeMs, null);
  assert.equal(h.healthy, false);
});

test('empty database does not divide by zero', () => {
  const db = dbWith([]);
  const h = health({ db, heartbeatMtimeMs: DEFAULTS.now, ...DEFAULTS });
  assert.equal(h.gapPct, 0);
  assert.equal(h.ok, 0);
});

test('transcript runs do not affect the snapshot gap', () => {
  const db = dbWith(Array(10).fill('ok'));
  db.prepare(`INSERT INTO collector_run (started_at, kind, status) VALUES (99, 'transcript', 'error')`).run();
  const h = health({ db, heartbeatMtimeMs: DEFAULTS.now, ...DEFAULTS });
  assert.equal(h.failed, 0, '아카이브 실패가 스냅샷 결손율에 섞였다');
});

test('format names the auth_skip hole instead of hiding it', () => {
  const db = dbWith([...Array(10).fill('ok'), ...Array(90).fill('auth_skip')]);
  const line = formatHealth(health({ db, heartbeatMtimeMs: DEFAULTS.now, ...DEFAULTS }));
  assert.match(line, /auth_skip=90/);
  assert.match(line, /gap=0\.00%/);
});
