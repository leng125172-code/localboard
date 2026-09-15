import { publishCodexHook } from './context-publisher.mjs';
import { launchDesktop } from './desktop-launcher.mjs';

export async function handleCodexHook(payload = {}, options = {}) {
  const publish = options.publish ?? publishCodexHook;
  const launch = options.launch ?? launchDesktop;
  const reported = await publish(payload);
  let desktop = null;
  if (payload.hook_event_name === 'SessionStart') {
    desktop = await launch({ cwd: payload.cwd || process.cwd() });
  }
  return { ...reported, desktop };
}
