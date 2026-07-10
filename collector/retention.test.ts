// 보존 정책 테스트. **되돌릴 수 없는 삭제**라 경계와 안전장치를 집중적으로 검증한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './db.ts';
import { pruneOnce, RETENTION_DAYS } from './retention.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-07-10T00:00:00Z');
const CUTOFF = NOW - RETENTION_DAYS * DAY;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'claude-monitor-ret-'));
}

function touch(root: string, rel: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), 'gz');
}

function setup() {
  const db = openDb(join(tmp(), 'test.sqlite'));
  const archiveRoot = tmp();
  return { db, archiveRoot };
}

function addSnapshot(db: DatabaseSync, t: number): void {
  db.prepare('INSERT INTO snapshot (captured_at, raw_json) VALUES (?, ?)').run(t, '{"five_hour":{"utilization":1}}');
}
function addRun(db: DatabaseSync, t: number): void {
  db.prepare(`INSERT INTO collector_run (started_at, kind, status) VALUES (?, 'snapshot', 'ok')`).run(t);
}
function addEvent(db: DatabaseSync, id: string, t: number): void {
  db.prepare(`
    INSERT INTO usage_event (message_id, captured_at, source_id, raw_usage_json) VALUES (?, ?, 'wsl', '{}')
  `).run(id, t);
}
function addArchive(db: DatabaseSync, archiveRoot: string, rel: string, mtime: number): void {
  const archivePath = join('wsl', `${rel}.gz`);
  touch(archiveRoot, archivePath);
  db.prepare(`
    INSERT INTO transcript_file (source_id, rel_path, archive_path, last_size, last_mtime_ms, content_sha256, archived_at)
    VALUES ('wsl', ?, ?, 1, ?, 'sha', ?)
  `).run(rel, archivePath, mtime, mtime);
  db.prepare('INSERT INTO parsed_archive (archive_path, mtime_ms, parsed_at) VALUES (?, ?, ?)').run(archivePath, mtime, mtime);
}

const count = (db: DatabaseSync, table: string): number =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

// 이 테스트가 이 모듈의 존재 이유다. cutoff 오타 하나로 전부 지워지면 안 된다.
test('a future cutoff throws instead of deleting everything', () => {
  const { db, archiveRoot } = setup();
  addSnapshot(db, NOW - DAY);
  assert.throws(() => pruneOnce({ db, archiveRoot, cutoffMs: NOW + DAY, nowMs: NOW }), /past/);
  assert.throws(() => pruneOnce({ db, archiveRoot, cutoffMs: NOW, nowMs: NOW }), /past/);
  assert.equal(count(db, 'snapshot'), 1, '던지고도 지웠다');
});

test('the boundary is half-open: exactly at the cutoff survives', () => {
  const { db, archiveRoot } = setup();
  addSnapshot(db, CUTOFF);       // 살아야 함
  addSnapshot(db, CUTOFF - 1);   // 죽어야 함
  const c = pruneOnce({ db, archiveRoot, cutoffMs: CUTOFF, nowMs: NOW });
  assert.equal(c.snapshots, 1);
  assert.equal(count(db, 'snapshot'), 1);
});

test('recent data is untouched', () => {
  const { db, archiveRoot } = setup();
  for (const d of [0, 30, 90, 182]) addSnapshot(db, NOW - d * DAY);
  const c = pruneOnce({ db, archiveRoot, cutoffMs: CUTOFF, nowMs: NOW });
  assert.equal(c.snapshots, 0);
  assert.equal(count(db, 'snapshot'), 4);
});

test('old snapshots, runs, and events are deleted with their own timestamps', () => {
  const { db, archiveRoot } = setup();
  addSnapshot(db, NOW - 200 * DAY); addSnapshot(db, NOW - DAY);
  addRun(db, NOW - 200 * DAY); addRun(db, NOW - DAY);
  addEvent(db, 'old', NOW - 200 * DAY); addEvent(db, 'new', NOW - DAY);

  const c = pruneOnce({ db, archiveRoot, cutoffMs: CUTOFF, nowMs: NOW });

  assert.deepEqual(
    { s: c.snapshots, r: c.collectorRuns, e: c.usageEvents },
    { s: 1, r: 1, e: 1 },
  );
  assert.equal(count(db, 'snapshot'), 1);
  assert.equal(count(db, 'usage_event'), 1);
  const left = db.prepare('SELECT message_id FROM usage_event').get() as { message_id: string };
  assert.equal(left.message_id, 'new');
});

