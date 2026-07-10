'use client';

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

export function ThemeToggle() {
  // SSR 에서는 테마를 모른다 - 마운트 후 실제 상태를 읽는다 (hydration mismatch 방지).
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const attr = document.documentElement.dataset.theme;
    if (attr === 'dark' || attr === 'light') setTheme(attr);
    else setTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }, []);

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('cm-theme', next);
    } catch {
      /* localStorage 불가 환경(프라이빗 모드 등)에서는 이번 세션만 적용 */
    }
    setTheme(next);
  }

  // 보이는 글자가 접근 가능한 이름에 포함되어야 한다 (음성 제어 사용자가 보이는 대로 말한다).
  // "DARK" 버튼의 이름이 "다크 테마로 전환" 이면 그 이름을 말할 수 없다.
  const visible = theme === null ? 'THEME' : theme === 'dark' ? 'LIGHT' : 'DARK';

  // 호버/포커스 어포던스: 텍스트는 mute -> ink (더 진해진다 - 대비를 깨지 않는다),
  // 테두리는 hairline -> ink2. 키보드 사용자에게는 focus-visible 링으로 같은 신호를 준다.
  // 색 전환은 transition-colors 뿐이라 prefers-reduced-motion 에서도 무해하지만, 존중해 끈다.
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`${visible} 테마로 전환`}
      className="micro rounded-md border border-hairline px-2.5 py-1.5 transition-colors motion-reduce:transition-none hover:border-ink2 hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {visible}
    </button>
  );
}
