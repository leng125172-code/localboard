import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';
import { brokerRequest } from '../src/core/broker-client.mjs';
import { publishExecutionContext } from '../src/core/context-publisher.mjs';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const artifacts = resolve(root, '.artifacts');
const fixtureRoot = await mkdtemp(join(tmpdir(), 'localboard-ui-worktree-'));
const fixtureName = basename(fixtureRoot);
const fixtureKey = 'e2e:workspace-switch';
await mkdir(artifacts, { recursive: true });
await execFileAsync('git', ['init'], { cwd: fixtureRoot, windowsHide: true });
await publishExecutionContext({ cwd: fixtureRoot, contextKey: fixtureKey, sessionId: 'e2e', source: 'e2e' });

const electronApp = await electron.launch({ args: ['.'], cwd: root });
const pageErrors = [];
try {
  const main = await findWindow(electronApp, (page) => page.locator('.nav').count());
  main.on('pageerror', (error) => pageErrors.push(error.message));
  await main.locator('#page-title').waitFor({ state: 'visible' });
  await main.screenshot({ path: resolve(artifacts, 'navigation-initial.png') });

  assert.equal(await main.locator('#page-title').textContent(), '个人待办');
  assert.equal(await main.locator('.nav button.active').count(), 1);
  assert.equal(await main.locator('.nav button[aria-current="page"]').count(), 1);

  await main.locator('[data-tab="project"]').click();
  await main.locator('#error .error').waitFor();
  assert.match(await main.locator('#error').textContent(), /projectNumber/);
  await main.screenshot({ path: resolve(artifacts, 'navigation-project-error.png') });

  // Rapid normal clicks reproduce the stale-request bug that previously let old views win.
  for (const tab of ['issues', 'prs', 'actions', 'agents', 'notes']) await main.locator(`[data-tab="${tab}"]`).click();
  await main.waitForFunction(() => document.querySelector('#page-title')?.textContent === '屏幕便签' && !document.querySelector('#view .loading'));
  await main.waitForTimeout(1500);
  assert.equal(await main.locator('#page-title').textContent(), '屏幕便签');
  assert.equal(await main.locator('.nav button.active').getAttribute('data-tab'), 'notes');
  assert.deepEqual(pageErrors, []);

  const fixtureRow = main.locator('#view .row').filter({ hasText: fixtureName });
  await fixtureRow.locator('[data-switch-workspace]').click();
  await main.waitForFunction((name) => document.querySelector('#workspace-switcher strong')?.textContent === name && !document.querySelector('#view .loading'), fixtureName);
  assert.equal(await main.locator('#page-title').textContent(), '个人待办');
  assert.match(await main.locator('#workspace-switcher').textContent(), /GitHub 未配置/);
  await main.screenshot({ path: resolve(artifacts, 'workspace-switched.png') });

  await main.locator('#workspace-switcher').click();
  await main.waitForFunction(() => document.querySelector('#page-title')?.textContent === '屏幕便签' && !document.querySelector('#view .loading'));
  const originalRow = main.locator('#view .row').filter({ hasText: root });
  await originalRow.first().locator('[data-switch-workspace]').click();
  await main.waitForFunction(() => document.querySelector('#workspace-switcher strong')?.textContent === 'localboard');

  await main.locator('[data-tab="notes"]').click();
  await main.waitForFunction(() => !document.querySelector('#view .loading'));
  const sticky = await findWindow(electronApp, (page) => page.locator('.sticky').count());
  await sticky.screenshot({ path: resolve(artifacts, 'activity-sticky.png') });
  const nativeSticky = await electronApp.browserWindow(sticky);
  await sticky.locator('[data-window-action="minimize"]').click();
  await main.waitForTimeout(150);
  assert.equal(await nativeSticky.evaluate((window) => window.isMinimized()), true);
  await nativeSticky.evaluate((window) => { window.restore(); window.show(); });
  await sticky.locator('[data-window-action="hide"]').click();
  assert.equal(await nativeSticky.evaluate((window) => window.isVisible()), false);

  const beforeStickyCount = electronApp.windows().length;
  await main.locator('#open-note').click();
  await main.waitForTimeout(200);
  assert.equal(await nativeSticky.evaluate((window) => window.isVisible()), true);
  await main.bringToFront();
  await main.locator('#open-note').click();
  assert.equal(electronApp.windows().length, beforeStickyCount);

  const nativeMain = await electronApp.browserWindow(main);
  await nativeMain.evaluate((window) => window.setSize(960, 620));
  await main.waitForTimeout(250);
  const fit = await main.evaluate(() => {
    const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
    const content = document.querySelector('.content').getBoundingClientRect();
    return {
      innerWidth,
      innerHeight,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      sidebarFits: sidebar.top >= 0 && sidebar.bottom <= innerHeight,
      contentFitsWidth: content.right <= innerWidth
    };
  });
  assert.equal(fit.innerWidth <= 960 && fit.innerWidth >= 900, true);
  assert.equal(fit.horizontalOverflow, false);
  assert.equal(fit.sidebarFits, true);
  assert.equal(fit.contentFitsWidth, true);
  await main.screenshot({ path: resolve(artifacts, 'navigation-minimum-window.png') });

  console.log(JSON.stringify({ ok: true, pageErrors, fit, screenshots: artifacts }, null, 2));
} finally {
  await electronApp.close().catch(() => {});
  await brokerRequest(`/v1/contexts/${encodeURIComponent(fixtureKey)}`, { method: 'DELETE' }).catch(() => {});
  await rm(fixtureRoot, { recursive: true, force: true });
}

async function findWindow(app, predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      if (await predicate(page)) return page;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('LocalBoard main window did not appear');
}
