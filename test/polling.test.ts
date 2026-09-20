import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  advancePollingOffset,
  deleteWebhook,
  getUpdates,
  getWebhookInfo,
  parseGetUpdatesResponse,
  runPolling,
  type PollingEnv,
} from '../src/polling';

afterEach(() => {
  vi.unstubAllGlobals();
});

const env: PollingEnv = {
  JEV_OPENROUTER_TOKEN: 'jev-token',
  TELEGRAM_BOT_TOKEN: '123456:bot-token',
};

function telegramResponse(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
}

describe('Telegram local polling helpers', () => {
  it('parses getUpdates envelopes and advances offset monotonically', () => {
    const updates = [{ update_id: 42 }, { update_id: 44 }, { update_id: 43 }];
    expect(parseGetUpdatesResponse({ ok: true, result: updates })).toEqual(updates);
    expect(advancePollingOffset(40, updates)).toBe(45);
    expect(advancePollingOffset(50, updates)).toBe(50);
    expect(() => parseGetUpdatesResponse({ ok: false, result: [] })).toThrow();
  });

  it('uses guest_message-only long polling with an offset and AbortSignal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(telegramResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getUpdates(env.TELEGRAM_BOT_TOKEN, 42)).resolves.toEqual([]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/bot123456:bot-token/getUpdates');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({
      offset: 42,
      timeout: 25,
      allowed_updates: ['guest_message'],
    });
  });

  it('checks webhook status and preserves pending updates when deleting it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(telegramResponse({ url: 'https://example.invalid/webhook' }))
      .mockResolvedValueOnce(telegramResponse(true));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getWebhookInfo(env.TELEGRAM_BOT_TOKEN)).resolves.toEqual({
      url: 'https://example.invalid/webhook',
    });
    await deleteWebhook(env.TELEGRAM_BOT_TOKEN);

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/bot123456:bot-token/deleteWebhook');
    expect(JSON.parse(String(init.body))).toEqual({ drop_pending_updates: false });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses an active webhook by default', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(telegramResponse({ url: 'https://example.invalid/webhook' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(runPolling(env)).rejects.toThrow(
      'Telegram webhook is active. Refusing to start polling',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the shared update processor and stops on abort', async () => {
    const controller = new AbortController();
    const processUpdate = vi.fn(async () => controller.abort());
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(telegramResponse({ url: '' }))
      .mockResolvedValueOnce(
        telegramResponse([
          {
            update_id: 9,
            guest_message: { guest_query_id: 'guest-9', text: '/is_this_true' },
          },
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    await runPolling(env, { signal: controller.signal, processUpdate });

    expect(processUpdate).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
