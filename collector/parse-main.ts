// 얇은 엔트리포인트: parseOnce 1회. cron이 archive-main.ts 다음에 부른다.
// 어떤 경우에도 exit 0 - 실패는 collector_run 행으로 남긴다.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { parseOnce } from './parse-once.ts';

try {
  const dataDir = join(import.meta.dirname, '..', 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(join(dataDir, 'usage.sqlite'));
  const startedAt = Date.now();
  let status = 'ok';
  let note: string;
  try {
    const c = await parseOnce({ db, archiveRoot: join(dataDir, 'archive') });
    status = c.errors > 0 ? 'error' : 'ok';
    note = `scanned=${c.archivesScanned} parsed=${c.archivesParsed} skipped=${c.archivesSkipped}`
      + ` lines=${c.linesRead} upserted=${c.eventsUpserted} errors=${c.errors}`;
  } catch (err) {
    status = 'error';
    note = err instanceof Error ? err.message : String(err);
  }
  db.prepare(`
    INSERT INTO collector_run (started_at, finished_at, kind, status, note)
    VALUES (?, ?, 'parse', ?, ?)
  `).run(startedAt, Date.now(), status, note);
  db.close();
} catch {
  // DB조차 못 열면 기록할 곳이 없다. 그래도 exit 0 - cron이 다음 슬롯에 다시 시도한다.
}
