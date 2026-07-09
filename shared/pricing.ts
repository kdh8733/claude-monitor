// M7 단가표. 시점 버전을 갖는다 (CLAUDE.md 5항: 과거 데이터는 당시 단가로 계산).
//
// 왜 DB 테이블이 아니라 TS 상수인가 (004 C1):
//   Vercel 데모 빌드에는 수집기도 SQLite 도 없다. 단가가 수집기가 시딩하는 테이블에만
//   살면 데모 화면은 API 환산가치를 계산할 수 없다. 단가는 코드와 함께 커밋되는 것이어야 한다.
//   부수 효과로 git diff 가 단가 개정의 감사 로그가 된다.
//
// 왜 캐시 단가를 표에 굳히지 않는가:
//   캐시 요금은 base input 의 배수다. 배수를 표에 복제하면 모델이 늘 때마다 틀릴 자리가 5개 생긴다.
//
// **환산가치는 청구액이 아니다** (CLAUDE.md 6항). 이 구독은 정액제다.

/** base input 대비 배수. 출처: Anthropic prompt caching 문서. */
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;
const CACHE_READ_MULTIPLIER = 0.1;

export interface PriceRow {
  model: string;
  /** `message.usage.speed`. 구버전 기록에는 필드가 없다 - NULL 은 'standard' 로 해석한다. */
  speed: string;
  serviceTier: string;
  /** 이 시각부터 유효 (UTC ms). 0 = 최초 관측 이래. */
  effectiveFrom: number;
  inputPerMTok: number;
  outputPerMTok: number;
}

const D = (iso: string): number => Date.parse(iso);

/**
 * 트랜스크립트는 모델을 별칭이 아니라 날짜 붙은 전체 ID 로 기록하기도 한다 (실측: haiku 만).
 * 접두사 매칭으로 추측하지 않는다 - 모르는 ID 는 모른다고 답해야 한다.
 * 새 날짜 ID 가 관측되면 여기에 명시적으로 추가하라.
 */
const MODEL_ALIASES: Record<string, string> = {
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5',
};

// 확인: 2026-07-09, Anthropic 공식 모델/단가 문서.
//
// 미확인: 각 모델의 **최초 발효일**. 아래 effectiveFrom=0 행은 "우리가 관측한 전 구간에서
// 이 단가였다"는 가정이다. 이 프로젝트 데이터 구간(2026-05-08~)에 가격 개정이 있었다면 틀린다.
// 개정 이력을 찾으면 행을 추가하라 - 기존 행을 고치지 마라 (과거 계산이 바뀐다).
export const PRICES: PriceRow[] = [
  { model: 'claude-opus-4-8',   speed: 'standard', serviceTier: 'standard', effectiveFrom: 0, inputPerMTok: 5,  outputPerMTok: 25 },
  { model: 'claude-opus-4-7',   speed: 'standard', serviceTier: 'standard', effectiveFrom: 0, inputPerMTok: 5,  outputPerMTok: 25 },
  { model: 'claude-opus-4-6',   speed: 'standard', serviceTier: 'standard', effectiveFrom: 0, inputPerMTok: 5,  outputPerMTok: 25 },
  { model: 'claude-fable-5',    speed: 'standard', serviceTier: 'standard', effectiveFrom: 0, inputPerMTok: 10, outputPerMTok: 50 },
  { model: 'claude-haiku-4-5',  speed: 'standard', serviceTier: 'standard', effectiveFrom: 0, inputPerMTok: 1,  outputPerMTok: 5 },
  { model: 'claude-sonnet-4-6', speed: 'standard', serviceTier: 'standard', effectiveFrom: 0, inputPerMTok: 3,  outputPerMTok: 15 },

  // Sonnet 5 는 시점 버전의 실증이다. 도입가가 2026-08-31 까지, 그 뒤 표준가.
  // **이 프로젝트의 데이터 구간(2026-05-08 ~)은 전부 도입가 구간이다.**
  // 현재가로 소급 계산하면 Sonnet 5 이벤트가 50% 과대평가된다.
  { model: 'claude-sonnet-5', speed: 'standard', serviceTier: 'standard', effectiveFrom: 0,                          inputPerMTok: 2, outputPerMTok: 10 },
  { model: 'claude-sonnet-5', speed: 'standard', serviceTier: 'standard', effectiveFrom: D('2026-09-01T00:00:00Z'), inputPerMTok: 3, outputPerMTok: 15 },
];

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  /**
   * `message.usage.cache_creation_input_tokens`. 실측(15,921건)상 항상 5m + 1h 와 같다.
   * 주면 정합성을 검사한다. 분해되지 않은 잔여분이 있으면 어느 배수를 곱할지 모르므로
   * null(모른다)을 낸다. 조용히 $0 으로 과소계상하지 않는다.
   */
  cacheCreationInputTokens?: number;
}

