# Keyflow 変更レポート（原作者向け）

**windschord/keyflow 最新版 main（5ccc5ef、Microsoft Store 公開版）** をフォークし、計 **9 コミット**の変更を加えました。内容は**性能最適化・機能拡張・修正**の3つに分類されます。

> 注：フォークには「スマートピアノグローブ制御」機能（Bluetooth BLE 接続、ファームウェア指令、グローブ制御パネル、Arduino ファームウェア等）も含まれていますが、これは個人ハードウェア向けに自作したカスタム機能であり一般ユーザーには価値が無いため、本レポートからはすべて除外しています。以下は汎用の改善のみです。

---

## 一、性能最適化

### 1. 楽譜座標 / カーソル状態の永続化キャッシュ（中核・変更量最大）

**問題**: `buildNoteIdMap` は OSMD カーソルで音符を1つずつ走査して `noteId → 座標/カーソル状態` マップを構築するため、1000音符超の曲では初回インポート・再オープンのたびに **8〜13秒** かかり、その間 UI がフリーズする。

**対策**: 新しい `ScoreMapCache`（v2）永続化キャッシュの仕組みを追加。

- **データ構造**（`osmd-controller.ts`）:
  - `noteIdToCursorState`: noteId → カーソル iteratorIndex（moveCursor 用）
  - `noteIdToSvgCoord`: noteId → ページ内座標 + pageIndex（運指・ハイライト等のオーバーレイ用）
  - `iteratorIndexToCursorStyle`: iteratorIndex → `cursorElement.style.cssText` スナップショット（O(1) ジャンプ用）
  - `zoomBase`: キャッシュ生成時の zoom。zoom 不一致時は cursorStyle のみ破棄し、座標は常に採用
- **読み書き**（`ScoreRenderer/index.tsx`）: ロード完了後 `.scoremap.cache.json` を読み、`applyCache` 命中時はカーソル走査を完全スキップ。未命中時は `serializeCache` で書き戻し。
- **権限**（`main/path-allowlist.ts`、`main/index.ts`）: `assertAllowedSidecarWritePath` により `*.scoremap.cache.json` の書き込みを許可（承認済み MusicXML 由来ファイルに限定）。
- **削除連動**（`main/library-handlers.ts`）: ライブラリから楽譜を削除する際、`.annotation.json` と `.scoremap.cache.json` の両方のサイドカーを削除。

**効果**: 再オープンが 8〜13秒 → ミリ秒級に短縮。

### 2. moveCursor の O(1) ジャンプ

カーソル移動を毎回 `cursor.next()` で行わず、対象 noteId の iteratorIndex からキャッシュ済みスタイルを直接復元。ページモードではカーソルを該当ページの SVG へ reparent。キャッシュ未命中時のみ逐次走査にフォールバック。

### 3. メインプロセス同期書き込みの遅延化（開く・保存時のカクつき解消）

- electron-store の同期 `writeFileSync` は遅いディスク（OneDrive 等）で実測 **7〜8秒** ブロック: `library:upsert`・`addRecentFile` を `setImmediate` 遅延実行 / fire-and-forget 化（`main/library-handlers.ts`、`main/file-handlers.ts`、`main/index.ts`）。
- レンダラー側 `openMusicXmlFile` を再構成: `annotationStore.load` を `setScore` より先に実行し、`buildNoteIdMap` は `setTimeout(0)` でマクロタスクキューへ遅延。同期走査が IPC 応答をブロックするのを防ぐ。アノテーション読み込み IPC は 12秒 → 数ミリ秒に改善。

### 4. グレーアウト機能のキャッシュヒット時における不具合修正

`noteIdToGraphicalNote` は `GraphicalNote` の**オブジェクト参照**を保持するためシリアライズ不可で、キャッシュヒット時にグレーアウトが効かない問題がありました。`rebuildGrayoutNoteMap` を追加し、GraphicSheet（MusicPages → staffEntries → notes）を直接走査して既存の照合ロジックを再利用、ミリ秒級で noteId → SVG 要素マップを再構築。カーソル非依存のため両パスの挙動が一致します。

### 5. カーソル走査での繰り返し記号無視

`EngravingRules.CursorIgnoreRepetitions = true` を設定: カーソルが繰り返し記号に従って小節を再走査するのを止め、`buildNoteIdMap` の重複走査と大量の "could not resolve" ノイズログを解消。初回インポートも大幅に高速化。

### 6. 固定 A4 ページレンダリング + CSS ズーム

ページフォーマットを `A4_P` 固定 794px に変更。ウィンドウのズームは外側 CSS zoom のみで表現し、OSMD 自身の zoom は常に 1.0 → 座標キャッシュがウィンドウサイズに依存しない。`setZoom` / ResizeObserver による再描画パスを撤廃し、ウィンドウ変化がキャッシュ座標を壊さないようにしました。

