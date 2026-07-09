// M3 트랜스크립트 아카이브 테스트. 실 트랜스크립트를 읽지 않는다 - 전부 임시 디렉터리의 합성 파일.
// 내용도 합성 문자열이다. 프롬프트 원문·실 프로젝트명 없음.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { openDb, migrate } from './db.ts';
import { archiveOnce } from './archive-once.ts';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'claude-monitor-m3-'));
}

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

// 가짜 소스 트리 + 빈 DB + 아카이브 루트. 파일 내용은 전부 합성.
const TREE: Record<string, string> = {
  'p1/s1.jsonl': '{"synthetic":1}\n{"synthetic":2}\n',
  'p1/s2.jsonl': '{"synthetic":3}\n',
  'p2/s3.jsonl': '{"synthetic":4}\n{"synthetic":5}\n{"synthetic":6}\n',
};

function setup(files: Record<string, string> = TREE) {
  const root = tmpDir();
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  const db = openDb(join(tmpDir(), 'test.sqlite'));
  const archiveRoot = join(tmpDir(), 'archive');
  const sources = [{ id: 'wsl', root }];
  return { db, root, archiveRoot, sources };
}

function fileRow(db: DatabaseSync, relPath: string) {
  return db.prepare(
    'SELECT * FROM transcript_file WHERE source_id = ? AND rel_path = ?',
  ).get('wsl', relPath) as {
    archive_path: string; last_size: number; last_mtime_ms: number; content_sha256: string;
  } | undefined;
}

function countRows(db: DatabaseSync): number {
  const row = db.prepare('SELECT count(*) AS n FROM transcript_file').get() as { n: number };
  return row.n;
}

// mtime을 결정적으로 밀어 올린다 (같은 ms 내 수정으로 skip 판정되는 플레이크 방지).
function bumpMtime(path: string, ms: number): void {
  utimesSync(path, new Date(ms), new Date(ms));
}

// 1. 아카이브 생성: 파일 3개 -> 아카이브 3개, transcript_file 3행
test('archives every jsonl file and records one row each', async () => {
  const { db, archiveRoot, sources } = setup();

  const counts = await archiveOnce({ db, sources, archiveRoot });

  assert.deepEqual(counts, { scanned: 3, archived: 3, skipped: 0, rewritten: 0, errors: 0 });
  assert.equal(countRows(db), 3);
  for (const rel of Object.keys(TREE)) {
    const row = fileRow(db, rel);
    assert.ok(row, `${rel} 행 없음`);
    assert.equal(row.archive_path, join('wsl', `${rel}.gz`));
    readFileSync(join(archiveRoot, row.archive_path)); // 존재 확인
  }
});

// 2. 원본 복원 가능 (완료 기준): gunzip한 내용의 sha256이 원본과 일치
test('gunzipped archive matches original byte-for-byte', async () => {
  const { db, root, archiveRoot, sources } = setup();

  await archiveOnce({ db, sources, archiveRoot });

  for (const rel of Object.keys(TREE)) {
    const original = readFileSync(join(root, rel));
    const restored = gunzipSync(readFileSync(join(archiveRoot, 'wsl', `${rel}.gz`)));
    assert.equal(sha256(restored), sha256(original), rel);
  }
});

// 3. 멱등: 두 번째 실행은 skipped=3, archived=0. 행 수 불변
test('second run skips everything', async () => {
  const { db, archiveRoot, sources } = setup();

  await archiveOnce({ db, sources, archiveRoot });
  const counts = await archiveOnce({ db, sources, archiveRoot });

  assert.deepEqual(counts, { scanned: 3, archived: 0, skipped: 3, rewritten: 0, errors: 0 });
  assert.equal(countRows(db), 3);
});

// 4. append 감지: 줄 추가 + mtime 갱신 -> archived=1, 아카이브가 새 전문과 일치
test('appended file is re-archived in full', async () => {
  const { db, root, archiveRoot, sources } = setup();
  await archiveOnce({ db, sources, archiveRoot });

  const target = join(root, 'p1/s1.jsonl');
  appendFileSync(target, '{"synthetic":7}\n');
  bumpMtime(target, fileRow(db, 'p1/s1.jsonl')!.last_mtime_ms + 5000);
  const counts = await archiveOnce({ db, sources, archiveRoot });

  assert.equal(counts.archived, 1);
  assert.equal(counts.skipped, 2);
  assert.equal(counts.rewritten, 0);
  const restored = gunzipSync(readFileSync(join(archiveRoot, 'wsl', 'p1/s1.jsonl.gz')));
  assert.equal(restored.toString(), readFileSync(target).toString());
});

