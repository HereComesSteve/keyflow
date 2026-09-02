import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright-core';
import path from 'node:path';
import {
  createIsolatedUserDataDir,
  removeIsolatedUserDataDir,
  userDataDirArg,
} from './e2e-user-data';

/**
 * 从机(右)链路断链 / 恢复检测（单流程）：
 * 前置：右手机已断电（App 连接后固件按 HELLO 重置链路状态，重新检测失联）。
 * 运行:
 *   npx playwright test tests/e2e/glove-link.spec.ts
 * 阶段1：连接后 ~15s 应上报 "Slave link LOST"（检查失联检测）
 * 阶段2：给右手机上电后 ~15s 应上报 "Slave link restored"（检查恢复检测）
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

async function waitForLog(pred: RegExp, timeoutMs = 90_000, label = ''): Promise<string> {
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

  await dialog.getByText('Connect', { exact: true }).first().click();
  let clicked = false;
  for (let attempt = 0; attempt < 8 && !clicked; attempt++) {
    await window.locator('.glove-scan__item').first().waitFor({ timeout: 20_000 });
    await window.waitForTimeout(4000);
    const items = window.locator('.glove-scan__item');
    const n = await items.count();
    let target = -1;
    for (let i = 0; i < n; i++) {
      const t = (await items.nth(i).innerText()).replace('📶', '').trim();
      if (t.includes(GLOVE_DEVICE_NAME)) target = i;
    }
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
  await waitForLog(/Connected to/, 20_000, 'CONN');
}

test('断链检测 + 恢复检测（右手机断电 → LOST → 上电 → restored）', async () => {
  test.setTimeout(480_000);
  await connectGlove();
  console.log('[link] 已连接（右手机应处于断电状态），等待失联上报...');
  const lost = await waitForLog(/Slave link LOST/, 90_000, 'LOST');
  console.log('[link] 断链确认:', lost.split('\n').filter((l) => /Slave link/i.test(l)));
  expect(lost).toMatch(/Slave link LOST/);

  console.log('[link] 请现在给右手机重新上电，等待恢复上报...');
  const restored = await waitForLog(/Slave link restored/, 300_000, 'RESTORE');
  console.log('[link] 恢复确认:', restored.split('\n').filter((l) => /Slave link/i.test(l)));
  expect(restored).toMatch(/Slave link restored/);
});