'use client';

// 탭은 URL 없이 클라이언트 상태다 (output: export 라 라우트를 늘리지 않는다).
// 모든 패널은 서버에서 렌더되어 props 로 들어온다 - 비활성 패널은 hidden 일 뿐 HTML 에 존재한다.
// 카나리가 index.html 에서 기본 탭의 문자열을 찾는 전제가 그래서 유지된다.
//
// WAI-ARIA tabs 패턴: 좌우 화살표 + Home/End 로 이동, 이동 즉시 활성화(automatic activation),
// 비활성 탭은 roving tabindex 로 탭 순서에서 빠진다.
import { useRef, useState } from 'react';

export interface TabDef {
  id: string;
  label: string;
  content: React.ReactNode;
}

export function Tabs({ tabs, listLabel }: { tabs: TabDef[]; listLabel: string }) {
  const [active, setActive] = useState(tabs[0]?.id ?? '');
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());

  function activate(id: string) {
    setActive(id);
    buttonRefs.current.get(id)?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next !== null) {
      e.preventDefault();
      activate(tabs[next].id);
    }
  }

  return (
    <>
      <div
        role="tablist"
        aria-label={listLabel}
        className="mb-6 flex gap-1 border-b border-hairline"
      >
        {tabs.map((t, i) => {
          const selected = active === t.id;
          return (
            <button
              key={t.id}
              ref={(el) => {
                if (el === null) buttonRefs.current.delete(t.id);
                else buttonRefs.current.set(t.id, el);
              }}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(t.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={`-mb-px border-b-2 px-3.5 py-2.5 text-sm transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                selected
                  ? 'border-accent font-semibold text-ink'
                  : 'border-transparent text-ink2 hover:border-baseline hover:text-ink'
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`panel-${t.id}`}
          aria-labelledby={`tab-${t.id}`}
          hidden={active !== t.id}
        >
          {t.content}
        </div>
      ))}
    </>
  );
}
