#!/usr/bin/env node
import { startBroker } from './core/broker-server.mjs';

const broker = await startBroker();
if (!broker.owner) process.exit(0);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await broker.close();
  process.exit(0);
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('uncaughtException', async (error) => {
  console.error(error);
  await stop();
});

console.log(`LocalBoard broker listening on 127.0.0.1:${broker.endpoint.port}`);
