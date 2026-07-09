// M1+M2 수집기 테스트. 실 API 호출 없음 - fetch는 전부 가짜 주입.
// 픽스처는 fixtures/usage-response.json (합성, 실 응답 아님).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, migrate } from './db.ts';
import { runOnce } from './run-once.ts';

const FIXTURE = readFileSync(new URL('../fixtures/usage-response.json', import.meta.url), 'utf8');
const FAKE_TOKEN = 'FAKE-TOKEN-zz00Qq11Ww22Ee33Rr44Tt55Yy66Uu77Ii88Oo99Pp';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'claude-monitor-test-'));
}

function tmpDb(): DatabaseSync {
  return openDb(join(tmpDir(), 'test.sqlite'));
}

function writeCreds(dir: string, expiresAt: number): string {
  const p = join(dir, '.credentials.json');
  writeFileSync(p, JSON.stringify({
    claudeAiOauth: {
      accessToken: FAKE_TOKEN,
      refreshToken: 'FAKE-REFRESH-do-not-touch',
      expiresAt,
      refreshTokenExpiresAt: expiresAt + 86_400_000,
    },
  }));
  return p;
}

// 공통 셋업: 빈 DB + 자격증명 파일 경로. 기본은 1시간 뒤 만료(유효).
function setup(expiresAt: number = Date.now() + 3_600_000): { db: DatabaseSync; creds: string } {
  return { db: tmpDb(), creds: writeCreds(tmpDir(), expiresAt) };
}

// 가짜 fetch: 호출 기록을 남기고 매 호출 새 Response를 만든다.
function fakeFetch(body: string, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status });
  };
  return { fn, calls };
}

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

// 1. 스키마 드리프트: 모르는 키가 있어도 적재 성공 + raw_json에 그대로 보존
test('unknown fields survive load and round-trip via raw_json', async () => {
  const { db, creds } = setup();
  const payload = JSON.parse(FIXTURE);
  payload['완전히_새로운_필드'] = { nested: [1, 2, 3] };
  const { fn } = fakeFetch(JSON.stringify(payload));

  await runOnce({ db, fetchFn: fn, credentialsPath: creds });

  assert.equal(countRows(db, 'snapshot'), 1);
  const row = db.prepare('SELECT raw_json, five_hour_pct FROM snapshot').get() as {
    raw_json: string; five_hour_pct: number;
  };
  const back = JSON.parse(row.raw_json);
  assert.equal(back.tangelo, null);
  assert.equal(back.iguana_necktie, null);
  assert.deepEqual(back['완전히_새로운_필드'], { nested: [1, 2, 3] });
  assert.equal(row.five_hour_pct, 21.0);
});

// 2. 파싱 실패가 적재 실패가 아니다: five_hour 부재 → 적재 성공, gencol NULL
test('missing five_hour loads fine and derives NULL', async () => {
  const { db, creds } = setup();
  const { fn } = fakeFetch('{"seven_day":{"utilization":41.0}}');

  await runOnce({ db, fetchFn: fn, credentialsPath: creds });

  const row = db.prepare('SELECT five_hour_pct, weekly_all_pct FROM snapshot').get() as {
    five_hour_pct: number | null; weekly_all_pct: number | null;
  };
  assert.equal(row.five_hour_pct, null);
  assert.equal(row.weekly_all_pct, 41.0);
});

// 3. verbatim 보존: 키 순서/공백이 특이해도 raw_json이 바이트 단위 동일
test('raw_json is byte-for-byte verbatim', async () => {
  const { db, creds } = setup();
  const weird = '{  "seven_day" : {"utilization": 41.0} ,\n\t"five_hour":{"utilization":21}   }';
  const { fn } = fakeFetch(weird);

  await runOnce({ db, fetchFn: fn, credentialsPath: creds });

  const row = db.prepare('SELECT raw_json FROM snapshot').get() as { raw_json: string };
  assert.equal(row.raw_json, weird);
});

