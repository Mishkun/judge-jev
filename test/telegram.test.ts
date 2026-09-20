import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  answerGuestQuery,
  createGuestAnswerPayload,
  parseGuestUpdate,
} from '../src/telegram';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Telegram Guest Mode boundary', () => {
  it('requires the official nested guest_message guest_query_id shape', () => {
    const parsed = parseGuestUpdate({
      update_id: 10,
      guest_message: {
        guest_query_id: 'g-10',
        reply_to_message: { caption: 'target caption' },
      },
    });
    expect(parsed?.guest_message.guest_query_id).toBe('g-10');
    expect(parseGuestUpdate({ update_id: 10, guest_query_id: 'wrong-place' })).toBeNull();
    expect(parseGuestUpdate({ update_id: 10, guest_message: {} })).toBeNull();
  });

  it('builds answerGuestQuery with singular result InlineQueryResult article', () => {
    expect(createGuestAnswerPayload('g-1', 'answer')).toEqual({
      guest_query_id: 'g-1',
      result: {
        type: 'article',
        id: 'jev-answer',
        title: 'Jev',
        input_message_content: { message_text: 'answer' },
      },
    });
  });

  it('uses an AbortSignal for the Telegram delivery timeout', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await answerGuestQuery('123456:token', 'g-1', 'answer');

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
