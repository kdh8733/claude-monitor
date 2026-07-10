// shadcn CLI 없이 직접 쓴 얇은 카드. (M9 보고: shadcn 컴포넌트는 카드뿐이라 CLI 도입이 과했다)
export function Card({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-hairline bg-surface p-5 ${className}`}>
      {children}
    </section>
  );
}

/** 패널 머리: 질문 번호 각인 + 질문 그 자체가 제목이다 (003 축 6 레이아웃 C). */
export function PanelHeading({ kicker, title }: { kicker: string; title: string }) {
  return (
    <header className="mb-4">
      <p className="micro">{kicker}</p>
      <h2 className="mt-1 text-lg font-semibold leading-snug">{title}</h2>
    </header>
  );
}
