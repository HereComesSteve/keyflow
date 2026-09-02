# Keyflow 修改报告（给原作者）

基于 **windschord/keyflow 最新版 main（5ccc5ef，Microsoft Store 发布版）** 的 fork，共 **9 个提交**，改动集中在**性能优化、功能扩展、正确性修复**三类。

> 说明：fork 上还包含一套「智能钢琴手套控制」功能（蓝牙 BLE 连接、固件指令、手套控制面板、Arduino 固件等）。这是为个人硬件定制的功能，对普通用户没有价值，**本报告已全部排除**，以下均为通用性的改进。

---

## 一、性能优化

### 1. 乐谱坐标 / 光标状态持久化缓存（核心，改动最大）

**问题**：`buildNoteIdMap` 通过 OSMD 光标逐音符遍历构建 `noteId → 坐标/光标状态` 映射，一首 1000+ 音符的曲子首次导入和每次重新打开都要 **8～13 秒**，期间 UI 卡死。

**方案**：新增 `ScoreMapCache`（v2）持久化缓存链路：

- **数据结构**（`osmd-controller.ts`）：
  - `noteIdToCursorState`：noteId → 光标 iteratorIndex（moveCursor 用）
  - `noteIdToSvgCoord`：noteId → 页面内坐标 + pageIndex（指法/高亮等 overlay 用）
  - `iteratorIndexToCursorStyle`：iteratorIndex → `cursorElement.style.cssText` 快照（O(1) 跳转用）
  - `zoomBase`：缓存生成时的 zoom，zoom 不一致时只丢弃 cursorStyle、坐标仍可用
- **读写**（`ScoreRenderer/index.tsx`）：加载完成后先读 `.scoremap.cache.json`，`applyCache` 命中则完全跳过光标遍历；未命中则 `serializeCache` 写回。
- **权限**（`main/path-allowlist.ts`、`main/index.ts`）：`assertAllowedSidecarWritePath` 允许写 `*.scoremap.cache.json`，仍限定为已授权 MusicXML 的派生文件。
- **删除联动**（`main/library-handlers.ts`）：从库中删除乐谱时一并清理 `.annotation.json` 与 `.scoremap.cache.json`。

**效果**：二次打开从 8-13 秒降至毫秒级。

### 2. moveCursor O(1) 跳转

光标移动不再逐次 `cursor.next()`：按目标 noteId 的 iteratorIndex 直接恢复缓存样式；分页模式下将光标 reparent 到对应页的 SVG。缓存未命中才回退逐次遍历。

### 3. 主进程同步写盘延迟化（解决打开/保存卡顿）

- electron-store 的同步 `writeFileSync` 在慢磁盘（OneDrive 等）实测阻塞 **7-8 秒**：`library:upsert`、`addRecentFile` 改为 `setImmediate` 延迟执行 / fire-and-forget（`main/library-handlers.ts`、`main/file-handlers.ts`、`main/index.ts`）。
- 渲染层 `openMusicXmlFile` 重排：`annotationStore.load` 先于 `setScore` 执行，`buildNoteIdMap` 用 `setTimeout(0)` 推迟到宏任务队列，避免同步遍历抢占 IPC 响应。注解加载 IPC 从 12 秒降至几毫秒。

### 4. 灰化功能在缓存命中路径的修复

`noteIdToGraphicalNote` 存的是 `GraphicalNote` **对象引用**，无法序列化，导致缓存命中时灰化失效。新增 `rebuildGrayoutNoteMap`：直接遍历 GraphicSheet（MusicPages → staffEntries → notes），复用既有照合逻辑在毫秒级重建 noteId → SVG 元素映射，与光标无关，两条路径行为一致。

### 5. 光标遍历忽略反复记号

设置 `EngravingRules.CursorIgnoreRepetitions = true`：光标不再跟随反复记号重放重复小节，消除 buildNoteIdMap 的重复遍历与大量 "could not resolve" 噪音日志，首次导入提速明显。

### 6. 固定 A4 分页渲染 + CSS 缩放

