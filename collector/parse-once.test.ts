// M5 트랜스크립트 파서 테스트. 실 트랜스크립트/실 아카이브를 읽지 않는다 - 전부 합성 gz 픽스처.
// 핵심 계약: usage_event grain = message.id, 종단(=최대 output) usage 승리 (004 C2, 전수 실측).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { openDb, migrate } from './db.ts';
import { parseOnce } from './parse-once.ts';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'claude-monitor-m5-'));
}

function setup() {
  const db = openDb(join(tmpDir(), 'test.sqlite'));
  const archiveRoot = join(tmpDir(), 'archive');
  mkdirSync(archiveRoot, { recursive: true });
  return { db, archiveRoot };
}

// 합성 usage 라인. 실측된 필드 위치를 그대로 모사한다 (usage 안에 speed가 있다).
// override.usage 의 undefined 값은 JSON.stringify가 떨어뜨린다 - 필드 부재 모사에 쓴다.
function usageLine(
  id: string,
  output: number,
  override: { usage?: Record<string, unknown>; line?: Record<string, unknown> } = {},
): string {
  return JSON.stringify({
    timestamp: '2026-07-01T00:00:00.000Z',
    sessionId: 'sess-1',
    cwd: '/synthetic/project',
    gitBranch: 'main',
    requestId: 'req-1',
    isSidechain: false,
    type: 'assistant',
    message: {
      id,
      model: 'synthetic-model',
      type: 'message',
      role: 'assistant',
      usage: {
        input_tokens: 3,
        output_tokens: output,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        service_tier: 'standard',
        speed: 'standard',
        ...override.usage,
      },
    },
    ...override.line,
  });
}

function writeGz(archiveRoot: string, relPath: string, lines: string[]): string {
  const abs = join(archiveRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, gzipSync(`${lines.join('\n')}\n`));
  return abs;
}

function eventRows(db: DatabaseSync) {
  return db.prepare('SELECT * FROM usage_event ORDER BY message_id').all() as Array<Record<string, unknown>>;
}

function countEvents(db: DatabaseSync): number {
  const row = db.prepare('SELECT count(*) AS n FROM usage_event').get() as { n: number };
  return row.n;
}

// mtime을 결정적으로 밀어 올린다 (같은 ms 내 수정으로 skip 판정되는 플레이크 방지).
function bumpMtime(path: string, ms: number): void {
  utimesSync(path, new Date(ms), new Date(ms));
}

// 1. 누적 라인 dedup (가장 중요): 같은 message.id 3줄 (output 10 -> 50 -> 120)
//    -> 1행, output_tokens = 120. 라인 합(180)이 아니다.
test('cumulative lines for one message.id collapse to the terminal usage', async () => {
  const { db, archiveRoot } = setup();
  writeGz(archiveRoot, 'wsl/a.jsonl.gz', [
    usageLine('msg_1', 10, { usage: { input_tokens: 1 } }),
    usageLine('msg_1', 50, { usage: { input_tokens: 5 } }),
    usageLine('msg_1', 120, { usage: { input_tokens: 12 } }),
  ]);

  const counts = await parseOnce({ db, archiveRoot });

  assert.equal(counts.linesRead, 3);
  assert.equal(counts.errors, 0);
  const rows = eventRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].output_tokens, 120);
  assert.equal(rows[0].input_tokens, 12); // 종단 라인의 usage 전체가 이긴다
  assert.equal(rows[0].captured_at, Date.parse('2026-07-01T00:00:00.000Z'));
  assert.equal(rows[0].source_id, 'wsl');
});

// 2. 순서 무관: 같은 세 줄을 역순으로 줘도 결과는 종단(최대) usage
test('dedup does not depend on line order', async () => {
  const { db, archiveRoot } = setup();
  writeGz(archiveRoot, 'wsl/a.jsonl.gz', [
    usageLine('msg_1', 120, { usage: { input_tokens: 12 } }),
    usageLine('msg_1', 50, { usage: { input_tokens: 5 } }),
    usageLine('msg_1', 10, { usage: { input_tokens: 1 } }),
  ]);

  await parseOnce({ db, archiveRoot });

  const rows = eventRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].output_tokens, 120);
  assert.equal(rows[0].input_tokens, 12);
});

