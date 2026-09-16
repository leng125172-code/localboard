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
process.env.LOCALBOARD_BROKER_START_TIMEOUT_MS = '180000';
const fixtureContext = await publishExecutionContext({ cwd: fixtureRoot, contextKey: fixtureKey, sessionId: 'e2e', source: 'e2e' });
await brokerRequest(`/v1/projects/${encodeURIComponent(fixtureContext.repository.projectId)}`, { method: 'PATCH', body: { pinned: true } });
await publishExecutionContext({ cwd: fixtureRoot, contextKey: staleFixtureKey, sessionId: 'e2e-stale', source: 'e2e', status: 'stale' });
await publishExecutionContext({ cwd: root, contextKey: rootFixtureKey, sessionId: 'e2e-root', source: 'e2e' });
const seededContexts = await brokerRequest('/v1/contexts?includeEnded=false');
assert.equal(seededContexts.contexts.some((item) => item.contextKey === staleFixtureKey && item.status === 'stale'), true);
process.env.LOCALBOARD_E2E_USER_DATA = join(fixtureRoot, 'electron-user-data');

const electronApp = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, LOCALBOARD_DISABLE_SINGLE_INSTANCE: '1' } });
const pageErrors = [];
try {
  const main = await findWindow(electronApp, (page) => page.locator('.nav').count());
  main.on('pageerror', (error) => pageErrors.push(error.message));
  await main.waitForFunction(() => document.querySelector('#page-title')?.textContent === '仓库待办' && !document.querySelector('#view .loading'));
  await main.screenshot({ path: resolve(artifacts, 'navigation-initial.png') });

  assert.equal(await main.locator('.app-titlebar').count(), 1);
  assert.equal(await main.locator('.lb-icon').count() > 8, true);
  assert.equal(await main.locator('#page-title').textContent(), '仓库待办');
  assert.equal(await main.locator('.nav button.active').count(), 1);
  assert.equal(await main.locator('.nav button[aria-current="page"]').count(), 1);
  assert.equal(await main.locator('[data-project-path]').count(), 2);
  const nativeMainAtLaunch = await electronApp.browserWindow(main);
  assert.equal(await nativeMainAtLaunch.evaluate((window) => window.isMenuBarVisible()), false);
  await main.locator('#toggle-project-pane').click();
  await main.waitForFunction(() => document.querySelector('.shell')?.classList.contains('project-pane-expanded'));
  await main.locator('#project-search').fill(fixtureName);
  await main.waitForFunction(() => document.querySelectorAll('[data-project-path]').length === 1);
  assert.equal(await main.locator('[data-project-path]').count(), 1);
  await main.locator('#project-search').fill('');
  await main.screenshot({ path: resolve(artifacts, 'navigation-project-pane.png') });
  await main.locator('#toggle-project-pane').click();
  await main.waitForFunction(() => !document.querySelector('.shell')?.classList.contains('project-pane-expanded'));
  assert.equal(await main.locator('#global-todos-entry .lb-icon').count(), 1);
  await main.locator('#global-todos-entry').click();
  await main.waitForFunction(() => document.querySelector('.shell')?.classList.contains('global-workspace'));
  assert.equal(await main.locator('.sidebar').isVisible(), false);
  assert.equal(await main.locator('.todo-scope-tabs').count(), 0);
  await main.waitForFunction(() => document.querySelector('.scope-banner strong')?.textContent === '全局个人待办');
  await main.screenshot({ path: resolve(artifacts, 'navigation-global-todos.png') });
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
  await main.locator('[data-project-path]').evaluateAll((buttons, target) => {
    const button = buttons.find((item) => item.dataset.projectPath.toLowerCase() === target.toLowerCase());
    if (!button) throw new Error(`Project button not found: ${target}`);
    button.click();
  }, root);
  await main.waitForFunction(() => document.querySelector('.scope-banner strong')?.textContent === '当前仓库待办');

  await main.locator('[data-tab="settings"]').click();
  await main.locator('.settings-stack').waitFor();
  assert.equal(await main.locator('[name="theme"]').inputValue(), 'system');
  await main.locator('[name="theme"]').selectOption('dark');
  await main.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await main.screenshot({ path: resolve(artifacts, 'settings-dark.png') });
  await main.locator('#reset-settings').click();
  await main.waitForFunction(() => document.documentElement.dataset.theme === 'system');

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
  assert.equal(await main.locator('#page-title').textContent(), '仓库待办');
  assert.match(await main.locator('#workspace-switcher').textContent(), /GitHub 未配置/);
  await main.screenshot({ path: resolve(artifacts, 'workspace-switched.png') });

  await main.locator('#workspace-switcher').click();
  await main.waitForFunction(() => document.querySelector('#page-title')?.textContent === 'LocalBoard 状态' && !document.querySelector('#view .loading'));
  await main.locator('[data-project-path]').evaluateAll((buttons, target) => {
    const button = buttons.find((item) => item.dataset.projectPath.toLowerCase() === target.toLowerCase());
    if (!button) throw new Error(`Project button not found: ${target}`);
    button.click();
  }, root);
  await main.waitForFunction(() => document.querySelector('#workspace-switcher strong')?.textContent === 'localboard' && document.querySelector('#page-title')?.textContent === '仓库待办' && !document.querySelector('#view .loading'));

  await main.locator('[data-tab="notes"]').click();
  await main.waitForFunction(() => !document.querySelector('#view .loading'));
  const sticky = await findWindow(electronApp, (page) => page.locator('.sticky').count());
  await sticky.screenshot({ path: resolve(artifacts, 'activity-sticky.png') });
  assert.equal(await sticky.locator('.bookmark-tabs').count(), 1);
  assert.equal(await sticky.locator('[data-sticky-project]').count(), 2);
  assert.equal(await sticky.locator('[data-sticky-project][aria-selected="true"]').count(), 1);
  const staleDelete = sticky.locator(`[data-remove-context="${staleFixtureKey}"]`);
  await staleDelete.waitFor({ state: 'attached' });
  await staleDelete.scrollIntoViewIfNeeded();
  await staleDelete.click();
  await sticky.waitForFunction((key) => !document.querySelector(`[data-remove-context="${key}"]`), staleFixtureKey);
  const nativeSticky = await electronApp.browserWindow(sticky);
  await sticky.locator('[data-section-toggle="global"]').click();
  assert.equal(await sticky.locator('[data-section="global"]').getAttribute('class').then((value) => value.includes('collapsed')), true);
  assert.equal(await sticky.locator('[data-section-toggle="global"]').getAttribute('aria-label'), '展开全局个人待办');
  assert.equal(await sticky.locator('[data-resizer="0"]').getAttribute('aria-disabled'), 'true');
  assert.equal(await sticky.locator('[data-resizer="1"]').getAttribute('aria-disabled'), 'true');
  await sticky.screenshot({ path: resolve(artifacts, 'activity-sticky-collapsed.png') });
  await sticky.locator('[data-section-toggle="global"]').click();
  assert.equal(await sticky.locator('[data-section-toggle="global"]').getAttribute('aria-label'), '折叠全局个人待办');
  assert.equal(await sticky.locator('[data-resizer="0"]').getAttribute('aria-disabled'), 'false');
  await sticky.waitForTimeout(100);
  const stickyFit = await sticky.evaluate(() => ({
    innerWidth,
    innerHeight,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    verticalOverflow: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    sectionsFit: document.querySelector('#sticky-sections').getBoundingClientRect().bottom <= document.querySelector('.sticky-foot').getBoundingClientRect().top + 1,
    gridTemplateRows: getComputedStyle(document.querySelector('#sticky-sections')).gridTemplateRows,
    sectionHeights: [...document.querySelectorAll('.sticky-section')].map((item) => Math.round(item.getBoundingClientRect().height)),
    headerHeights: [...document.querySelectorAll('.sticky-section > header')].map((item) => Math.round(item.getBoundingClientRect().height)),
    resizerHeights: [...document.querySelectorAll('.section-resizer')].map((item) => Math.round(item.getBoundingClientRect().height))
  }));
  assert.equal(stickyFit.horizontalOverflow, false);
  assert.equal(stickyFit.verticalOverflow, false);
  assert.equal(stickyFit.sectionsFit, true);
  assert.deepEqual(stickyFit.headerHeights, [34, 34, 34, 34]);
  assert.deepEqual(stickyFit.resizerHeights, [7, 7, 7]);
  await sticky.locator('[data-resizer="0"]').focus();
  await sticky.keyboard.press('ArrowDown');
  const resizerBox = await sticky.locator('[data-resizer="0"]').boundingBox();
  await sticky.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + resizerBox.height / 2);
  await sticky.mouse.down();
  await sticky.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + 22, { steps: 4 });
  await sticky.mouse.up();
  await sticky.locator('#sticky-more').click();
  await sticky.locator('[data-preset="small"]').click();
  await main.waitForTimeout(200);
  assert.deepEqual(await nativeSticky.evaluate((window) => window.getSize()), [320, 480]);
  const smallStickyFit = await sticky.evaluate(() => ({
    innerWidth,
    innerHeight,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    verticalOverflow: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    sectionsFit: document.querySelector('#sticky-sections').getBoundingClientRect().bottom <= document.querySelector('.sticky-foot').getBoundingClientRect().top + 1
  }));
  assert.deepEqual(smallStickyFit, { innerWidth: 320, innerHeight: 480, horizontalOverflow: false, verticalOverflow: false, sectionsFit: true });
  await sticky.screenshot({ path: resolve(artifacts, 'activity-sticky-small.png') });
  await sticky.locator('[data-preset="medium"]').click();
  await main.waitForTimeout(200);
  assert.deepEqual(await nativeSticky.evaluate((window) => window.getSize()), [400, 680]);
  await sticky.locator('#sticky-more').click();
  await sticky.locator('#sticky-command-menu').waitFor({ state: 'hidden' });
  const quickGlobal = sticky.locator('[data-quick-add="global"] input');
  await quickGlobal.fill('便签快捷新增');
  await quickGlobal.press('Enter');
  const quickTodo = sticky.locator('#sticky-global-todos .sticky-todo-row').filter({ hasText: '便签快捷新增' });
  await quickTodo.waitFor();
  await quickTodo.locator('[data-global-todo]').click();
  await sticky.waitForFunction(() => [...document.querySelectorAll('#sticky-global-todos .sticky-todo')].some((item) => item.textContent.includes('便签快捷新增') && item.classList.contains('done')));
  await quickTodo.locator('[data-open-todo]').click();
  await main.waitForFunction(() => document.querySelector('#page-title')?.textContent === '全局个人待办' && document.querySelector('.shell')?.classList.contains('global-workspace'));
  await sticky.screenshot({ path: resolve(artifacts, 'activity-sticky-resized.png') });
  for (const edge of ['left', 'right', 'top', 'bottom']) {
    await sticky.evaluate((targetEdge) => window.localboard.stickyWindow('dock', { edge: targetEdge }), edge);
    assert.equal((await sticky.evaluate(() => window.localboard.stickyWindow('get-state'))).dock.edge, edge);
    await main.bringToFront();
    await main.mouse.move(600, 300);
    await sticky.evaluate(() => window.localboard.stickyPointer(false));
    await sticky.evaluate(() => window.localboard.stickyWindow('collapse'));
    await main.waitForTimeout(220);
    assert.equal((await sticky.evaluate(() => window.localboard.stickyWindow('get-state'))).dock.collapsed, true);
    await sticky.evaluate(() => window.localboard.stickyWindow('expand'));
    await main.waitForTimeout(220);
    assert.equal((await sticky.evaluate(() => window.localboard.stickyWindow('get-state'))).dock.collapsed, false);
    await sticky.evaluate(() => window.localboard.stickyWindow('undock'));
  }
  await sticky.evaluate(() => window.localboard.stickyWindow('dock', { edge: 'right' }));
  await main.bringToFront();
  await main.mouse.move(600, 300);
  await sticky.evaluate(() => window.localboard.stickyWindow('interaction', { active: false }));
  await sticky.evaluate(() => window.localboard.stickyPointer(false));
  await sticky.waitForFunction(async () => (await window.localboard.stickyWindow('get-state')).dock.collapsed === true, null, { timeout: 3000 });
  await sticky.evaluate(() => window.localboard.stickyWindow('expand'));
  await main.waitForTimeout(220);
  await sticky.evaluate(() => window.localboard.stickyWindow('undock'));
  await sticky.locator('[data-window-action="minimize"]').click();
  await main.waitForTimeout(150);
  assert.equal(await nativeSticky.evaluate((window) => window.isMinimized()), true);
  await nativeSticky.evaluate((window) => { window.restore(); window.show(); });
  await sticky.locator('[data-window-action="hide"]').click();
  assert.equal(await nativeSticky.evaluate((window) => window.isVisible()), false);

  const beforeStickyCount = electronApp.windows().length;
  await main.locator('[data-project-path]').evaluateAll((buttons, target) => {
    const button = buttons.find((item) => item.dataset.projectPath.toLowerCase() === target.toLowerCase());
    if (!button) throw new Error(`Project button not found: ${target}`);
    button.click();
  }, root);
  await main.waitForFunction(() => !document.querySelector('.shell')?.classList.contains('global-workspace')
    && document.querySelector('#page-title')?.textContent === '仓库待办' && !document.querySelector('#view .loading'));
  await main.locator('[data-tab="notes"]').click();
  await main.locator('#open-note').waitFor();
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

  console.log(JSON.stringify({ ok: true, pageErrors, fit, stickyFit, smallStickyFit, screenshots: artifacts }, null, 2));
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