// 5. 재기록 감지 (핵심): 더 짧은 다른 내용으로 덮어씀 -> rewritten=1,
//    이전 아카이브가 .<last_mtime_ms>.gz 로 살아남고 내용이 옛 원본과 일치
test('rewritten (shorter) file preserves old archive under mtime suffix', async () => {
  const { db, root, archiveRoot, sources } = setup();
  await archiveOnce({ db, sources, archiveRoot });
  const oldContent = TREE['p1/s1.jsonl'];
  const oldMtime = fileRow(db, 'p1/s1.jsonl')!.last_mtime_ms;

  const target = join(root, 'p1/s1.jsonl');
  writeFileSync(target, '{"compacted":true}\n'); // 더 짧은 다른 내용 (compaction 모사)
  bumpMtime(target, oldMtime + 5000);
  const counts = await archiveOnce({ db, sources, archiveRoot });

  assert.equal(counts.rewritten, 1);
  assert.equal(counts.archived, 0);
  const preserved = gunzipSync(
    readFileSync(join(archiveRoot, 'wsl', 'p1', `s1.jsonl.${oldMtime}.gz`)),
  );
  assert.equal(preserved.toString(), oldContent);
  const current = gunzipSync(readFileSync(join(archiveRoot, 'wsl', 'p1/s1.jsonl.gz')));
  assert.equal(current.toString(), '{"compacted":true}\n');
});

// 6. 선두 해시 변경 감지: 크기는 같은데 선두 내용이 다름 -> rewritten=1
test('same-size head change is detected as rewrite', async () => {
  const content = '{"synthetic":"aaaa"}\n';
  const { db, root, archiveRoot, sources } = setup({ 'p/x.jsonl': content });
  await archiveOnce({ db, sources, archiveRoot });
  const oldMtime = fileRow(db, 'p/x.jsonl')!.last_mtime_ms;

  const replaced = '{"synthetic":"bbbb"}\n';
  assert.equal(replaced.length, content.length); // 크기 동일이 테스트의 전제
  const target = join(root, 'p/x.jsonl');
  writeFileSync(target, replaced);
  bumpMtime(target, oldMtime + 5000);
  const counts = await archiveOnce({ db, sources, archiveRoot });

  assert.equal(counts.rewritten, 1);
  assert.equal(counts.archived, 0);
});

// 6a. 선두는 그대로 두고 뒤를 고쳐 쓰며 크기를 키운 재기록.
// 선두 일부만 해시하면 이걸 append로 오판하고 옛 아카이브를 덮어써 원본이 영구 소멸한다.
// M3 의 존재 이유(보존이 파싱보다 먼저)가 정확히 여기서 무너진다. 004 C9.
test('rewrite past the head, with growth, is detected and preserves the old archive', async () => {
  const head = `{"synthetic":"${'h'.repeat(6000)}"}\n`; // 선두 4096바이트를 넘긴다
  const oldContent = `${head}{"synthetic":"old tail"}\n`;
  const { db, root, archiveRoot, sources } = setup({ 'p/x.jsonl': oldContent });
  await archiveOnce({ db, sources, archiveRoot });
  const oldMtime = fileRow(db, 'p/x.jsonl')!.last_mtime_ms;

  // 선두는 동일. 뒤만 다르고 전체 크기는 더 크다.
  const newContent = `${head}{"synthetic":"rewritten tail, longer than before"}\n`;
  assert.ok(newContent.length > oldContent.length, '크기가 커지는 것이 이 테스트의 전제');
  const target = join(root, 'p/x.jsonl');
  writeFileSync(target, newContent);
  bumpMtime(target, oldMtime + 5000);

  const counts = await archiveOnce({ db, sources, archiveRoot });

  assert.equal(counts.rewritten, 1, '선두 밖 재기록을 append 로 오판했다');
  assert.equal(counts.archived, 0);
  const preserved = gunzipSync(readFileSync(join(archiveRoot, 'wsl', 'p', `x.jsonl.${oldMtime}.gz`)));
  assert.equal(preserved.toString(), oldContent, '옛 원본이 소멸했다');
});

