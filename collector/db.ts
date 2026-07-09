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

// M5 파서 산출. grain = message.id (004 C2: 라인을 SUM 하면 output 2.5~3.0배 과대계상).
// dedup 은 종단(=최대 output) usage 승리 - 전수 실측상 output 단조 비감소, 종단 == max 100%.
// raw_usage_json 이 usage 의 진실 (server_tool_use 등 미승격 필드 보존, CLAUDE.md 3항).
const DDL_V3 = `
CREATE TABLE usage_event (
  message_id    TEXT PRIMARY KEY,        -- 전역 유일. dedup·정체성 키 (004 C2)
  captured_at   INTEGER NOT NULL,        -- 라인 timestamp 를 UTC ms 로. 단가·윈도우 조회축
  source_id     TEXT NOT NULL,           -- 'wsl' | 'windows'. provenance (정체성 불참여)
  session_id    TEXT,                    -- 귀속 그룹핑용. dedup 키가 아니다
  cwd           TEXT,                    -- 프로젝트 귀속에 필수
  git_branch    TEXT,
  model         TEXT,
  service_tier  TEXT,
  speed         TEXT,                    -- NULL 가능 (구버전 기록). 단가 차원 (004 C4)
  is_sidechain  INTEGER,                 -- 서브에이전트 판별
  request_id    TEXT,
  input_tokens                INTEGER NOT NULL DEFAULT 0,
  output_tokens               INTEGER NOT NULL DEFAULT 0,
  cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_5m_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_creation_1h_tokens    INTEGER NOT NULL DEFAULT 0,
  raw_usage_json TEXT NOT NULL           -- message.usage 원본 verbatim
);
CREATE INDEX ix_ue_captured ON usage_event(captured_at);
CREATE INDEX ix_ue_model    ON usage_event(model);
CREATE INDEX ix_ue_session  ON usage_event(session_id);
CREATE INDEX ix_ue_source   ON usage_event(source_id);

-- 파싱 부기. 아카이브는 불변이거나 통째로 갱신되므로 mtime 으로 재파싱 여부를 판단한다.
CREATE TABLE parsed_archive (
  archive_path TEXT PRIMARY KEY,   -- archiveRoot 기준 상대경로
  mtime_ms     INTEGER NOT NULL,
  parsed_at    INTEGER NOT NULL
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
    version = 2;
  }
  if (version < 3) {
    db.exec(DDL_V3);
    db.exec('PRAGMA user_version = 3');
  }
}
