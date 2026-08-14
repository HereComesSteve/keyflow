import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { LibraryEntry } from '../../types/library';
import { useTranslation } from '../../lib/i18n/useTranslation';
import { usePracticeStore } from '../../store';
import { GloveIcon } from '../icons/GloveIcon';
import { formatMessage } from '../../lib/i18n/format';
import {
  filterLibraryEntries,
  sortLibraryEntries,
  formatLibraryDateTime,
  type LibrarySortKey,
  type LibrarySortOrder,
} from './library-utils';

interface LibraryViewProps {
  /** 一覧の行（タイトル）クリックで呼ばれる。開く処理自体はTASK-103で結線する。 */
  onOpenEntry: (path: string) => void;
  /** 空状態の「ファイルを開く」ボタンで呼ばれる。既存のダイアログ導線を再利用する。 */
  onOpenFileDialog: () => void;
  /**
   * `library:open`失敗により欠損と判明したpathの集合（REQ-017-008の表示部分）。
   * 検出処理自体はTASK-103のスコープであり、本コンポーネントは表示のみを担う。
   */
  missingPaths?: ReadonlySet<string>;
  /**
   * CodeRabbit #46指摘4対応: App.tsx側で欠損エントリの削除が成功した場合など、
   * 本コンポーネントの外側で一覧に影響する変更が起きた際にこの値をインクリメントすると
   * `getAll()`を再実行して一覧を再取得する。値そのものに意味はなく変化のみを見る。
   */
  reloadSignal?: number;
  /**
   * 楽譜表示への復帰導線（TASK-105、REQ-017-012）。指定時のみ画面上部に
   * 「楽譜へ戻る」ボタンを表示する。App.tsx側は楽譜読み込み済みのときのみ渡す。
   */
  onReturnToScore?: () => void;
  /** 設定（歯車）ボタンクリック時に呼ばれる。ライブラリ画面はヘッダー非表示のため、
   *  タイトル行に配置したボタンから設定モーダルを開く（App.tsx側が結線）。 */
  onOpenSettings?: () => void;
  /** 蓝牙手套连接面板ボタンクリック時に呼ばれる（ライブラリ画面のヘッダー非表示対策）。 */
  onOpenGlove?: () => void;
}

const SORT_KEYS: readonly LibrarySortKey[] = ['title', 'addedAt', 'lastOpenedAt'];

/* 内联 SVG 图标（继承 currentColor） */
const SearchIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

const CheckIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const TrashIcon = () => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 6h18" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M10 11v6M14 11v6" />
  </svg>
);

const RetryIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 12a9 9 0 1 0 2.64-6.36" />
    <path d="M21 3v6h-6" />
  </svg>
);

interface SortDropdownProps {
  id: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}

/**
 * 库页面的自定义下拉选择器。
 * 原生 <select> 的展开列表由操作系统渲染，无法统一为极简设计系统
 * （会出现直角边框与蓝色悬停），因此用 button + popover 重新实现。
 */
