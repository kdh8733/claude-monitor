'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * 컨테이너 실측 폭. SSR/첫 페인트는 fallback 폭으로 그리고(정적 export 에서도 차트가 보인다),
 * 마운트 후 실제 폭으로 다시 그린다. SVG 는 width="100%" 라 전환은 스케일 보정일 뿐이다.
 */
export function useMeasure(fallback = 720): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined && w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width];
}
