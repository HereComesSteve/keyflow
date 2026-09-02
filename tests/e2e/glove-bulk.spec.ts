import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright-core';
import path from 'node:path';
import {
  createIsolatedUserDataDir,
  removeIsolatedUserDataDir,
  userDataDirArg,
} from './e2e-user-data';

/**
 * 批量写入压力验证：连接 Glove_L → 写 330 字节（165 指令）→ SRAM / EEPROM + 播放。
 * 用于验证 164 指令大乐谱传输的丢包/CRC 问题是否解决。
 * 运行: npx playwright test tests/e2e/glove-bulk.spec.ts
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');
const GLOVE_DEVICE_NAME = process.env.GLOVE_DEVICE_NAME ?? 'Glove_L';
const HEX_330 = '00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F 10 11 12 13 14 15 16 17 18 19 1A 1B 1C 1D 1E 1F 20 21 22 23 24 25 26 27 28 29 2A 2B 2C 2D 2E 2F 30 31 32 33 34 35 36 37 38 39 3A 3B 3C 3D 3E 3F 40 41 42 43 44 45 46 47 48 49 4A 4B 4C 4D 4E 4F 50 51 52 53 54 55 56 57 58 59 5A 5B 5C 5D 5E 5F 60 61 62 63 64 65 66 67 68 69 6A 6B 6C 6D 6E 6F 70 71 72 73 74 75 76 77 78 79 7A 7B 7C 7D 7E 7F 80 81 82 83 84 85 86 87 88 89 8A 8B 8C 8D 8E 8F 90 91 92 93 94 95 96 97 98 99 9A 9B 9C 9D 9E 9F A0 A1 A2 A3 A4 A5 A6 A7 A8 A9 AA AB AC AD AE AF B0 B1 B2 B3 B4 B5 B6 B7 B8 B9 BA BB BC BD BE BF C0 C1 C2 C3 C4 C5 C6 C7 C8 C9 CA CB CC CD CE CF D0 D1 D2 D3 D4 D5 D6 D7 D8 D9 DA DB DC DD DE DF E0 E1 E2 E3 E4 E5 E6 E7 E8 E9 EA EB EC ED EE EF F0 F1 F2 F3 F4 F5 F6 F7 F8 F9 FA FB FC FD FE FF 00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F 10 11 12 13 14 15 16 17 18 19 1A 1B 1C 1D 1E 1F 20 21 22 23 24 25 26 27 28 29 2A 2B 2C 2D 2E 2F 30 31 32 33 34 35 36 37 38 39 3A 3B 3C 3D 3E 3F 40 41 42 43 44 45 46 47 48 49';

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

test('批量写入 330 字节/165 指令 → SRAM + EEPROM + 播放', async () => {
  test.setTimeout(300_000);
  const results: string[] = [];

  // 打开手套面板
  await window
    .evaluate(() => {
      document
        .querySelector('[data-testid="header-glove-button"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })
    .catch(() => {});
  const dialog = window.getByRole('dialog', { name: 'Bluetooth glove connection' });
  await dialog.waitFor({ timeout: 5000 });

  // 连接 Glove_L（带重试扫描）
  await dialog.getByText('Connect', { exact: true }).first().click();
  let clicked = false;
  for (let attempt = 0; attempt < 8 && !clicked; attempt++) {
    await window.locator('.glove-scan__item').first().waitFor({ timeout: 20_000 });
    await window.waitForTimeout(4000); // 等待列表填充完整
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
  if (!clicked) throw new Error(`重试 5 轮仍未找到 ${GLOVE_DEVICE_NAME}`);
  await waitForLog(/Connected to/, 20_000);
  console.log('[bulk] 已连接');

  // ---- SRAM 容量约束验证：165 条 > 32 条，应被 UI 拦截（不改写硬件） ----
  await window.locator('textarea.glove-textarea').fill(HEX_330);
  await window.getByText('Write score', { exact: true }).click();
  await window.waitForTimeout(1500);
  const sramLogs = await gloveLogs();
  const sramBlocked =
    sramLogs.includes('excess will be discarded') && !sramLogs.includes('Write result');
  console.log('[SRAM 330B] 拦截日志:', sramLogs.split('\n').slice(-3));
  results.push(`[SRAM 330B] ${sramBlocked ? '正确拦截（容量32条限制生效）' : '异常：未被拦截'}`);

  // ---- EEPROM 批量写入 330 字节（165 指令，真实传输验证） ----
  await window.getByLabel('Storage').getByRole('button', { name: 'EEPROM' }).click();
  await window.locator('textarea.glove-textarea').fill(HEX_330);
  await window.getByText('Write score', { exact: true }).click();
  const eepromLogs = await waitForLog(/Write result/, 240_000, 'EEPROM');
  const eepromTail = eepromLogs.split('\n').filter((l) => /Write|result|Sent|NAK|retries/i.test(l));
  console.log('[bulk EEPROM]', eepromTail.slice(-8));
  const eepromOk =
    eepromLogs.includes('330/330') &&
    !/CRC fail|CRC mismatch|NAK|failed/i.test(eepromLogs);
  results.push(`[EEPROM 330B] ${eepromOk ? '通过 330/330' : '异常'}`);

  // ---- SRAM 播放 2s 验证 ----
  await window.getByText('SRAM play', { exact: true }).click();
  await window.waitForTimeout(2000);
  await window.locator('button.glove-btn', { hasText: 'Stop' }).click();
  const playLogs = await gloveLogs();
  results.push(`[SRAM 播放] ${!/NAK|failed/i.test(playLogs) ? '通过' : '异常'}`);

  console.log('══════════ 批量写入汇总 ══════════');
  for (const r of results) console.log(r);

  expect(results.filter((r) => r.includes('异常')).length).toBe(0);
});
