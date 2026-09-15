import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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
const staleFixtureKey = 'e2e:stale-delete';
const rootFixtureKey = 'e2e:root-workspace';
await mkdir(artifacts, { recursive: true });
await execFileAsync('git', ['init'], { cwd: fixtureRoot, windowsHide: true });
process.env.LOCALAPPDATA = join(fixtureRoot, 'runtime');
await publishExecutionContext({ cwd: fixtureRoot, contextKey: fixtureKey, sessionId: 'e2e', source: 'e2e' });
await publishExecutionContext({ cwd: fixtureRoot, contextKey: staleFixtureKey, sessionId: 'e2e-stale', source: 'e2e', status: 'stale' });
await publishExecutionContext({ cwd: root, contextKey: rootFixtureKey, sessionId: 'e2e-root', source: 'e2e' });
process.env.LOCALBOARD_E2E_USER_DATA = join(fixtureRoot, 'electron-user-data');

const electronApp = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, LOCALBOARD_DISABLE_SINGLE_INSTANCE: '1' } });
const pageErrors = [];
try {
  const main = await findWindow(electronApp, (page) => page.locator('.nav').count());
  main.on('pageerror', (error) => pageErrors.push(error.message));
  await main.locator('#page-title').waitFor({ state: 'visible' });
  await main.screenshot({ path: resolve(artifacts, 'navigation-initial.png') });

  assert.equal(await main.locator('#page-title').textContent(), '个人待办');
  assert.equal(await main.locator('.nav button.active').count(), 1);
  assert.equal(await main.locator('.nav button[aria-current="page"]').count(), 1);
  assert.equal(await main.locator('[data-project-path]').count(), 2);
  assert.equal(await main.locator('[data-todo-scope="global"]').count(), 1);
  await main.locator('[data-todo-scope="global"]').click();
  await main.waitForFunction(() => document.querySelector('.scope-banner strong')?.textContent === '全局个人待办');
  assert.equal(await main.locator('[data-todo-scope="global"]').getAttribute('aria-selected'), 'true');
  await main.locator('#add-todo').click();
  await main.locator('.dialog input[name="title"]').fill('E2E 全局待办');
  await main.locator('.dialog button.primary').click();
  const globalTodo = main.locator('.todo-card').filter({ hasText: 'E2E 全局待办' });
  await globalTodo.waitFor();
  await globalTodo.locator('[data-edit-todo]').click();
  await main.locator('.dialog input[name="title"]').fill('E2E 全局待办（已编辑）');
  await main.locator('.dialog button.primary').click();
  const editedGlobalTodo = main.locator('.todo-card').filter({ hasText: 'E2E 全局待办（已编辑）' });
  await editedGlobalTodo.waitFor();
  main.once('dialog', (dialog) => dialog.accept());
  await editedGlobalTodo.locator('[data-remove-todo]').click();
  await editedGlobalTodo.waitFor({ state: 'detached' });
  await main.locator('[data-todo-scope="repository"]').click();
  await main.waitForFunction(() => document.querySelector('.scope-banner strong')?.textContent === '当前仓库待办');

  await main.locator('[data-tab="git"]').click();
  await main.locator('#git-diff').waitFor();
  await main.screenshot({ path: resolve(artifacts, 'navigation-git.png') });

  // Rapid normal clicks reproduce the stale-request bug that previously let old views win.
  for (const tab of ['agents', 'notes']) await main.locator(`[data-tab="${tab}"]`).click();
  await main.waitForFunction(() => document.querySelector('#page-title')?.textContent === '执行便签' && !document.querySelector('#view .loading'));
  await main.waitForTimeout(1500);
  assert.equal(await main.locator('#page-title').textContent(), '执行便签');
  assert.equal(await main.locator('.nav button.active').getAttribute('data-tab'), 'notes');
  assert.deepEqual(pageErrors, []);

  const fixtureRow = main.locator('#view .row').filter({ hasText: fixtureName });
  await fixtureRow.first().locator('[data-switch-workspace]').click();
  await main.waitForFunction((name) => document.querySelector('#workspace-switcher strong')?.textContent === name && !document.querySelector('#view .loading'), fixtureName);
  assert.equal(await main.locator('#page-title').textContent(), '个人待办');
  assert.match(await main.locator('#workspace-switcher').textContent(), /GitHub 未配置/);
  await main.screenshot({ path: resolve(artifacts, 'workspace-switched.png') });

  await main.locator('#workspace-switcher').click();
  await main.waitForFunction(() => document.querySelector('#page-title')?.textContent === 'LocalBoard 状态' && !document.querySelector('#view .loading'));
  await main.locator('[data-project-path]').evaluateAll((buttons, target) => {
    const button = buttons.find((item) => item.dataset.projectPath.toLowerCase() === target.toLowerCase());
    if (!button) throw new Error(`Project button not found: ${target}`);
    button.click();
  }, root);
  await main.waitForFunction(() => document.querySelector('#workspace-switcher strong')?.textContent === 'localboard' && document.querySelector('#page-title')?.textContent === '个人待办' && !document.querySelector('#view .loading'));

  await main.locator('[data-tab="notes"]').click();
  await main.waitForFunction(() => !document.querySelector('#view .loading'));
  const sticky = await findWindow(electronApp, (page) => page.locator('.sticky').count());
  await sticky.screenshot({ path: resolve(artifacts, 'activity-sticky.png') });
  assert.equal(await sticky.locator('.bookmark-tabs').count(), 1);
  assert.equal(await sticky.locator('[data-sticky-project]').count(), 2);
  assert.equal(await sticky.locator('[data-sticky-project][aria-selected="true"]').count(), 1);
  const staleDelete = sticky.locator(`[data-remove-context="${staleFixtureKey}"]`);
  await staleDelete.waitFor({ state: 'visible' });
  await staleDelete.click();
  await sticky.waitForFunction((key) => !document.querySelector(`[data-remove-context="${key}"]`), staleFixtureKey);
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
      contentFitsWidth: content.right <= innerWidth,
      projectScrollbar: getComputedStyle(document.querySelector('.project-list')).scrollbarWidth
    };
  });
  assert.equal(fit.innerWidth <= 960 && fit.innerWidth >= 900, true);
  assert.equal(fit.horizontalOverflow, false);
  assert.equal(fit.sidebarFits, true);
  assert.equal(fit.contentFitsWidth, true);
  assert.equal(fit.projectScrollbar, 'none');
  await main.screenshot({ path: resolve(artifacts, 'navigation-minimum-window.png') });

  console.log(JSON.stringify({ ok: true, pageErrors, fit, screenshots: artifacts }, null, 2));
} finally {
  await electronApp.close().catch(() => {});
  await brokerRequest(`/v1/contexts/${encodeURIComponent(fixtureKey)}`, { method: 'DELETE' }).catch(() => {});
  await brokerRequest(`/v1/contexts/${encodeURIComponent(staleFixtureKey)}`, { method: 'DELETE' }).catch(() => {});
  await brokerRequest(`/v1/contexts/${encodeURIComponent(rootFixtureKey)}`, { method: 'DELETE' }).catch(() => {});
  try {
    const endpoint = JSON.parse(await readFile(join(process.env.LOCALAPPDATA, 'LocalBoard', 'broker.json'), 'utf8'));
    process.kill(endpoint.pid);
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  } catch {}
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
  const diagnostics = [];
  for (const page of app.windows()) diagnostics.push({ url: page.url(), title: await page.title().catch(() => ''), body: (await page.locator('body').innerText().catch(() => '')).slice(0, 500), context: await page.evaluate(() => window.localboard?.context?.().then(() => 'ok').catch((error) => error.message)).catch(() => null) });
  throw new Error(`LocalBoard main window did not appear: ${JSON.stringify(diagnostics)}`);
}

async function startViaCli(cwd) {
  const { stdout } = await execFileAsync(process.execPath, [
    resolve(root, 'src/cli.mjs'), 'start', '--repo', cwd, '--json'
  ], { cwd: root, windowsHide: true });
  const result = JSON.parse(stdout);
  assert.equal(result.launched, true);
  assert.equal(result.mode, 'background');
  assert.equal(result.cwd, cwd);
}