### 7. レイアウトスラッシング抑制

`buildNoteIdMap` のループ外で全ページ SVG の `getBoundingClientRect`（`svgRects`）を一括取得し、ループ内ではページごとに参照のみ。強制リフローを繰り返す問題を解消。

---

## 二、機能拡張

### 1. シーケンスループ再生

- ツールバーのインラインループ入力を、非モーダルでドラッグ可能なフロートパネル `LoopRangePanel`（Escape で閉じる）に置き換え。
- **ループスイッチ**を新設: ON にするとシーケンス末尾で先頭に回り込み、真のループ再生が可能。
- `audio-engine` に `parseRangeIntoSegments` / `setupPlaybackSequence` を追加: "1-3, 5-7" をセグメント列に分解し、`boundaries` 境界スケジューリング（jump/stop）を構築。ループジャンプは audio thread コールバック内で `pause → seek → releaseAll → start` を原子的に実行し、フレームをまたぐ「チリッ」というノイズを防止。
- `deriveRepeatPlayRange`: MusicXML の繰り返し記号（`repeatStart/repeatEnd`、1・2番括弧）から再生順を自動導出して範囲入力欄にプリセット。ユーザーが手動編集した後は上書きしない。

### 2. レイアウト設定の永続化

`ScoreLayout = 'vertical' | 'horizontal'` を追加し、**デフォルトは横並び（horizontal）**。切替後は electron-store に永続化し、次回起動時もユーザーの好みを保持。CSS で並び方向を切り替えるだけで OSMD の再描画は発生しません。

### 3. Library 画面の美化

表形式をカードリストに刷新、ローディングスケルトン、検索 + ソートドロップダウン、統一された空/エラー状態、削除確認モーダルを追加。楽譜画面では Header を非表示（Library 画面のみ表示）とし、Library 画面トップに「楽譜へ戻る / ファイルを開く / 設定」ボタンを配置。全画面ローディングオーバーレイも追加。

### 4. 多言語対応（中国語追加・日本語修正）

- `Language` を `en / ja / zh` に拡張。完全な中国語リソース `zh.ts`（351行、ja/en と構造一致。ON/OFF、BPM、SRAM など慣用英語は残置）を新規追加。
- `ja.ts` で以前英語に書き換えられていた文言を日本語に復元。`en.ts` は欠落キーを補完。
- メインプロセスメニュー（`menu.ts`）に中国語ラベルを追加。`resolve-language` が `zh` をサポート（手動選択のみ。自動検出はしない）。

### 5. 運指編集

`FingeringEditToggle` スイッチ（ON で運指を常時表示）と `FingeringPicker`（楽譜上の運指数字クリックで 1〜5 の選択バーを表示、annotation-store に書き込み）を追加。

### 6. 統合ドロップダウン KfSelect

button + popover でネイティブ select を再実装（`aria-haspopup="listbox"`、外側クリック/Escape で閉じる、選択チェック表示）。SettingsModal と FingeringPanel のネイティブ select を置き換え。

### 7. デザインシステム統一

`keyflow-ui.css`（`kf-*` クラス: ボタン/セグメント/スライダー/トグル/ドロップダウン/モーダル）を新設し、各ツールバー・ヘッダーコンポーネントのインラインスタイルを統一クラスへ移行。アクセントカラーを統一。

---

## 三、修正

1. **繰り返し記号のパース**（`parser.ts`）: `Measure` に `repeatStart / repeatEnd / endingStart / endingEnd` を追加し、MusicXML から繰り返し・括弧（1・2番）を抽出（ループ再生順の導出に利用）。
2. **タイトル抽出**: `work-title → movement-title → credit-words` の候補チェーンとし、MuseScore のローカライズ済みプレースホルダ（例「未命名乐谱」）を除外。Library と譜面のタイトルが一致。
3. **時間マッチ失敗のフォールバック**: `buildNoteIdMap` で tick マッチに失敗した（7連符などの累積誤差で小節全体が失効するケース）音符を、フォールバック段階で tick 順に候補と 1:1 対応付けし、誤対応を防止。
4. **小節クリック判定**: staff ごとの独立矩形（`measureNumberToRect`）で判定するよう変更し、低音譜表クリックが反応しない・両譜表の隙間を誤タップする問題を修正。
5. **ループパネルの閉じるボタン**: ハードコードされていた `aria-label="Close"` を i18n 化し、多言語環境でも UI とテストが一致。

---

*生成方法: `git diff origin-latest/main..HEAD`（base = 5ccc5ef）をファイル単位で照合して整理。*
