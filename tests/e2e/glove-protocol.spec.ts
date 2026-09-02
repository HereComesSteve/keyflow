import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright-core';
import path from 'node:path';
import {
  createIsolatedUserDataDir,
  removeIsolatedUserDataDir,
  userDataDirArg,
} from './e2e-user-data';

/**
 * 真机联调（单测试串行）：
 * 连接 Glove_L → HELLO → BPM → 写 SRAM → 播放/停止 → 写 EEPROM → EEPROM 播放/停止。
 * 前置：PC 蓝牙开、左右手上电。运行:
 *   npm run build && npx playwright test tests/e2e/glove-protocol.spec.ts
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');
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

async function waitForLog(pred: RegExp, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let logs = '';
  while (Date.now() < deadline) {
    logs = await gloveLogs();
    if (pred.test(logs)) return logs;
    await window.waitForTimeout(300);
  }
  throw new Error(`日志未出现 ${pred}。当前日志:\n${logs}`);
}

test('串行验证：连接→BPM→SRAM→播放→EEPROM', async () => {
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

  // ---- 2. 连接 Glove_L ----
  await dialog
    .getByText('Connect', { exact: true })
    .first()
    .click();
  await window.locator('.glove-scan__item').first().waitFor({ timeout: 20_000 });
  const items = window.locator('.glove-scan__item');
  const n = await items.count();
  let target = -1;
  const names: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = (await items.nth(i).innerText()).replace('📶', '').trim();
    names.push(t);
    if (t.includes(GLOVE_DEVICE_NAME)) target = i;
  }
  console.log('[2] 发现设备:', JSON.stringify(names));
  if (target < 0) throw new Error(`未找到 ${GLOVE_DEVICE_NAME}`);
  await items.nth(target).click();

  // 等待日志出现 Connected（连接完成 = HELLO 握手成功）
  const connLogs = await waitForLog(/Connected to/, 15_000);
  results.push(`[HELLO] ${connLogs.split('\n').filter((l) => l.includes('Connected'))[0]}`);
  console.log('[HELLO]', connLogs.split('\n').filter((l) => l.includes('Connected'))[0]);

  // ---- 3. BPM=120 ----
  const bpmCard = window.locator('.glove-card').filter({ hasText: 'Current:' }).first();
  await bpmCard.locator('input').fill('120');
  await bpmCard.getByText('Set', { exact: true }).click();
  await waitForLog(/BPM/i);
  const bpmLogs = await gloveLogs();
  if (/NAK|failed|失敗/i.test(bpmLogs)) results.push('[BPM] ⚠️ 见 NAK/失败');
  else results.push('[BPM] ACK OK');
  console.log('[BPM] logs:', bpmLogs.split('\n').filter((l) => /BPM|NAK|Set/i.test(l)));

  // ---- 4. 写 SRAM ----
  await window.locator('textarea.glove-textarea').fill('00 10 20 22 30 01 40 33');
  await window.getByText('Write score', { exact: true }).click();
  await waitForLog(/Write complete|完成/i, 30_000);
  const sramLogs = await gloveLogs();
  const okWrite = !/NAK|CRC|failed|失敗/i.test(sramLogs);
  results.push(`[SRAM 写] ${okWrite ? '通过' : '异常'}`);
  console.log('[SRAM write] logs tail:', sramLogs.split('\n').slice(-4));

  // ---- 5. SRAM 播放 / 停止 ----
  await window.getByText('SRAM play', { exact: true }).click();
  await window.waitForTimeout(1500);
  await window.getByText('Stop', { exact: true }).click();
  const playLogs = await gloveLogs();
  const okPlay = !/NAK|failed/i.test(playLogs);
  results.push(`[SRAM 播放] ${okPlay ? '通过' : '异常'}`);
  console.log('[SRAM play] last logs:', playLogs.split('\n').slice(-3));

  // ---- 6. 写 EEPROM 分区0 ----
  await window
    .getByLabel('Storage')
    .getByRole('button', { name: 'EEPROM' })
    .click();
  await window.locator('textarea.glove-textarea').fill('00 10 20 22 30 01 40 33');
  await window.getByText('Write score', { exact: true }).click();
  await waitForLog(/Write complete|完成/i, 30_000);
  const eepromLogs = await gloveLogs();
  const okEeprom = !/NAK|CRC|failed|失敗/i.test(eepromLogs);
  results.push(`[EEPROM 写] ${okEeprom ? '通过' : '异常'}`);
  console.log('[EEPROM write] logs tail:', eepromLogs.split('\n').slice(-4));

  // ---- 7. EEPROM 播放分区0 / 停止 ----
  await window.getByText('EEPROM play', { exact: true }).click();
  await window.waitForTimeout(1500);
  await window.getByText('Stop', { exact: true }).click();
  await window.waitForTimeout(800);
  const eepromPlayLogs = await gloveLogs();
  const okEepromPlay = !/NAK|failed/i.test(eepromPlayLogs);
  results.push(`[EEPROM 播放] ${okEepromPlay ? '通过' : '异常'}`);
  console.log('[EEPROM play] last logs:', eepromPlayLogs.split('\n').slice(-3));

  // ---- 汇总 ----
  console.log('══════════ 汇总 ══════════');
  for (const r of results) console.log(r);

  expect(
    results.filter((r) => r.includes('异常') || r.includes('⚠️') || r.includes('NAK')).length
  ).toBe(0);
});