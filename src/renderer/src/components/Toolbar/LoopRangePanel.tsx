import React, { useEffect, useRef, useState } from 'react';

interface DragState {
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

export interface LoopRangePanelProps {
  /**
   * 面板标题（可拖动把手区域）。
   */
  title: string;
  /** 关闭按钮点击时调用。面板本体是非模态浮层，不拦截对乐谱页面的操作。 */
  onClose: () => void;
  /** 面板主体内容（循环序列输入框、清空/重置按钮等）。 */
  children: React.ReactNode;
}

/**
 * 循环序列编辑用の非モーダル浮動パネル（可搬式）。
 *
 * - `position: fixed` で視認位置を保持し、タイトルバーのドラッグで任意の位置へ移動できる。
 * - モーダル（SettingsModal: zIndex 1000）より下（zIndex 900）に配置し、背景を塞がない。
 * - 閉じるボタンはタイトルバー右端に配置。Escape キーでも閉じる。
 */
export const LoopRangePanel: React.FC<LoopRangePanelProps> = ({ title, onClose, children }) => {
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    // 初期位置: 画面右上（ヘッダー直下）に表示。ウィンドウ幅に依存して端からはみ出さないようにする。
    const x = Math.max(8, window.innerWidth - 440);
    return { x, y: 56 };
  });
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    if (!isDragging) return undefined;

    const handleMove = (event: MouseEvent): void => {
      const d = dragRef.current;
      if (!d) return;
      setPos({
        x: d.originX + (event.clientX - d.startX),
        y: d.originY + (event.clientY - d.startY),
      });
    };

    const handleUp = (): void => {
      dragRef.current = null;
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, [isDragging]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleTitleMouseDown = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: pos.x,
      originY: pos.y,
    };
    setIsDragging(true);
  };

  return (
    <div
      data-testid="loop-range-panel"
      role="dialog"
      aria-label={title}
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        zIndex: 900,
        minWidth: '300px',
        backgroundColor: '#fff',
        border: '1px solid #e5e7eb',
        borderRadius: '8px',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.12)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        data-testid="loop-range-panel-title"
        onMouseDown={handleTitleMouseDown}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          padding: '8px 12px',
          backgroundColor: '#f9fafb',
          borderBottom: '1px solid #e5e7eb',
          cursor: 'grab',
          userSelect: 'none',
        }}
      >
        <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#374151' }}>{title}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          title="Close"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '24px',
            height: '24px',
            padding: 0,
            backgroundColor: 'transparent',
            border: 'none',
            borderRadius: '4px',
            color: '#6b7280',
            cursor: 'pointer',
            fontSize: '1rem',
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>
      <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {children}
      </div>
    </div>
  );
};
