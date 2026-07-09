// SQLite 열기 + 마이그레이션. 스키마 계약: docs/decisions/002 (004로 조정, M1 범위만).
import { DatabaseSync } from 'node:sqlite';

// raw_json이 유일한 진실 (I1). 파생은 전부 VIRTUAL - 저장 0, 누락 경로는 NULL.
// limits[]는 배열이라 gencol로 굳히지 않는다 - 읽기 측이 json_each로 펼친다 (004 C3).
const DDL_V1 = `
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

// M3 트랜스크립트 아카이브 부기. 보존만 한다 - 파싱(usage_event)은 M5.
// last_offset 없음: 증분 tail을 하지 않는다 (002 축 4의 차선 (c) 채택 - 변경 시 전체 재아카이브).
const DDL_V2 = `
CREATE TABLE transcript_file (
  source_id     TEXT NOT NULL,
  rel_path      TEXT NOT NULL,
  archive_path  TEXT NOT NULL,   -- data/ 하위 상대경로 (archiveRoot 기준)
  last_size     INTEGER NOT NULL,   -- 아카이브한 바이트 수 (stat 크기가 아니다)
  last_mtime_ms INTEGER NOT NULL,
  -- 아카이브한 내용 전체의 sha256. 다음 실행에서 현재 파일의 앞 last_size 바이트 해시와
  -- 비교하면 옛 구간의 어떤 변경도 잡힌다. 선두 일부만 해시하면 그 뒤의 재기록을 놓친다.
  content_sha256 TEXT NOT NULL,
  archived_at   INTEGER NOT NULL,
  PRIMARY KEY (source_id, rel_path)
);
`;

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

// 버전별 단계 마이그레이션. 기존 v1 DB는 v1->v2만 밟는다. 멱등 (두 번 호출 OK).
export function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  let version = row.user_version;
  if (version < 1) {
    db.exec(DDL_V1);
    db.exec('PRAGMA user_version = 1');
    version = 1;
  }
  if (version < 2) {
    db.exec(DDL_V2);
    db.exec('PRAGMA user_version = 2');
  }
}
