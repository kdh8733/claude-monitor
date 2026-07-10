// M11 데모 시드. **완전 합성이다. 실데이터에서 파생되지 않았다** (003 축5, CLAUDE.md 1항).
//
// 익명화를 쓰지 않는 이유: 익명화는 실데이터를 입력으로 요구하므로 생성 스크립트·입력·중간
// 산출물이 전부 유출 경로가 된다. 그리고 "완전히 스크럽했다"는 증명이 불가능하다.
// 합성은 애초에 유출할 실데이터가 없다. 증명 부담이 뒤집히지 않는다.
//
// 프로젝트명은 발명한 것이다. 모델 ID 는 공개 정보다. 백분율은 형상만 흉내낸 것이지 실 캡처가 아니다.
import type { DatabaseSync } from 'node:sqlite';

/** 결정적 RNG. 같은 시드는 같은 데이터를 낸다 (스크린샷 재현성). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SeedSnapshot {
  t: number;
  fiveHour: number;
  weeklyAll: number;
  weeklyScoped: number;
  sessionResetsAt: string;
  weeklyResetsAt: string;
}
export interface SeedEvent {
  t: number;
  project: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cc5m: number;
  cc1h: number;
  sidechain: boolean;
}
export interface SeedRun { t: number; status: string }
export interface Seed {
  generatedFor: string;
  snapshots: SeedSnapshot[];
  events: SeedEvent[];
  runs: SeedRun[];
}

// 발명한 이름이다. 실 프로젝트에서 파생되지 않았다.
const PROJECTS = ['aurora-api', 'widget-shop', 'lantern-cli', 'harbor-etl'];
// 공개 모델 ID. 비밀이 아니다.
const MODELS = ['claude-opus-4-8', 'claude-fable-5', 'claude-haiku-4-5', 'claude-sonnet-5'];

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * 4주치 시드. 스냅샷은 15분 간격(픽스처 크기 때문에 실 수집기의 5분보다 성기다).
 * `endMs` 는 호출자가 준다 - 이 모듈은 시계를 읽지 않는다 (결정적이어야 하므로).
 */
