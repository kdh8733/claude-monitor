import type { Metadata } from 'next';
import { IBM_Plex_Sans_KR, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

// 계기판 성격의 타이포: Plex Sans KR(한글 본문/헤드라인) + Plex Mono(수치 라벨·각인).
const plexKr = IBM_Plex_Sans_KR({
  weight: ['400', '600', '700'],
  subsets: ['latin'],
  variable: '--font-plex-kr',
  display: 'swap',
});
const plexMono = IBM_Plex_Mono({
  weight: ['400', '600'],
  subsets: ['latin'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'claude-monitor',
  description: 'Claude Max 한도 소진율과 사용 귀속의 장기 기록',
};

// 저장된 테마를 첫 페인트 전에 적용한다. 저장값이 없으면 attr 를 두지 않아 media query 가 지배한다.
const themeInit = `(function(){try{var t=localStorage.getItem('cm-theme');if(t==='dark'||t==='light'){document.documentElement.dataset.theme=t}}catch(e){}})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className={`${plexKr.variable} ${plexMono.variable} font-sans bg-page text-ink antialiased`}>
        {children}
      </body>
    </html>
  );
}
