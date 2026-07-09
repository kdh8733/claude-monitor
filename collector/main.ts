// 얇은 엔트리포인트: 실 구현을 주입해 runOnce 1회. cron이 매 슬롯 독립 기동한다.
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { runOnce } from './run-once.ts';

const dataDir = join(import.meta.dirname, '..', 'data');
mkdirSync(dataDir, { recursive: true });
const db = openDb(join(dataDir, 'usage.sqlite'));
await runOnce({
  db,
  fetchFn: fetch,
  credentialsPath: join(homedir(), '.claude', '.credentials.json'),
});
db.close();