页面格式改为 `A4_P` 固定 794px，窗口缩放只改外层 CSS zoom，OSMD 自身 zoom 恒为 1.0 → 坐标缓存与窗口大小无关；移除 `setZoom` / ResizeObserver 重绘路径，窗口变化不再破坏缓存坐标。

### 7. 布局抖动（layout thrashing）抑制

`buildNoteIdMap` 循环外一次性预取所有页面 SVG 的 `getBoundingClientRect`（`svgRects`），循环内只按页引用，消除反复强制重排。

---

## 二、功能扩展

### 1. 序列循环播放

- 独立的非模态浮动 `LoopRangePanel` 弹窗（可拖动、Escape 关闭），替换原工具栏内联循环输入。
- 新增**循环开关**：开启后序列播放到末尾自动回绕到序列开头，实现真正循环。
- `audio-engine` 新增 `parseRangeIntoSegments` / `setupPlaybackSequence`：把 "1-3, 5-7" 解析为段序列，构建 `boundaries` 边界调度（jump/stop），循环跳转在 audio thread 回调内原子执行 `pause → seek → releaseAll → start`，避免跨 frame 闪音。
- `deriveRepeatPlayRange`：从 MusicXML 反复记号（`repeatStart/repeatEnd`、1/2 房子）自动推导播放顺序并预填到范围输入框，用户手动编辑后不再覆盖。

### 2. 页面布局持久化

新增 `ScoreLayout = 'vertical' | 'horizontal'`，**默认横向布局**；切换后经 electron-store 持久化，下次启动保持用户习惯。仅 CSS 切换排列方向，无 OSMD 重绘。

### 3. Library 页面美化

卡片式列表（替换原表格）、加载骨架屏、搜索 + 排序下拉、统一空/错误态、删除确认弹窗；乐谱页隐藏 Header（库页才显示），库页顶部新增「返回乐谱 / 打开文件 / 设置」快捷按钮；新增全屏加载遮罩。

### 4. 多语言支持（新增中文，日文修正）

- `Language` 扩展为 `en / ja / zh`；新增完整中文资源 `zh.ts`（351 行，结构与 ja/en 对齐，ON/OFF、BPM、SRAM 等惯用英文保留）。
- `ja.ts` 中此前被改写成英文的文案改回日语；`en.ts` 补齐缺失键。
- 主进程菜单（`menu.ts`）新增中文标签；`resolve-language` 支持 `zh`（仅手动选择，不自动检测，避免误判）。

### 5. 指法编辑

新增 `FingeringEditToggle` 开关（开启时强制显示指法）与 `FingeringPicker`（点击乐谱指法数字弹出 1-5 选择条，写入 annotation-store）。

### 6. 统一下拉组件 KfSelect

button + popover 重实现原生 select（`aria-haspopup="listbox"`、点击外部/Escape 关闭、选中打勾），替换 SettingsModal 与 FingeringPanel 中的原生下拉。

### 7. 设计系统统一

新增 `keyflow-ui.css` 设计系统（`kf-*` 类：按钮/分段控件/滑块/开关/下拉/弹窗），各工具栏组件内联样式迁移为统一类，强调色统一。

---

## 三、正确性修复

1. **反复记号解析**（`parser.ts`）：`Measure` 新增 `repeatStart / repeatEnd / endingStart / endingEnd` 字段，从 MusicXML 提取反复与房子号（服务循环播放推导）。
2. **标题提取**：`work-title → movement-title → credit-words` 候选链，并过滤 MuseScore 本地化占位符（如"未命名乐谱"），库页与谱面标题一致。
3. **时间匹配失败兜底**：`buildNoteIdMap` 中 tick 匹配失败（七连音等累积误差导致整小节全灭）的音符，在兜底阶段按 tick 顺序与候选 1:1 配对，避免误配。
4. **小节点击命中**：改为按 staff 独立矩形（`measureNumberToRect`）命中，修复低音谱点击无响应、两谱表间隙误触的问题。
5. **循环面板关闭按钮**：硬编码 `aria-label="Close"` 改为走 i18n，多语言下测试与 UI 一致。

---

*生成方式：`git diff origin-latest/main..HEAD`（base = 5ccc5ef）逐文件核对整理。*
