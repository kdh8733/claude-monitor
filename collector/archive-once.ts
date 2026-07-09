// M3 트랜스크립트 아카이브: 원본 JSONL을 소멸 전에 gzip 미러로 확보한다. 보존만 - 파싱은 M5.
// 002 축 4의 차선 (c): 오프셋·증분 tail 없음. 변경된 파일은 통째로 다시 아카이브한다
// (하루 약 9MB, 활성 파일 소수라 tail 최적화는 정당화되지 않는 복잡도).
// 트랜스크립트는 append-only가 아니다 (004 C9, compaction 실재) - 재기록이면 옛 아카이브를 보존한다.
import { createHash, type Hash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { DatabaseSync } from 'node:sqlite';

export interface ArchiveOnceDeps {
  db: DatabaseSync;
  sources: Array<{ id: string; root: string }>;
  archiveRoot: string;
}

export interface ArchiveCounts {
  scanned: number;
  archived: number;
  skipped: number;
  rewritten: number;
  errors: number;
}

export async function archiveOnce(deps: ArchiveOnceDeps): Promise<ArchiveCounts> {
  const counts: ArchiveCounts = { scanned: 0, archived: 0, skipped: 0, rewritten: 0, errors: 0 };
  const selectFile = deps.db.prepare(
    'SELECT archive_path, last_size, last_mtime_ms, content_sha256 FROM transcript_file WHERE source_id = ? AND rel_path = ?',
  );
  const upsertFile = deps.db.prepare(`
    INSERT INTO transcript_file (source_id, rel_path, archive_path, last_size, last_mtime_ms, content_sha256, archived_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source_id, rel_path) DO UPDATE SET
      archive_path = excluded.archive_path,
      last_size = excluded.last_size,
      last_mtime_ms = excluded.last_mtime_ms,
      content_sha256 = excluded.content_sha256,
      archived_at = excluded.archived_at
  `);

  for (const source of deps.sources) {
    let entries: string[];
    try {
      entries = (readdirSync(source.root, { recursive: true }) as string[])
        .filter((p) => p.endsWith('.jsonl'));
    } catch {
      continue; // 루트 부재 - 조용히 건너뛴다 (Windows 소스가 없는 머신)
    }

    for (const relPath of entries) {
      const absPath = join(source.root, relPath);
      // 한 파일의 실패가 나머지를 막지 않는다. 실패는 카운트만 (경로는 로그에 남기지 않는다 -
      // 트랜스크립트 경로에는 실 프로젝트명이 들어 있다).
      try {
        const st = statSync(absPath);
        if (!st.isFile()) continue;
        counts.scanned++;

        const mtimeMs = Math.floor(st.mtimeMs);
        const row = selectFile.get(source.id, relPath) as {
          archive_path: string; last_size: number; last_mtime_ms: number; content_sha256: string;
        } | undefined;

        if (row && row.last_size === st.size && row.last_mtime_ms === mtimeMs) {
          counts.skipped++; // 변경 없음
          continue;
        }

        // 재기록 판정: 줄었거나, 지난번에 아카이브한 구간의 내용이 바뀌었다.
        // 앞 last_size 바이트를 다시 해시해 저장된 전체 해시와 대조한다. 순수 append 라면 일치한다.
        const isRewrite = row !== undefined && (
          st.size < row.last_size
          || await sha256OfPrefix(absPath, row.last_size) !== row.content_sha256
        );
        if (isRewrite) {
          // 옛 아카이브를 덮지 않고 보존한다 (M3: 보존이 먼저).
          const oldAbs = join(deps.archiveRoot, row.archive_path);
          const preserved = oldAbs.replace(/\.gz$/, `.${row.last_mtime_ms}.gz`);
          try {
            renameSync(oldAbs, preserved);
          } catch {
            // 옛 아카이브가 없으면(과거 실행이 upsert 전에 죽음) 보존할 것도 없다
          }
        }

        const archivePath = join(source.id, `${relPath}.gz`);
        const archiveAbs = join(deps.archiveRoot, archivePath);
        mkdirSync(dirname(archiveAbs), { recursive: true });
        const tmpPath = `${archiveAbs}.tmp`;
        let archived: { bytes: number; sha256: string };
        try {
          // 원자적 쓰기: 임시 파일 -> rename. 중간에 죽어도 반쪽 아카이브가 안 남는다.
          archived = await gzipToFile(absPath, tmpPath);
          renameSync(tmpPath, archiveAbs);
        } catch (err) {
          rmSync(tmpPath, { force: true });
          throw err;
        }

        // 실제로 아카이브한 바이트를 기록한다. 읽는 동안 파일이 자랐다면 stat 크기와 다르다.
        upsertFile.run(source.id, relPath, archivePath, archived.bytes, mtimeMs, archived.sha256, Date.now());
        if (isRewrite) counts.rewritten++;
        else counts.archived++;
      } catch {
        counts.errors++;
      }
    }
  }
  return counts;
}

// 파일을 gzip 으로 쓰면서 원본 바이트의 해시와 길이를 함께 낸다 (한 번만 읽는다).
async function gzipToFile(src: string, dest: string): Promise<{ bytes: number; sha256: string }> {
  const hash: Hash = createHash('sha256');
  let bytes = 0;
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  await pipeline(createReadStream(src), tap, createGzip(), createWriteStream(dest));
  return { bytes, sha256: hash.digest('hex') };
}

// 파일 앞 n 바이트의 sha256. 지난번 아카이브 구간이 그대로인지 확인하는 데 쓴다.
async function sha256OfPrefix(path: string, n: number): Promise<string> {
  if (n === 0) return createHash('sha256').digest('hex');
  const hash = createHash('sha256');
  let seen = 0;
  for await (const chunk of createReadStream(path, { start: 0, end: n - 1 })) {
    hash.update(chunk as Buffer);
    seen += (chunk as Buffer).length;
  }
  // 파일이 n 보다 짧으면 지난번 구간을 다 못 읽는다 = 잘렸다 = 재기록.
  if (seen < n) return 'truncated';
  return hash.digest('hex');
}
