// 대시보드 데이터 계층. RSC 전용 - 클라이언트로는 이 모듈이 아니라 직렬화된 결과만 간다.
//
// 두 모드, 집계 구현은 하나 (003 축 3):
//   demo(기본) - fixtures/demo/seed.json 을 in-memory SQLite 에 migrate()+loadSeed() 로 넣고
//                shared/queries 를 그대로 돈다. data/ 를 한 번도 열지 않는다.
//   live       - data/usage.sqlite 를 **읽기 전용**으로 연다. 파일이 없으면 열기가 실패한다
//                (fail-loud, 003 축 3의 3차 방벽). 쓰기 시도는 여기서 터진다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../collector/db.ts';
import { loadSeed, type Seed } from '../../shared/demo-seed.ts';
import {
  abandonedHeadroom,
  attributionByModel,
  attributionByProject,
  collectionGaps,
  headroomSeries,
  hourlyUsage,
  latestCapturedAt,
  scopeRanking,
  type CollectionGaps,
  type HeadroomPoint,
  type HeadroomSummary,
  type HourlyUsage,
  type ModelAttribution,
  type ProjectAttribution,
  type ScopeRank,
} from '../../shared/queries.ts';

export type Mode = 'demo' | 'live';

/** 기본값은 데모다. 실데이터는 명시적 opt-in 으로만 (완료 기준 6). */
export const MODE: Mode = process.env.CLAUDE_MONITOR_MODE === 'live' ? 'live' : 'demo';

const DAY = 24 * 60 * 60 * 1000;
const RANGE_DAYS = 28;

export interface DashboardData {
  mode: Mode;
  /** 시간 앵커 = 최신 스냅샷 시각. 벽시계가 아니다 - 데모는 결정적, 라이브는 "수집된 마지막 시점". */
  anchorMs: number;
  fromMs: number;
  rangeDays: number;
  headroom: HeadroomSummary;
  series: HeadroomPoint[];
  scopes: ScopeRank[];
  projects: ProjectAttribution[];
  models: ModelAttribution[];
  hourly: HourlyUsage[];
  gaps: CollectionGaps;
  /** 구간 합계. null = 단가 미상 이벤트 포함("모른다"이지 0이 아니다). **청구액이 아니다** (CLAUDE.md 6항). */
  apiEquivalentUsd: number | null;
}

function openDb(): { db: DatabaseSync; roots: string[] } {
  if (MODE === 'live') {
    const path = process.env.CLAUDE_MONITOR_DB ?? join(process.cwd(), 'data', 'usage.sqlite');
    // readOnly: 파일이 없으면 실패한다. 조용한 빈 화면이 아니라 빌드/요청 에러로 터져야 한다.
    const db = new DatabaseSync(path, { readOnly: true });
    const roots = (process.env.CLAUDE_MONITOR_ROOTS ?? '/root/workspace').split(':');
    return { db, roots };
  }
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const seed = JSON.parse(
    readFileSync(join(process.cwd(), 'fixtures', 'demo', 'seed.json'), 'utf8'),
  ) as Seed;
  loadSeed(db, seed);
  return { db, roots: ['/demo/workspace'] };
}

export function getDashboardData(): DashboardData {
  const { db, roots } = openDb();
  try {
    const anchorMs = latestCapturedAt(db);
    if (anchorMs === null) {
      throw new Error(
        MODE === 'live'
          ? '스냅샷이 0건입니다. 수집기가 아직 적재하지 않았습니다 (collector/main.ts 참조).'
          : '데모 시드가 비어 있습니다. fixtures/demo/seed.json 을 확인하세요.',
      );
    }
    const fromMs = anchorMs - RANGE_DAYS * DAY;
    const toMs = anchorMs + 1; // 반open [from, to) - 앵커 스냅샷 포함

    const projects = attributionByProject(db, fromMs, toMs, roots);
    let apiEquivalentUsd: number | null = 0;
    for (const p of projects) {
      if (p.apiEquivalentUsd === null) {
        apiEquivalentUsd = null; // 부분합은 거짓말이다
        break;
      }
      apiEquivalentUsd += p.apiEquivalentUsd;
    }

    return {
      mode: MODE,
      anchorMs,
      fromMs,
      rangeDays: RANGE_DAYS,
      headroom: abandonedHeadroom(db, fromMs, toMs),
      series: headroomSeries(db, fromMs, toMs),
      scopes: scopeRanking(db, anchorMs),
      projects,
      models: attributionByModel(db, fromMs, toMs),
      hourly: hourlyUsage(db, fromMs, toMs),
      gaps: collectionGaps(db, fromMs, toMs),
      apiEquivalentUsd,
    };
  } finally {
    db.close();
  }
}
