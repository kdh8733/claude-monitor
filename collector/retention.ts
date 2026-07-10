// 보존 정책: 6개월. 그보다 오래된 것은 정리한다 (사용자 결정, 2026-07-10).
//
// **되돌릴 수 없는 삭제다.** 그래서 이 모듈은 다음을 지킨다.
//   1. cutoff 는 호출자가 명시적으로 준다. 이 모듈은 시계를 읽지 않는다.
//   2. 미래 시각을 cutoff 로 주면 던진다. "전부 지우기"가 사고로 일어나지 않게.
//   3. 아카이브와 DB 행의 기준이 다르다 (아래).
//   4. 무엇을 지웠는지 카운트를 반환한다. 조용히 지우지 않는다.
//
// 기준이 다른 이유:
//   아카이브 파일은 **원본 트랜스크립트의 mtime** 으로 자른다. 파일이 6개월 전에 마지막으로
//   수정됐다면 그 안의 이벤트도 전부 6개월 이전이다. 역은 성립하지 않는다.
//   DB 행은 **자기 시각**으로 자른다. 아카이브가 먼저 사라져도 이미 파싱된 usage_event 는
//   자기 시각이 될 때까지 남는다 - 귀속 통계가 원본보다 먼저 사라지지 않게.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export const RETENTION_DAYS = 183; // 약 6개월

export interface PruneCounts {
  snapshots: number;
  collectorRuns: number;
  usageEvents: number;
  archiveFiles: number;
  transcriptFiles: number;
}

export interface PruneDeps {
  db: DatabaseSync;
  archiveRoot: string;
  /** 이 시각 **이전**의 것을 지운다 (UTC ms). 반open: captured_at < cutoffMs. */
  cutoffMs: number;
  /** 미래 cutoff 를 막기 위한 현재 시각. 호출자가 준다. */
  nowMs: number;
}

export function pruneOnce(deps: PruneDeps): PruneCounts {
  if (deps.cutoffMs >= deps.nowMs) {
    // 여기서 막지 않으면 "전부 지우기"가 오타 한 번으로 일어난다.
    throw new Error('cutoff must be in the past');
  }

  const counts: PruneCounts = {
    snapshots: 0, collectorRuns: 0, usageEvents: 0, archiveFiles: 0, transcriptFiles: 0,
  };

  // 1) 아카이브: 원본 mtime 기준. 파일을 먼저 지우고, 성공한 것만 부기에서 뺀다.
  const stale = deps.db.prepare(
    'SELECT source_id, rel_path, archive_path FROM transcript_file WHERE last_mtime_ms < ?',
  ).all(deps.cutoffMs) as Array<{ source_id: string; rel_path: string; archive_path: string }>;

  const delParsed = deps.db.prepare('DELETE FROM parsed_archive WHERE archive_path = ?');
  const delFile = deps.db.prepare('DELETE FROM transcript_file WHERE source_id = ? AND rel_path = ?');

  for (const row of stale) {
    // 재기록으로 보존된 옛 버전(`<rel>.jsonl.<mtime>.gz`)도 함께 지운다.
    // 부기가 아니라 파일시스템에서 찾는다 - 파싱 전에 만들어진 보존본은 parsed_archive 에 없다.
    for (const v of archiveVariants(deps.archiveRoot, row.archive_path)) {
      rmSync(join(deps.archiveRoot, v), { force: true });
      delParsed.run(v);
      counts.archiveFiles++;
    }
    delFile.run(row.source_id, row.rel_path);
    counts.transcriptFiles++;
  }

  // 2) DB 행: 자기 시각 기준.
  deps.db.exec('BEGIN IMMEDIATE');
  try {
    counts.usageEvents = Number(deps.db.prepare('DELETE FROM usage_event WHERE captured_at < ?').run(deps.cutoffMs).changes);
    counts.collectorRuns = Number(deps.db.prepare('DELETE FROM collector_run WHERE started_at < ?').run(deps.cutoffMs).changes);

    // 살아남은 run 이 지워질 스냅샷을 가리키고 있으면 FOREIGN KEY 로 터진다.
    // run 행은 결손의 권위 있는 출처(불변식 I3)라 지우면 안 된다. 포인터만 끊는다.
    deps.db.prepare(`
      UPDATE collector_run SET snapshot_id = NULL
      WHERE snapshot_id IN (SELECT id FROM snapshot WHERE captured_at < ?)
    `).run(deps.cutoffMs);

    counts.snapshots = Number(deps.db.prepare('DELETE FROM snapshot WHERE captured_at < ?').run(deps.cutoffMs).changes);
    deps.db.exec('COMMIT');
  } catch (err) {
    deps.db.exec('ROLLBACK');
    throw err;
  }

  return counts;
}

/**
 * 한 아카이브의 현재본과 보존본 전부. archiveRoot 기준 상대경로로 돌려준다.
 * `a/b.jsonl.gz` -> `a/b.jsonl.gz`, `a/b.jsonl.1234.gz`, ...
 * 존재하는 것만 돌려준다 (없는 파일을 지웠다고 세지 않는다).
 */
function archiveVariants(archiveRoot: string, archivePath: string): string[] {
  const out: string[] = [];
  if (existsSync(join(archiveRoot, archivePath))) out.push(archivePath);

  const dir = dirname(archivePath);
  const stem = basename(archivePath).replace(/\.gz$/, ''); // `<name>.jsonl`
  let entries: string[];
  try {
    entries = readdirSync(join(archiveRoot, dir));
  } catch {
    return out; // 디렉터리가 이미 없다
  }
  const preserved = new RegExp(`^${escapeRe(stem)}\\.\\d+\\.gz$`);
  for (const e of entries) {
    if (preserved.test(e)) out.push(join(dir, e));
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
