import React from 'react';
import { usePracticeStore } from '../../store';
import { useTranslation } from '../../lib/i18n/useTranslation';
import type { ScoreLayout } from '../../types/score-layout';

/**
 * 楽譜ページの配置方向（縦積み/横並び）を切り替えるUI。
 * `setScoreLayout`（ui-slice）を直接呼び出す。ScoreRenderer 側はこの値で
 * ページの並べ方を CSS のみで切り替えるため、OSMD の再描画は発生しない。
 */
const LAYOUTS: Array<{ value: ScoreLayout; label: string }> = [
  { value: 'vertical', label: 'Vertical' },
  { value: 'horizontal', label: 'Horizontal' },
];

export const ScoreLayoutControl: React.FC = () => {
  const { scoreLayout, setScoreLayout } = usePracticeStore();
  const t = useTranslation();

  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
      <label htmlFor="score-layout-toggle" style={{ fontSize: '14px', color: '#374151' }}>
        {t.scoreLayoutControl.label}
      </label>
      <div
        id="score-layout-toggle"
        data-testid="score-layout-toggle"
        title={t.scoreLayoutControl.title}
        style={{
          display: 'flex',
          border: '1px solid #d1d5db',
          borderRadius: '6px',
          overflow: 'hidden',
        }}
      >
        {LAYOUTS.map((l) => (
          <button
            key={l.value}
            type="button"
            data-testid={`score-layout-${l.value}`}
            onClick={() => setScoreLayout(l.value)}
            style={{
              padding: '10px 12px',
              fontSize: '14px',
              cursor: 'pointer',
              border: 'none',
              background: scoreLayout === l.value ? '#3b82f6' : 'transparent',
              color: scoreLayout === l.value ? '#ffffff' : '#374151',
            }}
          >
            {l.label}
          </button>
        ))}
      </div>
    </div>
  );
};