export function generateSeed(endMs: number, seed = 20260709): Seed {
  const rnd = mulberry32(seed);
  // 4주 + 6일. 6일을 더하는 이유: 마지막 스냅샷이 주간 리셋 경계에 정확히 떨어지면
  // weekly_all 이 0 이 되어 "가장 먼저 차는 스코프"가 무의미해진다. 데모는 주 후반을 보여준다.
  const start = endMs - (4 * WEEK + 6 * DAY);
  const snapshots: SeedSnapshot[] = [];
  const runs: SeedRun[] = [];

  for (let t = start; t <= endMs; t += 15 * MIN) {
    // 주간 창: 리셋 경계에서 톱니가 생긴다 (완료 기준 2의 형상).
    const intoWeek = ((t - start) % WEEK) / WEEK;
    const weeklyResetsAt = new Date(t + (1 - intoWeek) * WEEK).toISOString();
    // 5시간 창: 하루 안에서 여러 번 톱니.
    const intoSession = ((t - start) % (5 * HOUR)) / (5 * HOUR);
    const sessionResetsAt = new Date(t + (1 - intoSession) * 5 * HOUR).toISOString();

    // 밤에는 거의 안 쓴다 -> 주간 곡선이 계단처럼 오른다.
    const hourUtc = new Date(t).getUTCHours();
    const active = hourUtc >= 1 && hourUtc <= 15 ? 1 : 0.15;

    const weeklyAll = clamp(intoWeek * 62 * (0.85 + 0.3 * rnd()), 0, 100);
    // Fable 스코프가 항상 먼저 찬다 - 이게 데모가 보여줘야 할 이야기다.
    const weeklyScoped = clamp(weeklyAll * 1.55 + 4 * rnd(), 0, 100);
    const fiveHour = clamp(intoSession * 70 * active * (0.7 + 0.6 * rnd()), 0, 100);

    snapshots.push({
      t,
      fiveHour: Math.round(fiveHour),
      weeklyAll: Math.round(weeklyAll),
      weeklyScoped: Math.round(weeklyScoped),
      sessionResetsAt,
      weeklyResetsAt,
    });
    // 밤 구간 일부는 토큰 만료로 건너뛴 것으로 모사한다 (auth_skip 은 실재하는 구멍이다).
    runs.push({ t, status: active < 1 && rnd() < 0.35 ? 'auth_skip' : 'ok' });
  }

  const events: SeedEvent[] = [];
  for (let t = start; t <= endMs; t += 20 * MIN) {
    const hourUtc = new Date(t).getUTCHours();
    if (hourUtc < 1 || hourUtc > 15) continue;
    if (rnd() < 0.45) continue;

    const model = pick(rnd, MODELS);
    const project = pick(rnd, PROJECTS);
    const sidechain = rnd() < 0.28;
    const scale = sidechain ? 0.4 : 1;
    events.push({
      t,
      project,
      model,
      input: Math.round((200 + rnd() * 3_000) * scale),
      output: Math.round((300 + rnd() * 4_000) * scale),
      cacheRead: Math.round((5_000 + rnd() * 90_000) * scale),
      cc5m: Math.round(rnd() * 12_000 * scale),
      cc1h: Math.round(rnd() * 20_000 * scale),
      sidechain,
    });
  }

  return { generatedFor: 'demo only - fully synthetic, not derived from real data', snapshots, events, runs };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const pick = <T,>(rnd: () => number, xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;

/**
 * 시드에서 스냅샷 응답 본문을 만든다. **실 응답과 같은 구조**여야 한다.
 * `limits[]` 원소의 소진율은 `utilization` 이 아니라 `percent` 다 (실측).
 */
export function seedRawJson(s: SeedSnapshot): string {
  return JSON.stringify({
    five_hour: { utilization: s.fiveHour, resets_at: s.sessionResetsAt, limit_dollars: null },
    seven_day: { utilization: s.weeklyAll, resets_at: s.weeklyResetsAt, limit_dollars: null },
    seven_day_opus: null,
    tangelo: null,
    extra_usage: { is_enabled: false },
    limits: [
      { kind: 'session', group: 'session', percent: s.fiveHour, severity: 'normal', resets_at: s.sessionResetsAt, scope: null, is_active: false },
      { kind: 'weekly_all', group: 'weekly', percent: s.weeklyAll, severity: 'normal', resets_at: s.weeklyResetsAt, scope: null, is_active: false },
      { kind: 'weekly_scoped', group: 'weekly', percent: s.weeklyScoped, severity: 'normal', resets_at: s.weeklyResetsAt, scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: true },
    ],
    spend: { enabled: false, percent: 0 },
    member_dashboard_available: false,
  });
}

/** 시드를 (이미 migrate 된) DB 에 적재한다. 데모 빌드는 이걸 in-memory DB 에 넣고 실 쿼리를 그대로 돈다. */
export function loadSeed(db: DatabaseSync, seed: Seed): void {
  const insSnap = db.prepare('INSERT INTO snapshot (captured_at, raw_json) VALUES (?, ?)');
  const insRun = db.prepare(`INSERT INTO collector_run (started_at, kind, status) VALUES (?, 'snapshot', ?)`);
  const insEvt = db.prepare(`
    INSERT INTO usage_event (message_id, captured_at, source_id, session_id, cwd, git_branch, model,
      service_tier, speed, is_sidechain, request_id, input_tokens, output_tokens,
      cache_read_input_tokens, cache_creation_input_tokens, cache_creation_5m_tokens,
      cache_creation_1h_tokens, raw_usage_json)
    VALUES (?, ?, 'demo', ?, ?, 'main', ?, 'standard', 'standard', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  db.exec('BEGIN');
  for (const s of seed.snapshots) insSnap.run(s.t, seedRawJson(s));
  for (const r of seed.runs) insRun.run(r.t, r.status);
  seed.events.forEach((e, i) => {
    const cc = e.cc5m + e.cc1h;
    insEvt.run(
      `msg_demo_${i}`, e.t, `sess_demo_${i % 40}`, `/demo/workspace/${e.project}/src`, e.model,
      e.sidechain ? 1 : 0, `req_demo_${i}`,
      e.input, e.output, e.cacheRead, cc, e.cc5m, e.cc1h,
      JSON.stringify({ input_tokens: e.input, output_tokens: e.output }),
    );
  });
  db.exec('COMMIT');
}
