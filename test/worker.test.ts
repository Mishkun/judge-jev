import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleRequest, type Env } from '../src';

afterEach(() => {
  vi.unstubAllGlobals();
});

const env: Env = {
  JEV_OPENROUTER_TOKEN: 'jev-token',
  TELEGRAM_BOT_TOKEN: '123456:bot-token',
  TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
};

function guestUpdate(command: string, target?: { text?: string; caption?: string }): object {
  return {
    update_id: 42,
    guest_message: {
      guest_query_id: 'guest-query-42',
      text: command,
      ...(target === undefined ? {} : { reply_to_message: target }),
    },
  };
}

function openRouterResponse(answers: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      model: 'typesafe/jev-1.13-20260917',
      answers,
      usage: { input_tokens: 10, output_tokens: 0 },
    }),
    { status: 200 },
  );
}

function telegramResponse(): Response {
  return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
}

function webhookRequest(body: object, secret = env.TELEGRAM_WEBHOOK_SECRET): Request {
  return new Request('https://judge-jev.example/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret,
    },
    body: JSON.stringify(body),
  });
}

describe('Worker HTTP boundary', () => {
  it('serves a non-secret health endpoint', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await handleRequest(new Request('https://judge-jev.example/health'), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: 'judge-jev' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an incorrect webhook secret before reading invalid JSON', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const request = new Request('https://judge-jev.example/', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' },
      body: 'not json',
    });
    const response = await handleRequest(request, env);
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('acknowledges unrelated Telegram updates without processing them', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await handleRequest(
      webhookRequest({ update_id: 41, message: { text: 'queued before filter' } }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ignored: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs /is_this_true and answers with an article result', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(openRouterResponse({ truth: { type: 'noul', noul: 0.73 } }))
      .mockResolvedValueOnce(telegramResponse());

    const response = await handleRequest(
      webhookRequest(guestUpdate('/is_this_true@jev_bot', { text: 'Вода мокрая.' })),
      env,
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const firstBody = JSON.parse(String(firstInit.body)) as Record<string, unknown>;
    expect(firstBody.model).toBe('~typesafe/jev-latest');
    expect((firstBody.state as Record<string, unknown>).submission).toBe('Вода мокрая.');

    const telegramInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const telegramBody = JSON.parse(String(telegramInit.body)) as Record<string, unknown>;
    expect(telegramBody.guest_query_id).toBe('guest-query-42');
    expect(telegramBody).not.toHaveProperty('results');
    expect(telegramBody.result).toEqual(
      expect.objectContaining({ type: 'article', title: 'Jev' }),
    );
    expect(
      (telegramBody.result as { input_message_content: { message_text: string } })
        .input_message_content.message_text,
    ).toContain('<b>true: 0.73</b>');
  });

  it('uses a replied caption as the only classify target and maps opaque IDs back', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(
        openRouterResponse({
          classification: {
            type: 'choice',
            choice: 'c_1',
            probabilities: { c_0: 0.2, c_1: 0.8 },
          },
        }),
      )
      .mockResolvedValueOnce(telegramResponse());

    await handleRequest(
      webhookRequest(guestUpdate('/classify факт | мнение', { caption: 'Подпись поста' })),
      env,
    );

    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      state: { submission: string };
      questions: { classification: { criteria: Record<string, unknown> } };
    };
    expect(firstBody.state.submission).toBe('Подпись поста');
    expect(firstBody.questions.classification.criteria).toHaveProperty('c_0');

    const telegramBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
      result: { input_message_content: { message_text: string } };
    };
    expect(telegramBody.result.input_message_content.message_text).toContain('мнение');
  });

  it('batches prompt bucket Nouls, keeps every selected bucket, then classifies the reply', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(
        openRouterResponse({
          q_0: { type: 'noul', noul: 0.1 },
          q_1: { type: 'noul', noul: 0.8 },
          q_2: { type: 'noul', noul: 0.9 },
          q_3: { type: 'noul', noul: 0.7 },
        }),
      )
      .mockResolvedValueOnce(
        openRouterResponse({
          bucket: {
            type: 'choice',
            choice: 'c_1',
            probabilities: { c_0: 0.2, c_1: 0.5, c_2: 0.3 },
          },
        }),
      )
      .mockResolvedValueOnce(telegramResponse());

    await handleRequest(
      webhookRequest(
        guestUpdate('@judge_jev_bot оцени: кринж, кайф или жесть', { text: 'это очень спорно' }),
      ),
      env,
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const noulBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      state: { user_request: string; candidates: Array<{ text: string }> };
      questions: Record<string, { instructions: string }>;
    };
    expect(Object.keys(noulBody.questions)).toEqual(['q_0', 'q_1', 'q_2', 'q_3']);
    expect(noulBody.state).toEqual({
      user_request: 'оцени: кринж, кайф или жесть',
      candidates: [{ text: 'оцени' }, { text: 'кринж' }, { text: 'кайф' }, { text: 'жесть' }],
    });
    expect(noulBody.questions.q_0?.instructions).toContain('`candidates[0].text`');
    expect(noulBody.questions.q_0?.instructions).toContain('`user_request`');
    expect(noulBody.questions.q_0?.instructions).not.toContain('оцени');
    expect(noulBody.questions.q_0?.instructions).not.toContain('кринж');
    expect(noulBody.questions.q_0?.instructions).not.toContain('q_0');

    const choiceBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
      state: { source_text: string; user_request: string; selected_candidate?: string };
      questions: { bucket: { instructions: string; criteria: Record<string, { bucket: string }> } };
    };
    expect(choiceBody.state).toEqual({
      source_text: 'это очень спорно',
      user_request: 'оцени: кринж, кайф или жесть',
    });
    expect(choiceBody.state).not.toHaveProperty('selected_candidate');
    expect(choiceBody.questions.bucket.instructions).toContain('`source_text`');
    expect(choiceBody.questions.bucket.instructions).toContain('`user_request`');
    expect(choiceBody.questions.bucket.criteria).toEqual({
      c_0: expect.objectContaining({ bucket: 'кринж' }),
      c_1: expect.objectContaining({ bucket: 'кайф' }),
      c_2: expect.objectContaining({ bucket: 'жесть' }),
    });
    const telegramBody = JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body)) as {
      result: { input_message_content: { message_text: string } };
    };
    expect(telegramBody.result.input_message_content.message_text).toBe(
      '<b>кайф: 0.5</b>\nжесть: 0.3\nкринж: 0.2',
    );
    expect(telegramBody.result.input_message_content.message_text).not.toContain('Результат:');
    expect(telegramBody.result.input_message_content.message_text).not.toContain('Извлечённые бакеты:');
  });

  it('uses explicit pipe buckets directly without a Jev extraction call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(
        openRouterResponse({
          bucket: {
            type: 'choice',
            choice: 'c_1',
            probabilities: { c_0: 0.15, c_1: 0.85 },
          },
        }),
      )
      .mockResolvedValueOnce(telegramResponse());

    await handleRequest(
      webhookRequest(
        guestUpdate('@judge_jev_bot оцени: полный кринж | абсолютный кайф', {
          text: 'очень хорошо',
        }),
      ),
      env,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      questions: Record<string, { type: string; criteria: Record<string, { bucket: string }> }>;
    };
    expect(Object.keys(body.questions)).toEqual(['bucket']);
    expect(body.questions.bucket?.type).toBe('choice');
    expect(body.questions.bucket?.criteria).toEqual({
      c_0: expect.objectContaining({ bucket: 'полный кринж' }),
      c_1: expect.objectContaining({ bucket: 'абсолютный кайф' }),
    });
  });

  it('uses the one-bucket plus explicit negation Choice shape', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(
        openRouterResponse({ q_0: { type: 'noul', noul: 0.8 } }),
      )
      .mockResolvedValueOnce(
        openRouterResponse({
          bucket: {
            type: 'choice',
            choice: 'c_1',
            probabilities: { c_0: 0.25, c_1: 0.75 },
          },
        }),
      )
      .mockResolvedValueOnce(telegramResponse());

    await handleRequest(
      webhookRequest(guestUpdate('/judge это база?', { text: 'обычный текст' })),
      env,
    );

    const noulBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      state: { user_request: string; candidates: Array<{ text: string }> };
    };
    expect(noulBody.state).toEqual({
      user_request: 'это база?',
      candidates: [{ text: 'база' }],
    });
    const choiceBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as {
      questions: { bucket: { criteria: Record<string, { bucket: string }> } };
    };
    expect(choiceBody.questions.bucket.criteria).toEqual({
      c_0: expect.objectContaining({ bucket: 'база' }),
      c_1: expect.objectContaining({ bucket: 'не база' }),
    });
    const telegramBody = JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body)) as {
      result: { input_message_content: { message_text: string } };
    };
    expect(telegramBody.result.input_message_content.message_text).toContain('не база: 0.75');
    expect(telegramBody.result.input_message_content.message_text).not.toContain('X:');
  });

  it('does not spend a model call when judge has no bucket words in its request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce(telegramResponse());

    await handleRequest(
      webhookRequest(guestUpdate('/judge и, в, не', { text: 'обычный текст' })),
      env,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const telegramBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      result: { input_message_content: { message_text: string } };
    };
    expect(telegramBody.result.input_message_content.message_text).toContain(
      'Не нашёл слов-названий категорий или шкал в запросе /judge',
    );
    expect(telegramBody.result.input_message_content.message_text).toContain('|');
  });

  it('answers a malformed Guest update with 400 and never calls Telegram', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await handleRequest(
      webhookRequest({ update_id: 1, guest_message: { text: '/help' } }),
      env,
    );
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
