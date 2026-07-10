'use client';

// LLM 분석용 export 버튼. 리포트 본문은 서버(shared/report.ts, 순수 함수)가 만들고
// 여기는 전달만 한다 - 클라이언트는 시계도 데이터도 읽지 않는다.
//
// 복사 실패는 조용히 넘어가지 않는다: clipboard API 가 없거나(HTTP) 거부되면
// textarea 폴백을 열어 수동 복사하게 하고, 성공/실패를 aria-live 로도 알린다.
import { useEffect, useRef, useState } from 'react';

export function ReportActions({
  markdown,
  json,
  filename,
}: {
  markdown: string;
  json: string;
  filename: string;
}) {
  const [status, setStatus] = useState('');
  const [showFallback, setShowFallback] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (showFallback) textareaRef.current?.select();
  }, [showFallback]);

  async function copyReport() {
    try {
      await navigator.clipboard.writeText(markdown);
      setShowFallback(false);
      setStatus('리포트가 클립보드에 복사되었습니다. LLM 대화창에 붙여넣으세요.');
    } catch {
      // 권한 거부 또는 clipboard API 부재(HTTP). 실패를 말하고 수동 경로를 연다.
      setShowFallback(true);
      setStatus('클립보드 접근이 막혀 있습니다. 아래 텍스트를 전체 선택해 직접 복사하세요.');
    }
  }

  function downloadJson() {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`${filename} 다운로드를 시작했습니다.`);
  }

  const buttonClass =
    'micro rounded-md border border-hairline px-2.5 py-1.5 transition-colors motion-reduce:transition-none ' +
    'hover:border-ink2 hover:bg-surface hover:text-ink ' +
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={copyReport} className={buttonClass}>
          리포트 복사
        </button>
        <button type="button" onClick={downloadJson} className={buttonClass}>
          JSON 다운로드
        </button>
        <span className="text-xs text-ink2" role="status" aria-live="polite">
          {status}
        </span>
      </div>
      {showFallback && (
        <textarea
          ref={textareaRef}
          readOnly
          value={markdown}
          aria-label="리포트 마크다운 (수동 복사용)"
          rows={10}
          className="mt-2 w-full rounded-md border border-hairline bg-surface p-2.5 font-mono text-xs text-ink2"
          onFocus={(e) => e.currentTarget.select()}
        />
      )}
    </div>
  );
}