// 4. 6회 호출 → snapshot 6행, collector_run 6행
test('six runs produce six snapshot rows and six run rows', async () => {
  const { db, creds } = setup();
  const { fn } = fakeFetch(FIXTURE);

  for (let i = 0; i < 6; i++) {
    await runOnce({ db, fetchFn: fn, credentialsPath: creds });
  }

  assert.equal(countRows(db, 'snapshot'), 6);
  assert.equal(countRows(db, 'collector_run'), 6);
  const statuses = db.prepare('SELECT DISTINCT status FROM collector_run').all() as Array<{ status: string }>;
  // node:sqlite 행은 null prototype이라 spread로 평범한 객체로 만들어 비교한다.
  assert.deepEqual(statuses.map((r) => ({ ...r })), [{ status: 'ok' }]);
});

// 5. auth_skip: expiresAt 과거 → fetch 0회, auth_skip 1행, snapshot 0행
test('expired token skips HTTP entirely and records auth_skip', async () => {
  const { db, creds } = setup(Date.now() - 1000);
  const { fn, calls } = fakeFetch(FIXTURE);

  await runOnce({ db, fetchFn: fn, credentialsPath: creds });

  assert.equal(calls.length, 0);
  assert.equal(countRows(db, 'snapshot'), 0);
  const runs = db.prepare('SELECT status FROM collector_run').all() as Array<{ status: string }>;
  assert.deepEqual(runs.map((r) => ({ ...r })), [{ status: 'auth_skip' }]);
});

// 5a. 자격증명 스키마 드리프트: expiresAt/accessToken 이 성하지 않으면 만료로 본다.
// 실패해도 안전한 쪽(HTTP 안 부름)으로 실패해야 한다. `Bearer undefined` 를 보내면 안 된다.
test('malformed credentials fail safe to auth_skip, never call HTTP', async () => {
  const bad = [
    { claudeAiOauth: { accessToken: FAKE_TOKEN } },                       // expiresAt 없음
    { claudeAiOauth: { accessToken: FAKE_TOKEN, expiresAt: null } },
    { claudeAiOauth: { accessToken: FAKE_TOKEN, expiresAt: 'soon' } },
    { claudeAiOauth: { expiresAt: Date.now() + 3_600_000 } },             // accessToken 없음
    { claudeAiOauth: {} },
    {},                                                                    // claudeAiOauth 없음
  ];

  for (const [i, cred] of bad.entries()) {
    const db = tmpDb();
    const path = join(tmpDir(), `c${i}.json`);
    writeFileSync(path, JSON.stringify(cred));
    const { fn, calls } = fakeFetch(FIXTURE);

    await runOnce({ db, fetchFn: fn, credentialsPath: path });

    assert.equal(calls.length, 0, `case ${i}: HTTP 를 불렀다`);
    assert.equal(countRows(db, 'snapshot'), 0, `case ${i}`);
    const run = db.prepare('SELECT status FROM collector_run').get() as { status: string };
    assert.equal(run.status, 'auth_skip', `case ${i}`);
  }
});

// 5b. auth_skip: 자격증명 파일 부재도 동일
test('missing credentials file records auth_skip without HTTP', async () => {
  const db = tmpDb();
  const { fn, calls } = fakeFetch(FIXTURE);

  await runOnce({ db, fetchFn: fn, credentialsPath: join(tmpDir(), 'nope.json') });

  assert.equal(calls.length, 0);
  assert.equal(countRows(db, 'snapshot'), 0);
  const run = db.prepare('SELECT status FROM collector_run').get() as { status: string };
  assert.equal(run.status, 'auth_skip');
});

// 6. 자격증명 파일 불변: runOnce 전후 sha256 동일
test('credentials file is never modified', async () => {
  const { db, creds } = setup();
  const before = createHash('sha256').update(readFileSync(creds)).digest('hex');
  const { fn } = fakeFetch(FIXTURE);

  await runOnce({ db, fetchFn: fn, credentialsPath: creds });

  const after = createHash('sha256').update(readFileSync(creds)).digest('hex');
  assert.equal(before, after);
});

