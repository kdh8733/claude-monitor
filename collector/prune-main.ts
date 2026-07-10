// 보존 정책 실행. 주 1회 cron 이 부른다. 어떤 경우에도 exit 0.
// 지운 것은 collector_run 에 kind='prune' 으로 남는다 - 조용히 지우지 않는다.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { pruneOnce, RETENTION_DAYS } from './retention.ts';

const repo = join(import.meta.dirname, '..');
const dataDir = join(repo, 'data');
mkdirSync(dataDir, { recursive: true });

const db = openDb(join(dataDir, 'usage.sqlite'));
const startedAt = Date.now();
const insertRun = db.prepare(`
  INSERT INTO collector_run (started_at, finished_at, kind, status, note)
  VALUES (?, ?, 'prune', ?, ?)
`);

try {
  const c = pruneOnce({
    db,
    archiveRoot: join(dataDir, 'archive'),
    cutoffMs: startedAt - RETENTION_DAYS * 86_400_000,
    nowMs: startedAt,
  });
  const note = `retention=${RETENTION_DAYS}d snapshots=${c.snapshots} runs=${c.collectorRuns} `
    + `events=${c.usageEvents} archives=${c.archiveFiles} files=${c.transcriptFiles}`;
  // prune 자신의 기록은 cutoff 이후이므로 방금 지운 행에 섞이지 않는다.
  insertRun.run(startedAt, Date.now(), 'ok', note);
  console.log(note);

  // SQLite 파일은 DELETE 만으로 줄지 않는다. 실제로 지운 게 있을 때만 회수한다.
  if (c.snapshots + c.collectorRuns + c.usageEvents > 0) db.exec('VACUUM');
} catch (err) {
  insertRun.run(startedAt, Date.now(), 'error', err instanceof Error ? err.message : String(err));
  console.error('prune failed:', err instanceof Error ? err.message : String(err));
}
db.close();
process.exit(0);
