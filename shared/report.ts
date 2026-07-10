// LLM 분석용 통계 리포트. **순수 함수다** - 시계를 읽지 않는다 (Date.now 금지).
// 앵커 시각은 입력으로 받고, 같은 입력이면 같은 출력이다 (report.test.ts 6).
//
// 입력은 web/lib/data.ts 가 이미 만든 집계 결과다. 여기서 쿼리를 다시 짜지 않는다.
// 마크다운은 사람이 LLM 에 붙여넣는 용도 - 짧은 헤더 + 표, 3,000자 안쪽 목표.
// JSON 은 기계용 - JSON.parse(JSON.stringify(x)) 라운드트립을 통과해야 한다.
import {
  billableTokens,
  type CollectionGaps,
  type HeadroomSummary,
  type ModelAttribution,
  type ProjectAttribution,
  type ScopeRank,
} from './queries.ts';

export interface ReportInput {
  mode: 'demo' | 'live';
  /** 최신 스냅샷 시각 (UTC ms). 시간 앵커 - 벽시계가 아니다. */
  anchorMs: number;
  fromMs: number;
  rangeDays: number;
  headroom: HeadroomSummary;
  scopes: ScopeRank[];
  projects: ProjectAttribution[];
  models: ModelAttribution[];
  gaps: CollectionGaps;
  /** 구간 합계. null = 단가 미상 이벤트 포함 ("모른다"이지 0 이 아니다). */
  apiEquivalentUsd: number | null;
}

// 정의 문구는 한 곳에서 소유한다 - 마크다운과 JSON 이 서로 다른 정의를 말하면 안 된다.
const DEF_BILLABLE = 'billable 토큰 = input + output + cache_creation (cache_read 제외)';
const DEF_HEADROOM = '버려진 헤드룸 = 100% - weekly_all 구간 평균';
const DISCLAIMER = 'API 환산가치는 실제 청구액이 아니다. 이 구독은 정액제다.';

const utcMinute = (ms: number): string => {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
};

/** ISO 문자열을 분 단위로 줄인다. 파싱 불능이면 원문 그대로 (정보를 버리지 않는다). */
const isoMinute = (iso: string): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : utcMinute(ms);
};

const n = (v: number): string => v.toLocaleString('en-US');

/** null 은 0 이 아니다 - "미상"으로 쓴다 (CLAUDE.md 6항 정신). */
const usd = (v: number | null): string => (v === null ? '미상' : `$${v.toFixed(2)}`);

const pct = (v: number | null): string => (v === null ? '미상' : `${v.toFixed(0)}%`);

/**
 * 라벨 방어선: 절대경로가 라벨로 들어와도 마지막 세그먼트만 내보낸다.
 * projectLabel 이 이미 상대화하지만, 리포트는 복사되어 밖으로 나가는 산출물이라 이중으로 막는다.
 */
function sanitizeLabel(label: string): string {
  if (!label.startsWith('/')) return label;
  const segments = label.split('/').filter((s) => s !== '');
  return segments.length > 0 ? segments[segments.length - 1] : '<unknown>';
}

interface AttributionRow {
  label: string;
  billable: number;
  apiEquivalentUsd: number | null;
}

/** billable 내림차순 상위 keep 개 + 나머지는 "기타 (N개)" 로 접는다. null 오염은 접힌 합에도 전파된다. */
function foldRows(rows: AttributionRow[], keep = 10): AttributionRow[] {
  const sorted = [...rows].sort((a, b) => b.billable - a.billable);
  if (sorted.length <= keep) return sorted;
  const kept = sorted.slice(0, keep);
  const rest = sorted.slice(keep);
  let restUsd: number | null = 0;
  for (const r of rest) {
    if (r.apiEquivalentUsd === null) {
      restUsd = null;
      break;
    }
    restUsd += r.apiEquivalentUsd;
  }
  kept.push({
    label: `기타 (${rest.length}개)`,
    billable: rest.reduce((s, r) => s + r.billable, 0),
    apiEquivalentUsd: restUsd,
  });
  return kept;
}

function projectRows(input: ReportInput): AttributionRow[] {
  return foldRows(
    input.projects.map((p) => ({
      label: sanitizeLabel(p.project),
      billable: billableTokens(p),
      apiEquivalentUsd: p.apiEquivalentUsd,
    })),
  );
}

function modelRows(input: ReportInput): AttributionRow[] {
  return foldRows(
    input.models.map((m) => ({
      label: m.model ?? '(모델 미상)',
      billable: billableTokens(m),
      apiEquivalentUsd: m.apiEquivalentUsd,
    })),
  );
}