// 7. 존재하지 않는 소스 루트: 에러 없이 건너뛴다
test('missing source root is skipped silently', async () => {
  const { db, archiveRoot, sources } = setup();
  const withGhost = [...sources, { id: 'windows', root: join(tmpDir(), 'no-such-root') }];

  const counts = await archiveOnce({ db, sources: withGhost, archiveRoot });

  assert.deepEqual(counts, { scanned: 3, archived: 3, skipped: 0, rewritten: 0, errors: 0 });
});

// 8. 중첩 디렉터리: a/b/c.jsonl -> archiveRoot/<src>/a/b/c.jsonl.gz
test('nested directories are mirrored under the source id', async () => {
  const { db, archiveRoot, sources } = setup({ 'a/b/c.jsonl': '{"synthetic":8}\n' });

  await archiveOnce({ db, sources, archiveRoot });

  const restored = gunzipSync(readFileSync(join(archiveRoot, 'wsl', 'a/b/c.jsonl.gz')));
  assert.equal(restored.toString(), '{"synthetic":8}\n');
});

// 9. 파일 하나가 실패해도 나머지 진행.
//    지시는 chmod 000이었으나 테스트가 root로 돌면 DAC를 우회해 읽기가 성공한다.
//    대신 끊어진 심링크로 읽기 실패를 주입한다 (stat 시점 ENOENT).
test('one failing file does not stop the rest', async () => {
  const { db, root, archiveRoot, sources } = setup({
    'ok1.jsonl': '{"synthetic":9}\n',
    'ok2.jsonl': '{"synthetic":10}\n',
  });
  symlinkSync(join(root, 'no-such-target'), join(root, 'bad.jsonl'));

  const counts = await archiveOnce({ db, sources, archiveRoot });

  assert.equal(counts.errors, 1);
  assert.equal(counts.archived, 2);
  assert.equal(countRows(db), 2);
  readFileSync(join(archiveRoot, 'wsl', 'ok1.jsonl.gz'));
  readFileSync(join(archiveRoot, 'wsl', 'ok2.jsonl.gz'));
});

// 10. 마이그레이션 호환: user_version 1 짜리 기존 DB -> v2로 올라가고 snapshot 데이터 보존
test('v1 database migrates to v2 preserving snapshot rows', () => {
  const path = join(tmpDir(), 'v1.sqlite');
  const legacy = new DatabaseSync(path);
  // M1이 실제로 만들었던 v1 스키마의 동결 사본 (역사적 픽스처 - db.ts와 동기화하지 않는다).
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
    PRAGMA user_version = 1;
  `);
  legacy.prepare('INSERT INTO snapshot (captured_at, raw_json) VALUES (?, ?)')
    .run(1234, '{"five_hour":{"utilization":21}}');
  legacy.close();

  const db = openDb(path); // migrate가 v1 이후 단계만 순서대로 밟는다 (현재 최신 v3)
  const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.equal(version.user_version, 3);
  const snap = db.prepare('SELECT raw_json FROM snapshot').get() as { raw_json: string };
  assert.equal(snap.raw_json, '{"five_hour":{"utilization":21}}');
  db.prepare('SELECT count(*) AS n FROM transcript_file').get(); // 테이블 존재
  migrate(db); // 멱등
});

// 11. 원자성: 아카이브 디렉터리에 .tmp 잔재가 없다
test('no .tmp residue remains in the archive tree', async () => {
  const { db, root, archiveRoot, sources } = setup();
  await archiveOnce({ db, sources, archiveRoot });
  // 재기록 경로까지 태워 임시 파일 경로를 전부 통과시킨다
  const target = join(root, 'p1/s1.jsonl');
  writeFileSync(target, '{"x":1}\n');
  bumpMtime(target, fileRow(db, 'p1/s1.jsonl')!.last_mtime_ms + 5000);
  await archiveOnce({ db, sources, archiveRoot });

  const leftovers = readdirSync(archiveRoot, { recursive: true })
    .filter((f) => String(f).endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});