// 7. 토큰 누출 0: stdout/stderr 전부 + collector_run.note 전부에 토큰 부재
test('token never appears in stdout, stderr, or collector_run.note', async () => {
  const db = tmpDb();
  const dir = tmpDir();
  const outputs: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (chunk: unknown) => {
    outputs.push(String(chunk));
    return origOut(chunk as string);
  };
  (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (chunk: unknown) => {
    outputs.push(String(chunk));
    return origErr(chunk as string);
  };
  try {
    // 네 경로 전부 통과시킨다: ok / auth_skip / http_error / error
    const fresh = writeCreds(dir, Date.now() + 3_600_000);
    await runOnce({ db, fetchFn: fakeFetch(FIXTURE).fn, credentialsPath: fresh });
    await runOnce({ db, fetchFn: fakeFetch('denied', 401).fn, credentialsPath: fresh });
    const throwing: typeof fetch = async () => { throw new Error('network down'); };
    await runOnce({ db, fetchFn: throwing, credentialsPath: fresh });
    const expired = writeCreds(dir, Date.now() - 1000);
    await runOnce({ db, fetchFn: fakeFetch(FIXTURE).fn, credentialsPath: expired });
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }

  const notes = db.prepare("SELECT group_concat(coalesce(note,'')) AS s FROM collector_run").get() as { s: string | null };
  const combined = outputs.join('') + (notes.s ?? '');
  assert.equal(combined.includes(FAKE_TOKEN), false);
  assert.equal(combined.includes('FAKE-REFRESH-do-not-touch'), false);
  assert.equal(countRows(db, 'collector_run'), 4);
});

// 8. http_error: 401/500 → snapshot 0행, status/http_status 기록, 예외 없음
test('non-200 responses record http_error and never throw', async () => {
  const { db, creds } = setup();

  await runOnce({ db, fetchFn: fakeFetch('denied', 401).fn, credentialsPath: creds });
  await runOnce({ db, fetchFn: fakeFetch('boom', 500).fn, credentialsPath: creds });

  assert.equal(countRows(db, 'snapshot'), 0);
  const runs = db.prepare('SELECT status, http_status FROM collector_run ORDER BY id').all() as
    Array<{ status: string; http_status: number }>;
  assert.deepEqual(runs.map((r) => ({ ...r })), [
    { status: 'http_error', http_status: 401 },
    { status: 'http_error', http_status: 500 },
  ]);
});

// 9. WAL 모드
test('database runs in WAL journal mode', () => {
  const db = tmpDb();
  const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
  assert.equal(row.journal_mode, 'wal');
});

// 10. limits[] 는 json_each로 kind 기반 조회 (배열 인덱스 비의존)
test('limits[] is queryable via json_each by kind', async () => {
  const { db, creds } = setup();
  await runOnce({ db, fetchFn: fakeFetch(FIXTURE).fn, credentialsPath: creds });

  // 소진율 필드는 `percent` 다. limits[] 안에서 `utilization` 을 꺼내면 조용히 NULL 이 나온다.
  const row = db.prepare(`
    SELECT json_extract(je.value, '$.percent') AS percent,
           json_extract(je.value, '$.utilization') AS wrong_field,
           json_extract(je.value, '$.scope.model.display_name') AS scope_model
    FROM snapshot, json_each(snapshot.raw_json, '$.limits') AS je
    WHERE json_extract(je.value, '$.kind') = 'weekly_scoped'
  `).get() as { percent: number; wrong_field: unknown; scope_model: string };
  assert.equal(row.percent, 67);
  assert.equal(row.wrong_field, null);
  assert.equal(row.scope_model, 'Fable');
});

// 11. ALTER TABLE ADD COLUMN ... VIRTUAL 이 성공 (장래 드리프트 대응 경로)
test('ALTER TABLE can add a VIRTUAL generated column', () => {
  const db = tmpDb();
  db.exec(`
    ALTER TABLE snapshot ADD COLUMN spend_enabled INTEGER
      GENERATED ALWAYS AS (json_extract(raw_json, '$.spend.enabled')) VIRTUAL
  `);
  db.prepare('INSERT INTO snapshot (captured_at, raw_json) VALUES (?, ?)').run(1, '{"spend":{"enabled":false}}');
  const row = db.prepare('SELECT spend_enabled FROM snapshot').get() as { spend_enabled: number };
  assert.equal(row.spend_enabled, 0);
});

// 12. 멱등 마이그레이션: migrate 2회 호출해도 실패하지 않는다
test('migrate is idempotent', () => {
  const db = tmpDb(); // openDb가 이미 1회 migrate
  migrate(db);
  migrate(db);
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.equal(row.user_version, 3); // M5에서 usage_event/parsed_archive 추가로 v3
});
