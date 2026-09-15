import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { launchDesktop } from '../src/core/desktop-launcher.mjs';

test('starts the desktop detached in the requested repository path', async () => {
  const calls = [];
  const child = new EventEmitter();
  child.pid = 4242;
  child.unref = () => { child.unrefCalled = true; };
  const spawnImpl = (...args) => {
    calls.push(args);
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };

  const result = await launchDesktop({
    cwd: '.', electronPath: 'electron-test', packageRoot: '.', spawnImpl
  });

  assert.equal(result.mode, 'background');
  assert.equal(result.pid, 4242);
  assert.equal(child.unrefCalled, true);
  assert.equal(calls[0][0], 'electron-test');
  assert.equal(calls[0][2].cwd, process.cwd());
  assert.equal(calls[0][2].detached, true);
  assert.equal(calls[0][2].stdio, 'ignore');
});

test('foreground mode waits for the desktop to exit', async () => {
  const child = new EventEmitter();
  const spawnImpl = (...args) => {
    child.options = args[2];
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  };

  const result = await launchDesktop({ cwd: '.', foreground: true, electronPath: 'electron-test', spawnImpl });

  assert.equal(result.mode, 'foreground');
  assert.equal(result.code, 0);
  assert.equal(child.options.detached, false);
  assert.equal(child.options.stdio, 'inherit');
});

test('rejects a missing startup path before spawning Electron', async () => {
  await assert.rejects(
    launchDesktop({ cwd: './this-path-must-not-exist', electronPath: 'electron-test' }),
    /Startup path does not exist/
  );
});
