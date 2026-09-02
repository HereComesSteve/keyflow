import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright-core';
import path from 'node:path';
import {
  createIsolatedUserDataDir,
  removeIsolatedUserDataDir,
  userDataDirArg,
} from './e2e-user-data';

/**
 * 综合硬件验证：
 * 1. 连接 Glove_L
 * 2. 左(主)手 EEPROM 330 字节 ×5 轮（稳定性，检查丢包/重发）
 * 3. 切目标 Right → 右(从)手 EEPROM 330 字节（验证 DST_SLAVE 转发链）
 * 4. 双手播放状态确认
 * 前置：左右手上电、蓝牙开、固件为最新（lastWriteTarget/心跳修复）。运行:
 *   npx playwright test tests/e2e/glove-hw-all.spec.ts
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');
const GLOVE_DEVICE_NAME = process.env.GLOVE_DEVICE_NAME ?? 'Glove_L';
const HEX_330 = Array.from({ length: 330 }, (_, i) =>
  (i % 256).toString(16).padStart(2, '0').toUpperCase()
).join(' ');

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

/** 向指定 target 写 330 字节到 EEPROM，返回日志尾部的 Write result 行（只检查写入开始后的新日志） */
async function writeEeprom330(target: 'left' | 'right', label: string): Promise<string> {
  // 确保 Storage=EEPROM 分区0
  await window
    .getByLabel('Storage')
    .getByRole('button', { name: 'EEPROM' })
    .click()
    .catch(() => {});
  await window.locator('textarea.glove-textarea').fill(HEX_330);
  const logStart = await window.locator('.glove-log__line').count();
  await window.getByText('Write score', { exact: true }).click();
  // 等新出现 "Write result" 或 "Write failed" 行（避开历史左手日志）
  const deadline = Date.now() + 180_000;
  let logs = '';
  let last = '';
  while (Date.now() < deadline) {
    const n = await window.locator('.glove-log__line').count();
    const out: string[] = [];
    for (let i = logStart; i < n; i++) out.push((await window.locator('.glove-log__line').nth(i).innerText()).trim());
    logs = out.join('\n');
    if (/Write result|Write failed/.test(logs)) break;
    const tail = logs.split('\n').slice(-6).join(' | ');
    if (tail !== last) {
      last = tail;
      console.log(`[${label}] ..${tail}`);
    }
    await window.waitForTimeout(1000);
  }
  const tail = logs
    .split('\n')
    .filter((l) => /Write|result|Sent|NAK|retries/i.test(l));
  console.log(`[${label}]`, tail.slice(-6));
  return tail.join('\n');
}

test('综合验证：连接→左手EEPROM×5轮→右手EEPROM→播放', async () => {
  test.setTimeout(600_000);
  const results: string[] = [];

  // ---- 1. 打开手套面板 ----
  await window
    .evaluate(() => {
      document
        .querySelector('[data-testid="header-glove-button"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })
    .catch(() => {});
  const dialog = window.getByRole('dialog', { name: 'Bluetooth glove connection' });
  await dialog.waitFor({ timeout: 5000 });

  // ---- 2. 连接 Glove_L（带重试扫描） ----
  await dialog.getByText('Connect', { exact: true }).first().click();
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
      await dialog.getByText('Connect', { exact: true }).first().click();
    }
  }
  if (!clicked) throw new Error(`重试 8 轮仍未找到 ${GLOVE_DEVICE_NAME}`);
  await waitForLog(/Connected to/, 20_000);
  console.log('[hw] 已连接 Glove_L');
  results.push('[连接] 通过');

  // ---- 3. 左手 EEPROM 330 字节 ×5 轮（稳定性） ----
  let leftOkRounds = 0;
  const leftRetries: number[] = [];
  for (let round = 1; round <= 5; round++) {
    const tail = await writeEeprom330('left', `L-round${round}`);
    const ok = tail.includes('330/330') && !/NAK|failed/i.test(tail);
    const retries = parseInt(tail.match(/retries (\d+)/)?.[1] ?? '0', 10);
    leftRetries.push(retries);
    ok ? leftOkRounds++ : null;
    results.push(`[左手 EEPROM 330B 第${round}轮] ${ok ? '通过(retries=' + retries + ')' : '异常'}`);
  }
  console.log('[hw] 左手 5 轮 retries:', JSON.stringify(leftRetries));

  // ---- 4. 切目标 Right 并写入右手机 EEPROM 330 字节 ----
  await window.getByText('Right', { exact: true }).first().click();
  await window.waitForTimeout(500);
  const rightTail = await writeEeprom330('right', 'RIGHT');
  const rightOk = rightTail.includes('330/330') && !/NAK|failed/i.test(rightTail);
  results.push(`[右手 EEPROM 330B] ${rightOk ? '通过' : '异常'}`);
  console.log('[hw] right write tail:', rightTail.split('\n').slice(-8));

  // ---- 5. 双手 EEPROM 播放（各 1.5s）确认 ACK ----
  // 目标仍在 right
  await window.getByText('EEPROM play', { exact: true }).click();
  await window.waitForTimeout(1500);
  await window.locator('button.glove-btn', { hasText: 'Stop' }).click();
  await window.getByText('Left', { exact: true }).first().click();
  await window.waitForTimeout(300);
  await window.getByText('EEPROM play', { exact: true }).click();
  await window.waitForTimeout(1500);
  await window.locator('button.glove-btn', { hasText: 'Stop' }).click();
  const playLogs = await gloveLogs();
  const playOk = !/NAK|failed/i.test(playLogs);
  results.push(`[双手 EEPROM 播放] ${playOk ? '通过' : '异常'}`);
  console.log('[hw] play last logs:', playLogs.split('\n').slice(-4));

  // ---- 汇总 ----
  console.log('══════════ 综合验证汇总 ══════════');
  for (const r of results) console.log(r);
  expect(results.filter((r) => r.includes('异常')).length).toBe(0);
  expect(leftOkRounds).toBe(5);
});