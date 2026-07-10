'use client';

// 귀속 상세 탭의 정렬 가능한 표. 데이터는 서버가 집계해 직렬화된 행으로 준다.
// 숫자는 tabular-nums 우측 정렬, 정렬 상태는 aria-sort 로 노출한다.
// 환산가치 null 은 "미상"이다 - 0 으로 그리지 않는다 (CLAUDE.md 6항 정신).
import { useState } from 'react';

export interface AttributionRow {
  label: string;
  events: number;
  /** 서브에이전트(sidechain) 이벤트 수. 모델별 집계에는 없다 (null = 열 자체를 숨긴다). */
  sidechainEvents: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  billable: number;
  apiEquivalentUsd: number | null;
}

type SortKey = keyof Omit<AttributionRow, 'sidechainEvents'> | 'sidechainEvents';

const COLUMNS: Array<{ key: SortKey; label: string; numeric: boolean }> = [
  { key: 'label', label: '', numeric: false }, // label 은 unitLabel 로 채운다
  { key: 'billable', label: 'billable', numeric: true },
  { key: 'inputTokens', label: 'input', numeric: true },
  { key: 'outputTokens', label: 'output', numeric: true },
  { key: 'cacheReadTokens', label: 'cache read', numeric: true },
  { key: 'cacheCreationTokens', label: 'cache write', numeric: true },
  { key: 'events', label: 'events', numeric: true },
  { key: 'sidechainEvents', label: 'sidechain', numeric: true },
  { key: 'apiEquivalentUsd', label: 'API 환산가치', numeric: true },
];

const fmt = (v: number) => v.toLocaleString('en-US');

export function AttributionTable({
  rows,
  unitLabel,
}: {
  rows: AttributionRow[];
  unitLabel: string;
}) {
  const [sortKey, setSortKey] = useState<SortKey>('billable');
  const [desc, setDesc] = useState(true);

  const hasSidechain = rows.some((r) => r.sidechainEvents !== null);
  const columns = COLUMNS.filter((c) => c.key !== 'sidechainEvents' || hasSidechain);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setDesc((d) => !d);
    else {
      setSortKey(key);
      setDesc(key !== 'label'); // 숫자는 내림차순, 라벨은 오름차순이 첫 클릭의 기대다
    }
  }

  const sorted = [...rows].sort((a, b) => {
    const va = a[sortKey];
    const vb = b[sortKey];
    let cmp: number;
    if (typeof va === 'string' && typeof vb === 'string') cmp = va < vb ? -1 : va > vb ? 1 : 0;
    else {
      // null(미상)은 정렬상 항상 끝으로 보낸다 - 0 과 같은 자리에 두지 않는다.
      const na = va === null ? -Infinity : (va as number);
      const nb = vb === null ? -Infinity : (vb as number);
      cmp = na - nb;
    }
    return desc ? -cmp : cmp;
  });

  if (rows.length === 0) {
    return <p className="text-sm text-mute">이 구간에는 이벤트가 없습니다.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sortKey === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={active ? (desc ? 'descending' : 'ascending') : undefined}
                  className={`border-b border-grid p-0 ${c.numeric ? 'text-right' : 'text-left'}`}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(c.key)}
                    className={`w-full px-2 py-1.5 font-semibold transition-colors motion-reduce:transition-none hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                      c.numeric ? 'text-right' : 'text-left'
                    } ${active ? 'text-ink' : 'text-ink2'}`}
                  >
                    {c.key === 'label' ? unitLabel : c.label}
                    <span aria-hidden className="ml-1 inline-block w-2 text-mute">
                      {active ? (desc ? '▾' : '▴') : ''}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.label}>
              <th scope="row" className="border-b border-grid px-2 py-1.5 text-left font-normal text-ink">
                {r.label}
              </th>
              <td className="border-b border-grid px-2 py-1.5 text-right font-semibold tabular-nums text-ink">
                {fmt(r.billable)}
              </td>
              <td className="border-b border-grid px-2 py-1.5 text-right tabular-nums text-ink2">{fmt(r.inputTokens)}</td>
              <td className="border-b border-grid px-2 py-1.5 text-right tabular-nums text-ink2">{fmt(r.outputTokens)}</td>
              <td className="border-b border-grid px-2 py-1.5 text-right tabular-nums text-ink2">{fmt(r.cacheReadTokens)}</td>
              <td className="border-b border-grid px-2 py-1.5 text-right tabular-nums text-ink2">{fmt(r.cacheCreationTokens)}</td>
              <td className="border-b border-grid px-2 py-1.5 text-right tabular-nums text-ink2">{fmt(r.events)}</td>
              {hasSidechain && (
                <td className="border-b border-grid px-2 py-1.5 text-right tabular-nums text-ink2">
                  {r.sidechainEvents === null ? '-' : fmt(r.sidechainEvents)}
                </td>
              )}
              <td className="border-b border-grid px-2 py-1.5 text-right tabular-nums text-ink2">
                {r.apiEquivalentUsd === null ? '미상' : `$${r.apiEquivalentUsd.toFixed(2)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
