import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright-core';
import path from 'node:path';
import {
  createIsolatedUserDataDir,
  removeIsolatedUserDataDir,
  userDataDirArg,
} from './e2e-user-data';

/**
 * 聚焦诊断：连接后单独发 WRITE_BEGIN（SRAM），观察固件是否回 ACK/NAK。
 * 运行: npx playwright test tests/e2e/glove-begin.spec.ts
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
  window.on('console', (m) => console.log(`[renderer.${m.type()}] ${m.text()}`));
  window.on('pageerror', (e) => console.log('[renderer.pageerror]', e.message));
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

test('只测 WRITE_BEGIN（SRAM 4 条指令）', async () => {
  // 打开面板
  await window
    .evaluate(() => {
      document
        .querySelector('[data-testid="header-glove-button"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })
    .catch(() => {});
  const dialog = window.getByRole('dialog', { name: 'Bluetooth glove connection' });
  await dialog.waitFor({ timeout: 5000 });

  // 连接（带重试扫描：设备列表需要几秒才填充完整）
  await dialog.getByText('Connect', { exact: true }).first().click();
  let clicked = false;
  for (let attempt = 0; attempt < 3 && !clicked; attempt++) {
    await window.locator('.glove-scan__item').first().waitFor({ timeout: 20_000 });
    const items = window.locator('.glove-scan__item');
    const n = await items.count();
    let target = -1;
    for (let i = 0; i < n; i++) {
      const t = (await items.nth(i).innerText()).replace('📶', '').trim();
      console.log('  设备:', t);
      if (t.includes(GLOVE_DEVICE_NAME)) target = i;
    }
    if (target >= 0) {
      await items.nth(target).click();
      clicked = true;
    } else {
      // 重扫：取消再连
      console.log('  本轮未找到，重扫...');
      const cancel = dialog
        .getByText('Cancel scan', { exact: true })
        .or(dialog.getByText('取消扫描', { exact: true }));
      if (await cancel.count()) await cancel.first().click();
      await window.waitForTimeout(1500);
      await dialog.getByText('Connect', { exact: true }).first().click();
    }
  }
  if (!clicked) throw new Error('重试 3 次仍未找到 Glove_L');
  await waitForLog(/Connected to/, 15_000);
  console.log('== 已连接 ==');

  // 填 4 条指令写 SRAM
  await window.locator('textarea.glove-textarea').fill('00 10 20 22 30 01 40 33');
  await window.getByText('Write score', { exact: true }).click();

  // 观察 10s 日志
  await window.waitForTimeout(10_000);
  const logs = await gloveLogs();
  console.log('== 写入 SRAM 后日志 ==\n', logs);

  const hasAck = /ACK/.test(logs);
  const hasNak = /NAK/.test(logs);
  const hasFailed = /failed/i.test(logs);
  expect(hasFailed).toBe(true); // 预期当前失败，供观察原因
});