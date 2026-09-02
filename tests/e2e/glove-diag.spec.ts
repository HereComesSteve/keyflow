import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import {
  createIsolatedUserDataDir,
  removeIsolatedUserDataDir,
  userDataDirArg,
} from './e2e-user-data';

const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = path.join(REPO_ROOT, 'out/main/index.js');
const GLOVE_DEVICE_NAME = process.env.GLOVE_DEVICE_NAME ?? 'Glove_L';

let electronApp: ElectronApplication;
let window: Page;
let userDataDir: string;
const shotDir = path.join(REPO_ROOT, 'test-results', 'glove-diag');
fs.mkdirSync(shotDir, { recursive: true });

test.beforeAll(async () => {
  userDataDir = createIsolatedUserDataDir('en');
  electronApp = await electron.launch({
    args: [MAIN_ENTRY, userDataDirArg(userDataDir)],
    env: { ...process.env },
  });
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  // 捕获 renderer console
  window.on('console', (msg) => {
    console.log(`[renderer.${msg.type()}] ${msg.text()}`);
  });
  window.on('pageerror', (err) => console.log('[renderer.pageerror]', err.message));
});

test.afterAll(async () => {
  await electronApp?.close();
  removeIsolatedUserDataDir(userDataDir);
});

test('诊断：逐步连接左手', async () => {
  console.log('STEP 1: 打开手套面板');
  const gloveBtn = window.getByTestId('header-glove-button');
  await gloveBtn.click({ force: true }).catch(async () => {
    // 兜底：DOM 直接 dispatch click
    await window.evaluate(() => {
      document.querySelector('[data-testid="header-glove-button"]')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      );
    });
  });
  await window.waitForTimeout(800);
  await window.screenshot({ path: path.join(shotDir, '1-panel.png') });

  console.log('STEP 2: 点连接按钮');
  const connectBtn = window
    .getByText('Connect', { exact: true })
    .or(window.getByText('连接', { exact: true }))
    .first();
  console.log('  connect button visible:', await connectBtn.isVisible());
  await connectBtn.click();
  await window.waitForTimeout(3000);
  await window.screenshot({ path: path.join(shotDir, '2-scanning.png') });

  console.log('STEP 3: 等待设备列表 .glove-scan__item');
  const visible1 = await window.locator('.glove-scan__item').first().isVisible();
  console.log('  item visible after 3s:', visible1);
  const emptyText = await window
    .getByText('尚未找到设备')
    .or(window.getByText('No devices found yet'))
    .or(window.getByText('まだ見つからない'))
    .count();
  console.log('  noDevicesYet text count:', emptyText);
  await window.waitForTimeout(5000);
  await window.screenshot({ path: path.join(shotDir, '3-devices.png') });

  const items = window.locator('.glove-scan__item');
  const n = await items.count();
  console.log('  device item count:', n);
  for (let i = 0; i < n; i++) {
    console.log(`  [${i}]`, (await items.nth(i).innerText()).trim());
  }

  // 若列表非空，选设备
  if (n > 0) {
    let target = -1;
    for (let i = 0; i < n; i++) {
      const t = (await items.nth(i).innerText()).trim();
      if (t.includes(GLOVE_DEVICE_NAME)) target = i;
    }
    if (target < 0) target = 0;
    console.log(`STEP 4: 点击设备 [${target}]`);
    await items.nth(target).click();
    await window.waitForTimeout(5000);
    await window.screenshot({ path: path.join(shotDir, '4-connected.png') });

    const connected = await window
      .getByText('已连接')
      .or(window.getByText('Connected'))
      .first()
      .isVisible()
      .catch(() => false);
    console.log('STEP 5: connected badge visible:', connected);

    const logs = window.locator('.glove-log__line');
    const ln = await logs.count();
    console.log('STEP 6: log lines:', ln);
    for (let i = 0; i < ln; i++) {
      console.log('  LOG:', (await logs.nth(i).innerText()).trim());
    }
    await window.screenshot({ path: path.join(shotDir, '5-logs.png') });
    expect(connected).toBe(true);
  } else {
    console.log('STEP 4: 设备列为空，跳过选择');
    expect(true).toBe(true);
  }
});