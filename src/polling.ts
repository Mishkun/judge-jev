import { processGuestUpdate, type Env } from './index';
import {
  parseGuestUpdate,
  TELEGRAM_API_BASE,
  TELEGRAM_REQUEST_TIMEOUT_MS,
} from './telegram';

export const TELEGRAM_POLLING_TIMEOUT_SECONDS = 25;
export const TELEGRAM_POLLING_REQUEST_TIMEOUT_MS = 35_000;
const POLLING_RETRY_DELAY_MS = 1_000;

export type PollingEnv = Pick<Env, 'JEV_OPENROUTER_TOKEN' | 'TELEGRAM_BOT_TOKEN'>;

export class PollingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PollingError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface TimedSignal {
  signal: AbortSignal;
  cleanup: () => void;
}

function createTimedSignal(timeoutMs: number, parent?: AbortSignal): TimedSignal {
  const controller = new AbortController();
  const onParentAbort = (): void => controller.abort();

  if (parent) {
    if (parent.aborted) {
      controller.abort();
    } else {
      parent.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

async function fetchTelegramJson(
  botToken: string,
  method: string,
  init: RequestInit,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<unknown> {
  const token = botToken.trim();
  if (token.length === 0) {
    throw new PollingError('Telegram bot token is not configured.');
  }

  const timed = createTimedSignal(timeoutMs, parentSignal);
  try {
    let response: Response;
    try {
      response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
        ...init,
        signal: timed.signal,
      });
    } catch {
      throw new PollingError('Telegram polling request failed.');
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new PollingError('Telegram returned invalid JSON.');
    }

    if (!response.ok || !isRecord(payload) || payload.ok !== true) {
      throw new PollingError('Telegram rejected the polling request.');
    }

    return payload;
  } finally {
    timed.cleanup();
  }
}

export interface WebhookInfo {
  url: string;
}

export async function getWebhookInfo(
  botToken: string,
  signal?: AbortSignal,
): Promise<WebhookInfo> {
  const payload = await fetchTelegramJson(
    botToken,
    'getWebhookInfo',
    { method: 'GET' },
    TELEGRAM_REQUEST_TIMEOUT_MS,
    signal,
  );
  if (!isRecord(payload) || !isRecord(payload.result) || typeof payload.result.url !== 'string') {
    throw new PollingError('Telegram returned an invalid webhook status.');
  }
  return { url: payload.result.url };
}

export async function deleteWebhook(
  botToken: string,
  signal?: AbortSignal,
): Promise<void> {
  await fetchTelegramJson(
    botToken,
    'deleteWebhook',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drop_pending_updates: false }),
    },
    TELEGRAM_REQUEST_TIMEOUT_MS,
    signal,
  );
}

/** Parse the complete Telegram getUpdates envelope without exposing its body. */
export function parseGetUpdatesResponse(value: unknown): unknown[] {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.result)) {
    throw new PollingError('Telegram returned an invalid getUpdates response.');
  }
  return value.result;
}

export async function getUpdates(
  botToken: string,
  offset: number,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const payload = await fetchTelegramJson(
    botToken,
    'getUpdates',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offset,
        timeout: TELEGRAM_POLLING_TIMEOUT_SECONDS,
        allowed_updates: ['guest_message'],
      }),
    },
    TELEGRAM_POLLING_REQUEST_TIMEOUT_MS,
    signal,
  );
  return parseGetUpdatesResponse(payload);
}

/** Return the next offset after all Telegram updates with usable IDs. */
export function advancePollingOffset(currentOffset: number, updates: unknown[]): number {
  let nextOffset = currentOffset;
  for (const update of updates) {
    if (!isRecord(update) || typeof update.update_id !== 'number') {
      continue;
    }
    if (!Number.isInteger(update.update_id)) {
      continue;
    }
    nextOffset = Math.max(nextOffset, update.update_id + 1);
  }
  return nextOffset;
}

function sleepWithAbort(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface PollingOptions {
  signal?: AbortSignal;
  deleteActiveWebhook?: boolean;
  processUpdate?: typeof processGuestUpdate;
}

/**
 * Run Telegram long polling until the supplied signal is aborted. The default
 * update processor is the same function used by the Worker webhook.
 */
export async function runPolling(
  env: PollingEnv,
  options: PollingOptions = {},
): Promise<void> {
  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  const processUpdate = options.processUpdate ?? processGuestUpdate;

  if (signal.aborted) {
    return;
  }

  const webhookInfo = await getWebhookInfo(env.TELEGRAM_BOT_TOKEN, signal);
  if (webhookInfo.url.length > 0) {
    if (!options.deleteActiveWebhook) {
      throw new PollingError(
        'Telegram webhook is active. Refusing to start polling; remove the webhook or set POLLING_DELETE_WEBHOOK=1 to intentionally take over.',
      );
    }
    await deleteWebhook(env.TELEGRAM_BOT_TOKEN, signal);
  }

  let offset = 0;
  while (!signal.aborted) {
    let updates: unknown[];
    try {
      updates = await getUpdates(env.TELEGRAM_BOT_TOKEN, offset, signal);
    } catch {
      if (signal.aborted) {
        return;
      }
      console.error('Telegram polling request failed; retrying.');
      await sleepWithAbort(POLLING_RETRY_DELAY_MS, signal);
      continue;
    }

    let retryBatch = false;
    for (const rawUpdate of updates) {
      if (signal.aborted) {
        return;
      }

      const update = parseGuestUpdate(rawUpdate);
      if (update) {
        try {
          await processUpdate(update, env);
        } catch {
          if (signal.aborted) {
            return;
          }
          console.error('Guest update processing failed; retrying.');
          retryBatch = true;
          break;
        }
      }
      offset = advancePollingOffset(offset, [rawUpdate]);
    }

    if (retryBatch) {
      await sleepWithAbort(POLLING_RETRY_DELAY_MS, signal);
    }
  }
}