// 3. 파일 간 dedup: 두 소스에 같은 message.id -> 1행
test('same message.id across sources is one row', async () => {
  const { db, archiveRoot } = setup();
  writeGz(archiveRoot, 'wsl/a.jsonl.gz', [usageLine('msg_x', 40)]);
  writeGz(archiveRoot, 'windows/b.jsonl.gz', [usageLine('msg_x', 40)]);

  await parseOnce({ db, archiveRoot });

  assert.equal(countEvents(db), 1);
});

// 4. 고유 이벤트만 증가 (완료 기준 4): wsl 파싱 후 windows 추가
//    -> 증가분 = windows 고유 message.id 수
test('adding a second source grows rows by its unique message.id count only', async () => {
  const { db, archiveRoot } = setup();
  writeGz(archiveRoot, 'wsl/a.jsonl.gz', [usageLine('m1', 10), usageLine('m2', 20)]);
  await parseOnce({ db, archiveRoot });
  const before = countEvents(db);
  assert.equal(before, 2);

  // windows: m2는 중복, m3/m4가 고유
  writeGz(archiveRoot, 'windows/b.jsonl.gz', [
    usageLine('m2', 20), usageLine('m3', 30), usageLine('m4', 40),
  ]);
  await parseOnce({ db, archiveRoot });

  assert.equal(countEvents(db), before + 2);
});

// 5. cache_creation 분해: ephemeral_5m/1h 가 각 컬럼으로
test('cache_creation ephemeral buckets land in their own columns', async () => {
  const { db, archiveRoot } = setup();
  writeGz(archiveRoot, 'wsl/a.jsonl.gz', [
    usageLine('m1', 10, {
      usage: {
        cache_creation_input_tokens: 18,
        cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 11 },
      },
    }),
  ]);

  await parseOnce({ db, archiveRoot });

  const row = eventRows(db)[0];
  assert.equal(row.cache_creation_input_tokens, 18);
  assert.equal(row.cache_creation_5m_tokens, 7);
  assert.equal(row.cache_creation_1h_tokens, 11);
});

// 6. speed 부재 (구버전 기록 14~16%): 실패하지 않고 NULL 적재
test('missing speed loads as NULL without failing', async () => {
  const { db, archiveRoot } = setup();
  writeGz(archiveRoot, 'wsl/a.jsonl.gz', [
    usageLine('m1', 10, { usage: { speed: undefined } }),
  ]);

  const counts = await parseOnce({ db, archiveRoot });

  assert.equal(counts.errors, 0);
  const row = db.prepare('SELECT speed FROM usage_event WHERE speed IS NULL').get();
  assert.ok(row, 'speed IS NULL 행이 없다');
});

// 7. raw_usage_json verbatim: server_tool_use, iterations, inference_geo 보존
test('raw_usage_json preserves unknown usage fields', async () => {
  const { db, archiveRoot } = setup();
  writeGz(archiveRoot, 'wsl/a.jsonl.gz', [
    usageLine('m1', 10, {
      usage: {
        server_tool_use: { web_search_requests: 2 },
        iterations: 3,
        inference_geo: 'not_available',
      },
    }),
  ]);

  await parseOnce({ db, archiveRoot });

  const row = eventRows(db)[0];
  const raw = JSON.parse(row.raw_usage_json as string);
  assert.deepEqual(raw.server_tool_use, { web_search_requests: 2 });
  assert.equal(raw.iterations, 3);
  assert.equal(raw.inference_geo, 'not_available');
});

