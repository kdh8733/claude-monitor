// 차트 색 역할 배정. 실제 값은 globals.css 의 토큰이 소유한다 - 여기는 역할 이름뿐.
// validate_palette.js 통과 세트 (라이트 PASS, 다크 PASS - WARN 릴리프는 라벨·표 뷰·갭).

/** categorical 슬롯. 고정 순서 - 엔티티(알파벳순 인덱스)를 따라가고, 절대 순환하지 않는다. */
export const SERIES_VARS = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
] as const;

/** sequential 6단계 (히트맵). 다크 모드 뒤집기는 CSS 변수가 처리한다. */
export const SEQ_VARS = [
  'var(--seq-1)',
  'var(--seq-2)',
  'var(--seq-3)',
  'var(--seq-4)',
  'var(--seq-5)',
  'var(--seq-6)',
] as const;

/**
 * 게이지/미터의 채움색: 심각도를 입는다 (accent -> warning >=75 -> critical >=90).
 * status 색은 예약 - 시리즈 정체성으로 재사용하지 않는다.
 */
export function severityColor(percent: number): string {
  if (percent >= 90) return 'var(--status-critical)';
  if (percent >= 75) return 'var(--status-warning)';
  return 'var(--accent)';
}
