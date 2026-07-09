// health.sh 가 부른다. 한 줄 요약을 stdout 에 내고, 건강하지 않으면 exit 1.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { health, formatHealth } from './health.ts';

const repo = join(import.meta.dirname, '..');
const db = new DatabaseSync(join(repo, 'data', 'usage.sqlite'), { readOnly: true });

let heartbeatMtimeMs: number | null = null;
try {
  heartbeatMtimeMs = statSync(join(repo, 'data', 'heartbeat')).mtimeMs;
} catch {
  heartbeatMtimeMs = null; // 한 번도 성공한 슬롯이 없다
}

const h = health({
  db,
  heartbeatMtimeMs,
  now: Date.now(),
  maxGapPct: 1,                  // 완료 기준 1
  maxHeartbeatAgeMs: 2 * 3_600_000, // 5분 슬롯이 24번 연속 빠지면 죽은 것으로 본다
});
db.close();

console.log(formatHealth(h));
process.exit(h.healthy ? 0 : 1);
