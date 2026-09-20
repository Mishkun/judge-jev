import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  evaluateJevDecisions,
  JEV_MODEL,
  parseDecisionsResponse,
  validateDecisionsRequest,
  type DecisionsRequest,
} from '../src/jev';

afterEach(() => {
  vi.unstubAllGlobals();
});

const truthRequest: DecisionsRequest = {
  model: JEV_MODEL,
  state: 'synthetic claim',
  questions: {
    truth: {
      type: 'noul',
      instructions: 'Is the claim true?',
      criteria: { true: 'yes', false: 'no' },
    },
  },
};

const choiceRequest: DecisionsRequest = {
  model: JEV_MODEL,
  state: { submission: 'text' },
  questions: {
    bucket: {
      type: 'choice',
      instructions: 'Choose one.',
      criteria: { c_0: 'first', c_1: 'second' },
    },
  },
};

function responseFor(answers: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      id: 'decision-1',
      model: 'typesafe/jev-1.13-20260917',
      provider: 'provider-a',
      answers,
      usage: { input_tokens: 12, output_tokens: 0, cost: 0.000001 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('raw OpenRouter Decisions client', () => {
  it('uses one direct Alpha Decisions POST with the bearer token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce(
      responseFor({ truth: { type: 'noul', noul: 0.8 } }),
    );

    const result = await evaluateJevDecisions('secret-token', truthRequest);

    expect(result.answers.truth).toEqual({ type: 'noul', noul: 0.8 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: 'Bearer secret-token',
      'Content-Type': 'application/json',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual(truthRequest);
  });

  it('rejects invalid local requests before fetching', () => {
    const invalid = {
      ...truthRequest,
      questions: {
        truth: {
          type: 'noul',
          instructions: 'missing false criterion',
          criteria: { true: 'yes' },
        },
      },
    };
    expect(() => validateDecisionsRequest(invalid)).toThrow();
  });

  it('enforces the documented Choice option and session/user limits', () => {
    const twoHundredFiftyFive = Object.fromEntries(
      Array.from({ length: 255 }, (_, index) => [`c_${index}`, `option ${index}`]),
    );
    expect(() =>
      validateDecisionsRequest({
        ...choiceRequest,
        questions: {
          bucket: { ...choiceRequest.questions.bucket, criteria: twoHundredFiftyFive },
        },
        session_id: 'x'.repeat(256),
        user: 'y'.repeat(256),
      }),
    ).not.toThrow();

    expect(() =>
      validateDecisionsRequest({
        ...choiceRequest,
        questions: {
          bucket: {
            ...choiceRequest.questions.bucket,
            criteria: { ...twoHundredFiftyFive, c_255: 'too many' },
          },
        },
      }),
    ).toThrow();
    expect(() => validateDecisionsRequest({ ...truthRequest, session_id: 'x'.repeat(257) })).toThrow();
  });

  it('validates Noul range, answer ids, usage, and Choice distributions', () => {
    expect(() =>
      parseDecisionsResponse(
        {
          model: 'jev',
          answers: { truth: { type: 'noul', noul: 1.1 } },
          usage: { input_tokens: 1, output_tokens: 0 },
        },
        truthRequest.questions,
      ),
    ).toThrow();

    expect(() =>
      parseDecisionsResponse(
        {
          model: 'jev',
          answers: { other: { type: 'noul', noul: 0.5 } },
          usage: { input_tokens: 1, output_tokens: 0 },
        },
        truthRequest.questions,
      ),
    ).toThrow();

    expect(() =>
      parseDecisionsResponse(
        {
          model: 'jev',
          answers: { bucket: { type: 'choice', choice: 'c_0' } },
          usage: { input_tokens: 1, output_tokens: 0 },
        },
        choiceRequest.questions,
      ),
    ).toThrow();

    expect(() =>
      parseDecisionsResponse(
        {
          model: 'jev',
          answers: {
            bucket: {
              type: 'choice',
              choice: 'c_0',
              probabilities: { c_0: 0.7, c_1: 0.7 },
            },
          },
          usage: { input_tokens: 1, output_tokens: 0 },
        },
        choiceRequest.questions,
      ),
    ).toThrow();

    expect(
      parseDecisionsResponse(
        {
          model: 'jev',
          answers: {
            bucket: {
              type: 'choice',
              choice: 'c_0',
              confidence: 0.7,
              probabilities: { c_0: 0.7, c_1: 0.3 },
            },
          },
          usage: { input_tokens: 1, output_tokens: 0 },
        },
        choiceRequest.questions,
      ).answers.bucket,
    ).toEqual({
      type: 'choice',
      choice: 'c_0',
      confidence: 0.7,
      probabilities: { c_0: 0.7, c_1: 0.3 },
    });
  });

  it('rejects a successful response with missing usage', () => {
    expect(() =>
      parseDecisionsResponse(
        { model: 'jev', answers: { truth: { type: 'noul', noul: 0.5 } } },
        truthRequest.questions,
      ),
    ).toThrow();
  });

  it('does not expose provider error envelopes as valid decisions', () => {
    expect(() =>
      parseDecisionsResponse(
        { error: { code: 400, message: 'bad request' } },
        truthRequest.questions,
      ),
    ).toThrow();
  });
});