// collector_run.snapshot_id 는 snapshot(id) 를 참조한다. 오래된 스냅샷을 지우면서
// 이를 가리키는 run 행을 남기면 FOREIGN KEY 로 터진다. 실 DB 사본에서 실제로 터졌다.
// run 행은 결손의 권위 있는 출처(불변식 I3)이므로 지우지 말고 포인터만 끊어야 한다.
test('a run pointing at a pruned snapshot survives with a null pointer, not a crash', () => {
  const { db, archiveRoot } = setup();
  addSnapshot(db, NOW - 200 * DAY);
  const snapId = (db.prepare('SELECT id FROM snapshot').get() as { id: number }).id;
  // 이 run 은 최근이라 살아남는다. 그런데 오래된 스냅샷을 가리킨다.
  db.prepare(`
    INSERT INTO collector_run (started_at, kind, status, snapshot_id) VALUES (?, 'snapshot', 'ok', ?)
  `).run(NOW - DAY, snapId);

  const c = pruneOnce({ db, archiveRoot, cutoffMs: CUTOFF, nowMs: NOW });

  assert.equal(c.snapshots, 1);
  assert.equal(c.collectorRuns, 0, '최근 run 을 지우면 결손 히스토리가 사라진다');
  const run = db.prepare('SELECT snapshot_id FROM collector_run').get() as { snapshot_id: number | null };
  assert.equal(run.snapshot_id, null, '포인터가 끊기지 않았다');
});

test('foreign keys are actually enforced (otherwise the test above proves nothing)', () => {
  const { db } = setup();
  const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
  assert.equal(row.foreign_keys, 1);
});

test('archives are cut by the source mtime, and their bookkeeping goes with them', () => {
  const { db, archiveRoot } = setup();
  addArchive(db, archiveRoot, 'p/old.jsonl', NOW - 200 * DAY);
  addArchive(db, archiveRoot, 'p/new.jsonl', NOW - DAY);

  const c = pruneOnce({ db, archiveRoot, cutoffMs: CUTOFF, nowMs: NOW });

  assert.equal(c.transcriptFiles, 1);
  assert.equal(c.archiveFiles, 1);
  assert.equal(existsSync(join(archiveRoot, 'wsl/p/old.jsonl.gz')), false);
  assert.equal(existsSync(join(archiveRoot, 'wsl/p/new.jsonl.gz')), true);
  assert.equal(count(db, 'transcript_file'), 1);
  assert.equal(count(db, 'parsed_archive'), 1);
});

test('preserved rewrite copies are deleted too, even if never parsed', () => {
  const { db, archiveRoot } = setup();
  addArchive(db, archiveRoot, 'p/x.jsonl', NOW - 200 * DAY);
  // 재기록 보존본. parsed_archive 에는 없다 (파싱 전에 만들어질 수 있다).
  touch(archiveRoot, 'wsl/p/x.jsonl.1700000000000.gz');
  touch(archiveRoot, 'wsl/p/x.jsonl.1700000000001.gz');
  // 다른 파일의 보존본은 건드리면 안 된다.
  addArchive(db, archiveRoot, 'p/y.jsonl', NOW - DAY);
  touch(archiveRoot, 'wsl/p/y.jsonl.1700000000000.gz');

  const c = pruneOnce({ db, archiveRoot, cutoffMs: CUTOFF, nowMs: NOW });

  assert.equal(c.archiveFiles, 3, '현재본 1 + 보존본 2');
  assert.equal(existsSync(join(archiveRoot, 'wsl/p/x.jsonl.1700000000000.gz')), false);
  assert.equal(existsSync(join(archiveRoot, 'wsl/p/x.jsonl.1700000000001.gz')), false);
  assert.equal(existsSync(join(archiveRoot, 'wsl/p/y.jsonl.1700000000000.gz')), true, '남의 보존본을 지웠다');
  assert.equal(existsSync(join(archiveRoot, 'wsl/p/y.jsonl.gz')), true);
});

test('an archive already gone from disk is not counted as deleted', () => {
  const { db, archiveRoot } = setup();
  addArchive(db, archiveRoot, 'p/x.jsonl', NOW - 200 * DAY);
  rmSync(join(archiveRoot, 'wsl/p/x.jsonl.gz'), { force: true });

  const c = pruneOnce({ db, archiveRoot, cutoffMs: CUTOFF, nowMs: NOW });
  assert.equal(c.archiveFiles, 0);
  assert.equal(c.transcriptFiles, 1, '부기는 정리되어야 한다');
});

test('pruning an empty database is a no-op', () => {
  const { db, archiveRoot } = setup();
  const c = pruneOnce({ db, archiveRoot, cutoffMs: CUTOFF, nowMs: NOW });
  assert.deepEqual(c, { snapshots: 0, collectorRuns: 0, usageEvents: 0, archiveFiles: 0, transcriptFiles: 0 });
});

test('prune is idempotent', () => {
  const { db, archiveRoot } = setup();
  addSnapshot(db, NOW - 200 * DAY);
  addArchive(db, archiveRoot, 'p/x.jsonl', NOW - 200 * DAY);
  pruneOnce({ db, archiveRoot, cutoffMs: CUTOFF, nowMs: NOW });
  const second = pruneOnce({ db, archiveRoot, cutoffMs: CUTOFF, nowMs: NOW });
  assert.deepEqual(second, { snapshots: 0, collectorRuns: 0, usageEvents: 0, archiveFiles: 0, transcriptFiles: 0 });
});

test('retention is 183 days (about six months)', () => {
  assert.equal(RETENTION_DAYS, 183);
});
