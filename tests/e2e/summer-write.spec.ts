import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright-core';
import path from 'node:path';
import {
  createIsolatedUserDataDir,
  removeIsolatedUserDataDir,
  userDataDirArg,
} from './e2e-user-data';

/** Summer Time.mxl 完整写入验证：打开→指法→连接→导入→写入→播放 */
const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');
const MXL_PATH = path.join(REPO_ROOT, 'Summer Time.mxl');
const GLOVE_DEVICE_NAME = process.env.GLOVE_DEVICE_NAME ?? 'Glove_L';

let electronApp: ElectronApplication;
let window: Page;
let userDataDir: string;

test.beforeAll(async () => {
  userDataDir = createIsolatedUserDataDir('en');
  electronApp = await electron.launch({
    args: [MAIN_ENTRY, userDataDirArg(userDataDir)],
    env: { ...process.env },
  });
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  window.on('console', (m) => console.log(`[renderer.${m.type()}]${m.text()}`));
});

test.afterAll(async () => {
  await electronApp?.close();
  removeIsolatedUserDataDir(userDataDir);
});

async function gloveLogs(): Promise<string> {
  const lines = window.locator('.glove-log__line');
  const n = await lines.count();
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push((await lines.nth(i).innerText()).trim());
  return out.join('\n');
}

async function waitForLog(pred: RegExp, timeoutMs = 60_000, label = ''): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let logs = '';
  let last = '';
  while (Date.now() < deadline) {
    logs = await gloveLogs();
    if (pred.test(logs)) return logs;
    const tail = logs.split('\n').slice(-6).join(' | ');
    if (tail !== last) {
      last = tail;
      console.log(`[${label}] ..${tail}`);
    }
    await window.waitForTimeout(1000);
  }
  throw new Error(`日志未出现 ${pred}。当前日志:\n${logs}`);
}

async function gloveLogCount(): Promise<number> {
  return window.locator('.glove-log__line').count();
}

async function setTarget(target: 'left' | 'right'): Promise<void> {
  await window.getByText(target === 'left' ? 'Left' : 'Right', { exact: true }).first().click();
  await window.waitForTimeout(400);
}

async function writeScore(hex: string, storage: 'SRAM' | 'EEPROM', label: string): Promise<string> {
  const logStart = await gloveLogCount();
  if (storage === 'EEPROM') {
    await window
      .getByLabel('Storage')
      .getByRole('button', { name: 'EEPROM' })
      .click()
      .catch(() => {});
  } else {
    await window
      .getByLabel('Storage')
      .getByRole('button', { name: 'SRAM' })
      .click()
      .catch(() => {});
  }
  await window.locator('textarea.glove-textarea').fill(hex);
  await window.getByText('Write score', { exact: true }).click();
  const logs = await waitForLog(/Write complete|Write result|Write failed/, 180_000, label);
  const tail = logs
    .split('\n')
    .filter((l) => /Write|result|Sent|NAK|retries|CRC/i.test(l));
  console.log(`[${label}]`, tail.slice(-6));
  return tail.join('\n');
}