/**
 * 이벤트 시각에 유효했던 단가를 찾는다. 없으면 null.
 *
 * null 은 0 이 아니다. 모르는 모델이나 `/fast` 처럼 단가를 확인하지 못한 speed 는
 * "공짜"가 아니라 "모른다"다. 호출자가 UI 에 그렇게 표시해야 한다.
 */
export function findPrice(
  model: string | null,
  speed: string | null,
  serviceTier: string | null,
  atMs: number,
): PriceRow | null {
  if (model === null) return null;
  const m = MODEL_ALIASES[model] ?? model;
  // 구버전 기록에는 speed/service_tier 가 없다. 당시엔 standard 뿐이었다.
  const s = speed ?? 'standard';
  const t = serviceTier ?? 'standard';

  let best: PriceRow | null = null;
  for (const row of PRICES) {
    if (row.model !== m || row.speed !== s || row.serviceTier !== t) continue;
    if (row.effectiveFrom > atMs) continue;
    if (best === null || row.effectiveFrom > best.effectiveFrom) best = row;
  }
  return best;
}

/** API 환산가치(USD). 단가를 모르면 null. **실제 청구액이 아니다.** */
export function apiEquivalentUsd(
  model: string | null,
  speed: string | null,
  serviceTier: string | null,
  atMs: number,
  tokens: TokenCounts,
): number | null {
  // cache_creation 이 5m/1h 로 분해되지 않았으면 어느 배수를 곱할지 모른다.
  // 조용히 $0 으로 과소계상하느니 모른다고 답한다.
  if (tokens.cacheCreationInputTokens !== undefined
    && tokens.cacheCreationInputTokens > tokens.cacheCreation5mTokens + tokens.cacheCreation1hTokens) {
    return null;
  }

  // 토큰이 하나도 없으면 단가를 몰라도 비용은 0 이다. Claude Code 가 만드는 `<synthetic>`
  // 메시지가 여기 해당한다 (실측: 토큰 전부 0). 이걸 "단가 미상"으로 세면 잡음만 늘어난다.
  const total = tokens.inputTokens + tokens.outputTokens + tokens.cacheReadInputTokens
    + tokens.cacheCreation5mTokens + tokens.cacheCreation1hTokens;
  if (total === 0) return 0;

  const price = findPrice(model, speed, serviceTier, atMs);
  if (price === null) return null;

  const perTok = price.inputPerMTok / 1_000_000;
  const outPerTok = price.outputPerMTok / 1_000_000;
  return (
    tokens.inputTokens * perTok
    + tokens.outputTokens * outPerTok
    + tokens.cacheReadInputTokens * perTok * CACHE_READ_MULTIPLIER
    + tokens.cacheCreation5mTokens * perTok * CACHE_WRITE_5M_MULTIPLIER
    + tokens.cacheCreation1hTokens * perTok * CACHE_WRITE_1H_MULTIPLIER
  );
}