const SortDropdown: React.FC<SortDropdownProps> = ({ id, value, options, onChange }) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedLabel = options.find((opt) => opt.value === value)?.label ?? value;

  useEffect(() => {
    if (!open) return undefined;

    const handlePointerDown = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div className="kf-dropdown" ref={containerRef}>
      <button
        id={id}
        type="button"
        className="kf-dropdown__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {selectedLabel}
      </button>
      {open && (
        <div className="kf-dropdown__menu" role="listbox" aria-labelledby={id}>
          {options.map((opt) => {
            const selected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={selected}
                className={`kf-dropdown__item${selected ? ' kf-dropdown__item--selected' : ''}`}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                <span>{opt.label}</span>
                <span className="kf-dropdown__check" aria-hidden="true">
                  <CheckIcon />
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export const LibraryView: React.FC<LibraryViewProps> = ({
  onOpenEntry,
  onOpenFileDialog,
  missingPaths,
  reloadSignal,
  onReturnToScore,
  onOpenSettings,
  onOpenGlove,
}) => {
  const t = useTranslation();
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  // CodeRabbit #46 Major指摘5: getAll()失敗を「0件の空状態」と区別して表示するためのフラグ。
  const [loadError, setLoadError] = useState(false);
  // 再読み込みボタン押下時にuseEffectを再実行させるためのトークン（値自体に意味はない）。
  const [retryToken, setRetryToken] = useState(0);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<LibrarySortKey>('lastOpenedAt');
  const [sortOrder, setSortOrder] = useState<LibrarySortOrder>('desc');
  const [confirmTarget, setConfirmTarget] = useState<LibraryEntry | null>(null);
  // CodeRabbit #46 Major指摘6: 削除確認ダイアログのアクセシビリティ
  // （AboutModal.tsxと同パターン: 初期フォーカス移動・閉じた際のフォーカス復帰）。
  const confirmDialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const result = await window.electronAPI.library.getAll();
        if (!cancelled) {
          setEntries(result);
          setLoadError(false);
        }
      } catch {
        if (!cancelled) {
          setEntries([]);
          setLoadError(true);
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    };
    load();

    return () => {
      cancelled = true;
    };
  }, [retryToken, reloadSignal]);

  useEffect(() => {
    if (!confirmTarget) return undefined;

    previouslyFocusedElementRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    confirmDialogRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setConfirmTarget(null);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocusedElementRef.current?.focus();
    };
  }, [confirmTarget]);

  const visibleEntries = useMemo(
    () => sortLibraryEntries(filterLibraryEntries(entries, query), sortKey, sortOrder),
    [entries, query, sortKey, sortOrder]
  );

  const sortKeyLabels: Record<LibrarySortKey, string> = {
    title: t.library.sortKeyTitle,
    addedAt: t.library.sortKeyAddedAt,
    lastOpenedAt: t.library.sortKeyLastOpenedAt,
  };

  const handleRequestDelete = (entry: LibraryEntry): void => {
    setConfirmTarget(entry);
  };

  const handleConfirmDelete = async (): Promise<void> => {
    if (!confirmTarget) return;
    const target = confirmTarget;
    setConfirmTarget(null);
    try {
      await window.electronAPI.library.remove(target.path);
      setEntries((current) => current.filter((entry) => entry.path !== target.path));
    } catch {
      // CodeRabbit #46 Major指摘5: 削除失敗時も一覧は維持しつつユーザーへ通知する。
      alert(formatMessage(t.library.deleteErrorMessage, { title: target.title }));
    }
  };

  const handleRetryLoad = (): void => {
    setRetryToken((current) => current + 1);
  };

  // TASK-105: 楽譜表示への復帰導線（REQ-017-012）。onReturnToScore指定時のみ、
  // どの表示状態（一覧・空状態・エラー状態）でも画面上部に表示する。
  const returnToScoreButton = onReturnToScore ? (
    <button
      type="button"
      onClick={onReturnToScore}
      data-testid="library-return-to-score-button"
      className="kf-btn kf-btn--sm"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m12 19-7-7 7-7" />
        <path d="M19 12H5" />
      </svg>
      {t.library.returnToScoreButton}
    </button>
  ) : null;

  // ライブラリ画面ではヘッダーが非表示のため、タイトル行に設定・手套ボタンを配置する。
  // 手套ボタンはヘッダーと同じく接続状態に応じて緑点を表示する。
  const isGloveConnected = usePracticeStore((s) => s.isConnected);
  const headActions = (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
      {/* 打开文件：仅列表状态显示（空状态已有带文字的"文件を開く"按钮，避免重复） */}
      {entries.length > 0 && (
        <button
          type="button"
          onClick={onOpenFileDialog}
          aria-label={t.header.openFileAriaLabel}
          title={t.header.openFileTitle}
          data-testid="library-open-file-button"
          className="kf-icon-btn"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"></path>
          </svg>
        </button>
      )}
      {onOpenGlove && (
        <button
          type="button"
          onClick={onOpenGlove}
          aria-label={t.header.gloveButtonAriaLabel}
          title={t.header.gloveButtonTitle}
          data-testid="library-glove-button"
          className={`kf-icon-btn ${isGloveConnected ? 'kf-icon-btn--active' : ''}`}
          style={{ position: 'relative' }}
        >
          <GloveIcon />
          {isGloveConnected && (
            <span
              data-testid="library-glove-connection-dot"
              aria-hidden="true"
              style={{
                position: 'absolute',
                top: '4px',
                right: '4px',
                width: '8px',
                height: '8px',
                backgroundColor: '#16a34a',
                borderRadius: '50%',
                border: '1px solid #fff',
                boxShadow: '0 0 0 2px var(--kf-header-bg, #f7f8fa)',
              }}
            />
          )}
        </button>
      )}
      {onOpenSettings && (
        <button
          type="button"
          onClick={onOpenSettings}
          title={t.header.settingsTitle}
          aria-label={t.header.settingsAriaLabel}
          data-testid="library-settings-button"
          className="kf-icon-btn"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
        </button>
      )}
    </div>
  );

  const head = (
    <div className="kf-library__head">
      <h2 className="kf-library__title">
        <span aria-hidden="true">🎼</span>
        {t.library.title}
        {loaded && !loadError && (
          <span className="kf-library__count">{entries.length}</span>
        )}
      </h2>
      <div className="kf-library__spacer" />
      {headActions}
      {returnToScoreButton}
    </div>
  );

  const confirmDialog = confirmTarget ? (
    <div className="kf-modal">
      <div
        ref={confirmDialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t.library.confirmDeleteTitle}
        tabIndex={-1}
        className="kf-modal__card"
      >
        <p className="kf-modal__title">
          <span style={{ color: 'var(--kf-danger)', display: 'inline-flex' }} aria-hidden="true">
            <TrashIcon />
          </span>
          {t.library.confirmDeleteTitle}
        </p>
        <p className="kf-modal__message">
          {formatMessage(t.library.confirmDeleteMessage, { title: confirmTarget.title })}
        </p>
        <div className="kf-modal__actions">
          <button className="kf-btn" onClick={() => setConfirmTarget(null)}>
            {t.library.confirmDeleteCancelButton}
          </button>
          <button className="kf-btn kf-btn--primary" onClick={handleConfirmDelete}>
            {t.library.confirmDeleteConfirmButton}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  if (loaded && loadError) {
    return (
      <div role="region" aria-label={t.library.title} className="kf-library">
        {head}
        <div className="kf-empty">
          <div className="kf-empty__icon" aria-hidden="true">
            🗂️
          </div>
          <p className="kf-empty__title">{t.library.loadErrorTitle}</p>
          <p className="kf-empty__desc">{t.library.loadErrorDescription}</p>
          <button className="kf-btn kf-btn--primary kf-empty__action" onClick={handleRetryLoad}>
            <RetryIcon />
            {t.library.retryButton}
          </button>
        </div>
      </div>
    );
  }

  if (loaded && entries.length === 0) {
    return (
      <div role="region" aria-label={t.library.title} className="kf-library">
        {head}
        <div className="kf-empty">
          <div className="kf-empty__icon" aria-hidden="true">
            🎹
          </div>
          <p className="kf-empty__title">{t.library.emptyTitle}</p>
          <p className="kf-empty__desc">{t.library.emptyDescription}</p>
          <button
            className="kf-btn kf-btn--primary kf-empty__action"
            onClick={onOpenFileDialog}
          >
            {t.library.emptyOpenFileButton}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div role="region" aria-label={t.library.title} className="kf-library">
      {head}

      <div className="kf-library__controls">
        <div className="kf-search">
          <span className="kf-search__icon">
            <SearchIcon />
          </span>
          <input
            type="search"
            aria-label={t.library.searchLabel}
            placeholder={t.library.searchPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="kf-search__input"
          />
        </div>
        <label className="kf-library__field" htmlFor="library-sort-key">
          {t.library.sortKeyLabel}
          <SortDropdown
            id="library-sort-key"
            value={sortKey}
            options={SORT_KEYS.map((key) => ({ value: key, label: sortKeyLabels[key] }))}
            onChange={(value) => setSortKey(value as LibrarySortKey)}
          />
        </label>
        <label className="kf-library__field" htmlFor="library-sort-order">
          {t.library.sortOrderLabel}
          <SortDropdown
            id="library-sort-order"
            value={sortOrder}
            options={[
              { value: 'asc', label: t.library.sortOrderAsc },
              { value: 'desc', label: t.library.sortOrderDesc },
            ]}
            onChange={(value) => setSortOrder(value as LibrarySortOrder)}
          />
        </label>
      </div>

      {visibleEntries.length === 0 ? (
        <div className="kf-empty">
          <div className="kf-empty__icon" aria-hidden="true">
            🔍
          </div>
          <p className="kf-empty__title">{t.library.noResults}</p>
        </div>
      ) : (
        <div className="kf-table-wrap">
          <table className="kf-table">
            <thead>
              <tr>
                <th scope="col">{t.library.columnTitle}</th>
                <th scope="col">{t.library.columnComposer}</th>
                <th scope="col">{t.library.columnLastOpenedAt}</th>
                <th scope="col" style={{ textAlign: 'right' }}>
                  {t.library.columnActions}
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleEntries.map((entry) => {
                const isMissing = missingPaths?.has(entry.path) ?? false;
                return (
                  <tr key={entry.path}>
                    <td>
                      <button
                        type="button"
                        className="kf-link-btn"
                        onClick={() => onOpenEntry(entry.path)}
                      >
                        {entry.title}
                      </button>
                      {isMissing && (
                        <span className="kf-badge--danger" title={t.library.missingTitle}>
                          {t.library.missingLabel}
                        </span>
                      )}
                    </td>
                    <td className="kf-cell--muted">{entry.composer}</td>
                    <td className="kf-cell--date">
                      {formatLibraryDateTime(entry.lastOpenedAt)}
                    </td>
                    <td className="kf-cell--actions">
                      <button
                        type="button"
                        aria-label={formatMessage(t.library.deleteButtonAriaLabel, {
                          title: entry.title,
                        })}
                        className="kf-danger-btn"
                        onClick={() => handleRequestDelete(entry)}
                      >
                        <TrashIcon />
                        {t.library.deleteButton}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {confirmDialog}
    </div>
  );
};