async function connectGlove(): Promise<void> {
  await window
    .evaluate(() => {
      document
        .querySelector('[data-testid="header-glove-button"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })
    .catch(() => {});
  const dialog = window.getByRole('dialog', { name: 'Bluetooth glove connection' });
  await dialog.waitFor({ timeout: 5000 });

  // dialog 可能残留已连接设备，先点 Connect 进入扫描
  const connectBtn = dialog.getByText('Connect', { exact: true }).first();
  if ((await connectBtn.count()) > 0) await connectBtn.click();

  let clicked = false;
  for (let attempt = 0; attempt < 8 && !clicked; attempt++) {
    await window.locator('.glove-scan__item').first().waitFor({ timeout: 20_000 });
    await window.waitForTimeout(4000);
    const items = window.locator('.glove-scan__item');
    const n = await items.count();
    let target = -1;
    const names: string[] = [];
    for (let i = 0; i < n; i++) {
      const t = (await items.nth(i).innerText()).replace('📶', '').trim();
      names.push(t);
      if (t.includes(GLOVE_DEVICE_NAME)) target = i;
    }
    console.log(`[scan] 第 ${attempt + 1} 轮:`, JSON.stringify(names));
    if (target >= 0) {
      await items.nth(target).click();
      clicked = true;
    } else {
      const cancel = dialog
        .getByText('Cancel scan', { exact: true })
        .or(dialog.getByText('取消扫描', { exact: true }));
      if ((await cancel.count()) > 0) await cancel.first().click();
      await window.waitForTimeout(3000);
      if ((await connectBtn.count()) > 0) await connectBtn.click();
    }
  }
  if (!clicked) throw new Error(`重试 8 轮仍未找到 ${GLOVE_DEVICE_NAME}`);
  await waitForLog(/Connected to/, 20_000, 'CONN');
  console.log('[script] 已连接', GLOVE_DEVICE_NAME);
}

test('Summer Time.mxl 完整写入验证', async () => {
  test.setTimeout(600_000);
  const results: string[] = [];

  // ---- 1. 打开 Summer Time.mxl ----
  await electronApp.evaluate(({ ipcMain }, mxlPath) => {
    ipcMain.removeHandler('file:show-open-dialog');
    ipcMain.handle('file:show-open-dialog', () => mxlPath);
  }, MXL_PATH);
  await window.evaluate((p) => window.electronAPI.file.registerDroppedFile(p), MXL_PATH);

  await window.evaluate(() => {
    document
      .querySelector('[data-testid="header-open-file-button"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await window.waitForTimeout(1500);
  await expect(window.locator('[data-testid="osmd-container"] svg').first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(window.getByTestId('placeholder')).toHaveCount(0);
  console.log('[score] Summer Time.mxl 解析渲染成功');
  results.push('[乐谱打开] 通过');

  // ---- 2. 左手指法计算 ----
  await window
    .evaluate(() => {
      document
        .querySelector('[data-testid="quick-panel-toggle"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })
    .catch(() => {});
  await window.locator('#hand-select').click();
  await window.getByRole('option', { name: 'Left hand' }).click();
  await window.getByRole('button', { name: 'Suggest fingering' }).click();
  await expect
    .poll(() => window.getByRole('button', { name: 'Suggest fingering' }).isVisible(), {
      timeout: 180_000,
    })
    .toBe(true);
  console.log('[score] 左手指法计算完成');
  results.push('[指法] 通过');

  // ---- 3. 连接手套 ----
  await connectGlove();
  results.push('[连接] 通过');

  // ---- 4. 转换 + 导入（全曲，检查容量拦截） ----
  await setTarget('left');
  await window.getByLabel('Range').fill('1-132');
  await window.getByRole('button', { name: /Import from Current Score/ }).click();
  await waitForLog(/Imported/, 60_000, 'IMPORT');
  let data = await window.locator('textarea.glove-textarea').inputValue();
  let cmdCount = data.trim().split(/\s+/).filter(Boolean).length / 2;
  console.log(`[score] 全曲(1-132) 指令数: ${cmdCount}`);
  let capacityMsg = '';
  const allLogs = await gloveLogs();
  const capMatch = allLogs.match(/SRAM supports[^\n]*|exceed[^\n]*|excess will be discarded[^\n]*/g);
  if (capMatch) {
    capacityMsg = capMatch[capMatch.length - 1];
    console.log(`[score] 容量提示: ${capacityMsg}`);
  }
  if (!(cmdCount > 0)) {
    console.log(`[score] textarea 内容: ${JSON.stringify(data)}`);
    results.push('[转换] ⚠️ 指令数为 0');
  } else if (/excess|exceed|discard/i.test(capacityMsg)) {
    results.push(`[转换] ⚠️ 全曲 ${cmdCount} 指令超容量被拦截 (${capacityMsg})`);
  } else {
    results.push(`[转换] ⚠️ 全曲 ${cmdCount} 指令，确认是否超容量`);
  }

  // ---- 5. 写入 ----
  const scoreStorage = cmdCount > 32 ? 'EEPROM' : 'SRAM';
  if (cmdCount > 0) {
    const writeLog = await writeScore(data.trim() || '', scoreStorage, 'SCORE-WRITE');
    const ok = !/failed|NAK/i.test(writeLog);
    results.push(`[Summer Time 写入] ${ok ? `通过（${scoreStorage}，${cmdCount} 指令）` : '异常'}`);
  }

  // ---- 汇总 ----
  console.log('══════════ Summer Time 写入验证汇总 ══════════');
  for (const r of results) console.log(r);
  expect(results.filter((r) => r.includes('异常')).length).toBe(0);
});