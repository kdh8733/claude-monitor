// SQLite 열기 + 마이그레이션. 스키마 계약: docs/decisions/002 (004로 조정, M1 범위만).
import { DatabaseSync } from 'node:sqlite';

// raw_json이 유일한 진실 (I1). 파생은 전부 VIRTUAL - 저장 0, 누락 경로는 NULL.
// limits[]는 배열이라 gencol로 굳히지 않는다 - 읽기 측이 json_each로 펼친다 (004 C3).
const DDL = `
CREATE TABLE snapshot (
  id INTEGER PRIMARY KEY,
  captured_at INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  five_hour_pct   REAL GENERATED ALWAYS AS (json_extract(raw_json,'$.five_hour.utilization')) VIRTUAL,
  five_hour_reset TEXT GENERATED ALWAYS AS (json_extract(raw_json,'$.five_hour.resets_at'))   VIRTUAL,
  weekly_all_pct  REAL GENERATED ALWAYS AS (json_extract(raw_json,'$.seven_day.utilization')) VIRTUAL,
  weekly_reset    TEXT GENERATED ALWAYS AS (json_extract(raw_json,'$.seven_day.resets_at'))   VIRTUAL,
  extra_enabled   INTEGER GENERATED ALWAYS AS (json_extract(raw_json,'$.extra_usage.is_enabled')) VIRTUAL
);
CREATE INDEX ix_snapshot_captured ON snapshot(captured_at);

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
CREATE INDEX ix_run_started ON collector_run(started_at);
`;

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (row.user_version >= 1) return;
  db.exec(DDL);
  db.exec('PRAGMA user_version = 1');
}