/** 기계용 리포트. 값은 가공하지 않고 구조와 정의만 붙인다. */
export function buildReportJson(input: ReportInput): object {
  return {
    tool: 'claude-monitor',
    mode: input.mode,
    syntheticSeed: input.mode === 'demo',
    window: {
      fromUtc: new Date(input.fromMs).toISOString(),
      toUtc: new Date(input.anchorMs).toISOString(),
      rangeDays: input.rangeDays,
    },
    definitions: {
      billableTokens: DEF_BILLABLE,
      abandonedHeadroom: DEF_HEADROOM,
      disclaimer: DISCLAIMER,
    },
    headroom: {
      samples: input.headroom.samples,
      meanUtilizationPct: input.headroom.meanUtilization,
      abandonedPct: input.headroom.abandonedPct,
    },
    scopes: input.scopes.map((s) => ({
      kind: s.kind,
      percent: s.percent,
      isActive: s.isActive,
      resetsAt: s.resetsAt,
      scopeModel: s.scopeModel,
    })),
    attribution: {
      projects: projectRows(input),
      models: modelRows(input),
    },
    collection: {
      ok: input.gaps.ok,
      failed: input.gaps.failed,
      authSkipSlots: input.gaps.authSkip,
      gapPct: input.gaps.gapPct,
    },
    apiEquivalentUsdTotal: input.apiEquivalentUsd,
  };
}

/** LLM 붙여넣기용 마크다운. 짧은 헤더 + 표. */
export function buildReportMarkdown(input: ReportInput): string {
  const lines: string[] = [];
  const h = input.headroom;

  lines.push('# claude-monitor 사용 리포트');
  lines.push('');
  lines.push(
    input.mode === 'demo'
      ? '- 모드: demo (완전 합성 시드 - 실데이터 아님)'
      : '- 모드: live (실측 데이터)',
  );
  lines.push(
    `- 관측 구간 (UTC): ${utcMinute(input.fromMs)} ~ ${utcMinute(input.anchorMs)} (${input.rangeDays}일)`,
  );
  lines.push(`- 스냅샷 샘플: ${n(h.samples)}`);
  lines.push(`- 정의: ${DEF_BILLABLE}`);
  lines.push(`- 정의: ${DEF_HEADROOM}`);
  lines.push('');

  lines.push('## 헤드룸');
  if (h.abandonedPct === null || h.meanUtilization === null) {
    lines.push('- 구간에 스냅샷이 없어 계산 불가 (0 이 아니라 미상이다)');
  } else {
    lines.push(
      `- 버려진 헤드룸: ${h.abandonedPct.toFixed(1)}% (weekly_all 구간 평균 ${h.meanUtilization.toFixed(1)}%)`,
    );
  }
  lines.push('');

  lines.push('## 스코프 순위 (마지막 스냅샷 기준)');
  if (input.scopes.length === 0) {
    lines.push('- limits[] 비어 있음');
  } else {
    lines.push('| # | kind | 소진율 | is_active | 리셋 (UTC) | 스코프 모델 |');
    lines.push('|--:|------|-------:|-----------|------------|-------------|');
    input.scopes.forEach((s, i) => {
      lines.push(
        `| ${i + 1} | ${s.kind} | ${pct(s.percent)} | ${s.isActive ? 'yes' : 'no'} | ${
          s.resetsAt === null ? '-' : isoMinute(s.resetsAt)
        } | ${s.scopeModel ?? '-'} |`,
      );
    });
  }
  lines.push('');

  const attribution = (title: string, head: string, rows: AttributionRow[]) => {
    lines.push(`## ${title}`);
    if (rows.length === 0) {
      lines.push('- 구간에 이벤트 없음');
    } else {
      lines.push(`| ${head} | billable 토큰 | API 환산가치 |`);
      lines.push('|------|--------------:|-------------:|');
      for (const r of rows) lines.push(`| ${r.label} | ${n(r.billable)} | ${usd(r.apiEquivalentUsd)} |`);
    }
    lines.push('');
  };
  attribution('프로젝트별 귀속', '프로젝트', projectRows(input));
  attribution('모델별 귀속', '모델', modelRows(input));

  lines.push(`- API 환산가치 합계: ${usd(input.apiEquivalentUsd)}`);
  lines.push('');

  lines.push('## 수집 상태');
  lines.push(
    `- 결손율: ${input.gaps.gapPct.toFixed(1)}% (실패 ${n(input.gaps.failed)} / 발화 ${n(input.gaps.ok + input.gaps.failed)})`,
  );
  lines.push(
    `- auth_skip 슬롯: ${n(input.gaps.authSkip)}개 - 토큰 만료로 수집을 건너뛴 구간. 데이터에 실제로 뚫린 구멍이다.`,
  );
  lines.push('');

  lines.push('## 면책');
  lines.push(`${DISCLAIMER} 같은 사용량을 API 종량제 단가로 환산한 참고 수치일 뿐이다.`);
  lines.push('');

  return lines.join('\n');
}
