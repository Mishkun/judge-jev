import 'dotenv/config';

import { runPolling, type PollingEnv } from '../src/polling';

function requiredEnvironment(name: keyof PollingEnv): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} is required to run local polling.`);
  }
  return value;
}

async function main(): Promise<void> {
  const env: PollingEnv = {
    JEV_OPENROUTER_TOKEN: requiredEnvironment('JEV_OPENROUTER_TOKEN'),
    TELEGRAM_BOT_TOKEN: requiredEnvironment('TELEGRAM_BOT_TOKEN'),
  };
  const controller = new AbortController();
  const stop = (): void => controller.abort();

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runPolling(env, {
      signal: controller.signal,
      deleteActiveWebhook: process.env.POLLING_DELETE_WEBHOOK === '1',
    });
  } catch (error) {
    if (!controller.signal.aborted) {
      throw error;
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error('Local polling stopped unexpectedly.');
  }
  process.exitCode = 1;
}
