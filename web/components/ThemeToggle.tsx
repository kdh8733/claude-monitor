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

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`${visible} 테마로 전환`}
      className="micro rounded-md border border-hairline px-2.5 py-1.5 hover:bg-page"
    >
      {visible}
    </button>
  );
}