// 8. usage 없는 라인 무시: user/summary/usage 없는 assistant 라인은 이벤트를 만들지 않는다
test('lines without message.usage or message.id produce no events', async () => {
  const { db, archiveRoot } = setup();
  writeGz(archiveRoot, 'wsl/a.jsonl.gz', [
    JSON.stringify({ type: 'user', timestamp: '2026-07-01T00:00:00Z', message: { role: 'user' } }),
    JSON.stringify({ type: 'summary', summary: 'synthetic' }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-07-01T00:00:00Z', message: { id: 'm-no-usage' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-07-01T00:00:00Z', message: { usage: { output_tokens: 5 } } }), // id 없음
  ]);

  const counts = await parseOnce({ db, archiveRoot });

  assert.equal(counts.linesRead, 4);
  assert.equal(counts.errors, 0);
  assert.equal(countEvents(db), 0);
});

// 9. timestamp 불량: 그 라인만 버리고 나머지는 적재
test('lines with missing or unparseable timestamp are dropped, rest load', async () => {
  const { db, archiveRoot } = setup();
  writeGz(archiveRoot, 'wsl/a.jsonl.gz', [
    usageLine('m-no-ts', 10, { line: { timestamp: undefined } }),
    usageLine('m-bad-ts', 20, { line: { timestamp: 'not-a-date' } }),
    usageLine('m-good', 30),
  ]);

  const counts = await parseOnce({ db, archiveRoot });

  assert.equal(counts.errors, 0);
  const rows = eventRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message_id, 'm-good');
});

// 10. 멱등: 두 번째 실행은 parsed_archive 스킵으로 upsert 0, 행 수 불변
test('second run skips parsed archives and upserts nothing', async () => {
  const { db, archiveRoot } = setup();
  writeGz(archiveRoot, 'wsl/a.jsonl.gz', [usageLine('m1', 10), usageLine('m2', 20)]);
  await parseOnce({ db, archiveRoot });
  const before = countEvents(db);

  const counts = await parseOnce({ db, archiveRoot });

  assert.equal(counts.archivesParsed, 0);
  assert.equal(counts.archivesSkipped, 1);
  assert.equal(counts.eventsUpserted, 0);
  assert.equal(countEvents(db), before);
});

// 11. 아카이브 변경 시 재파싱: mtime 이 바뀌면 다시 읽고 종단 usage 로 갱신
test('changed mtime triggers re-parse and updates to the larger usage', async () => {
  const { db, archiveRoot } = setup();
  const abs = writeGz(archiveRoot, 'wsl/a.jsonl.gz', [usageLine('m1', 10)]);
  await parseOnce({ db, archiveRoot });

  writeGz(archiveRoot, 'wsl/a.jsonl.gz', [usageLine('m1', 10), usageLine('m1', 120)]);
  bumpMtime(abs, Math.floor(statSync(abs).mtimeMs) + 5000);
  const counts = await parseOnce({ db, archiveRoot });

  assert.equal(counts.archivesParsed, 1);
  const rows = eventRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].output_tokens, 120);
});

// 12. 보존본 포함: compaction 으로 원본에서 사라진 이벤트가 x.jsonl.<mtime>.gz 에만 남을 수 있다
test('preserved archives (x.jsonl.<mtime>.gz) are parsed too', async () => {
  const { db, archiveRoot } = setup();
  writeGz(archiveRoot, 'wsl/x.jsonl.gz', [usageLine('m-current', 10)]);
  writeGz(archiveRoot, 'wsl/x.jsonl.1234567.gz', [usageLine('m-only-in-preserved', 99)]);

  await parseOnce({ db, archiveRoot });

  assert.equal(countEvents(db), 2);
  const row = db.prepare('SELECT output_tokens FROM usage_event WHERE message_id = ?')
    .get('m-only-in-preserved') as { output_tokens: number };
  assert.equal(row.output_tokens, 99);
});

// 13. 깨진 gz 하나가 나머지를 막지 않는다
test('one corrupt gz does not stop the rest', async () => {
  const { db, archiveRoot } = setup();
  mkdirSync(join(archiveRoot, 'wsl'), { recursive: true });
  writeFileSync(join(archiveRoot, 'wsl/bad.jsonl.gz'), 'this is not gzip data');
  writeGz(archiveRoot, 'wsl/good.jsonl.gz', [usageLine('m1', 10)]);

  const counts = await parseOnce({ db, archiveRoot });

  assert.equal(counts.errors, 1);
  assert.equal(countEvents(db), 1);
});

// 14. isSidechain: true/false -> 1/0
test('isSidechain maps to integer 1/0', async () => {
  const { db, archiveRoot } = setup();
  writeGz(archiveRoot, 'wsl/a.jsonl.gz', [
    usageLine('m-side', 10, { line: { isSidechain: true } }),
    usageLine('m-main', 20, { line: { isSidechain: false } }),
  ]);

  await parseOnce({ db, archiveRoot });

  const side = db.prepare('SELECT is_sidechain FROM usage_event WHERE message_id = ?').get('m-side') as { is_sidechain: number };
  const main = db.prepare('SELECT is_sidechain FROM usage_event WHERE message_id = ?').get('m-main') as { is_sidechain: number };
  assert.equal(side.is_sidechain, 1);
  assert.equal(main.is_sidechain, 0);
});

// 15. 마이그레이션: v2 DB -> v3. snapshot/transcript_file 데이터 보존, 멱등
test('v2 database migrates to v3 preserving existing data', () => {
  const path = join(tmpDir(), 'v2.sqlite');
  const legacy = new DatabaseSync(path);
  // v2 시점 스키마의 동결 사본 (역사적 픽스처 - db.ts와 동기화하지 않는다).
  legacy.exec(`
    CREATE TABLE snapshot (
      id INTEGER PRIMARY KEY,
      captured_at INTEGER NOT NULL,
      raw_json TEXT NOT NULL,
      five_hour_pct REAL GENERATED ALWAYS AS (json_extract(raw_json,'$.five_hour.utilization')) VIRTUAL
    );
    CREATE TABLE collector_run (
      id INTEGER PRIMARY KEY,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      http_status INTEGER,
      note TEXT,
      snapshot_id INTEGER REFERENCES snapshot(id)
    );
    CREATE TABLE transcript_file (
      source_id TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      archive_path TEXT NOT NULL,
      last_size INTEGER NOT NULL,
      last_mtime_ms INTEGER NOT NULL,
      content_sha256 TEXT NOT NULL,
      archived_at INTEGER NOT NULL,
      PRIMARY KEY (source_id, rel_path)
    );
    PRAGMA user_version = 2;
  `);
  legacy.prepare('INSERT INTO snapshot (captured_at, raw_json) VALUES (?, ?)')
    .run(1234, '{"five_hour":{"utilization":21}}');
  legacy.prepare(`
    INSERT INTO transcript_file (source_id, rel_path, archive_path, last_size, last_mtime_ms, content_sha256, archived_at)
    VALUES ('wsl', 'p/s.jsonl', 'wsl/p/s.jsonl.gz', 10, 1000, 'deadbeef', 2000)
  `).run();
  legacy.close();

  const db = openDb(path); // v2 -> v3 만 밟아야 한다
  const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.equal(version.user_version, 3);
  const snap = db.prepare('SELECT raw_json FROM snapshot').get() as { raw_json: string };
  assert.equal(snap.raw_json, '{"five_hour":{"utilization":21}}');
  const tf = db.prepare('SELECT content_sha256 FROM transcript_file').get() as { content_sha256: string };
  assert.equal(tf.content_sha256, 'deadbeef');
  db.prepare('SELECT count(*) AS n FROM usage_event').get(); // 테이블 존재
  db.prepare('SELECT count(*) AS n FROM parsed_archive').get();
  migrate(db); // 멱등
});
