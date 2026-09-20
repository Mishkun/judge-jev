/** The only model transport used by the Worker. */
export const OPENROUTER_DECISIONS_URL =
  'https://openrouter.ai/api/alpha/decisions';

/** A moving alias is intentional: the deployed bot follows Jev's latest release. */
export const JEV_MODEL = '~typesafe/jev-latest';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type DecisionEntry = string | JsonValue[] | { [key: string]: JsonValue };
export type DecisionState = string | JsonValue[] | { [key: string]: JsonValue };

export interface NoulQuestion {
  type: 'noul';
  instructions: DecisionEntry;
  criteria?: {
    true: DecisionEntry;
    false: DecisionEntry;
  };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: DecisionEntry;
  criteria: Record<string, DecisionEntry | null>;
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion;

export interface DecisionsRequest {
  model: string;
  state: DecisionState;
  questions: Record<string, DecisionQuestion>;
  session_id?: string;
  user?: string;
}

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer;

export interface DecisionsUsage {
  input_tokens: number;
  output_tokens: number;
  cost?: number;
}

export interface DecisionsResponse {
  id?: string;
  model: string;
  provider?: string;
  answers: Record<string, DecisionAnswer>;
  usage: DecisionsUsage;
}

export class DecisionError extends Error {
  public readonly kind: 'validation' | 'network' | 'http' | 'response';
  public readonly status: number | undefined;

  public constructor(
    kind: 'validation' | 'network' | 'http' | 'response',
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = 'DecisionError';
    this.kind = kind;
    this.status = status;
  }
}

// Keep the serialized request comfortably below Jev's currently documented
// 32k-token context limit. This is a byte guard, not a token counter.
export const MAX_DECISION_BODY_BYTES = 64_000;
const MAX_ID_LENGTH = 128;
const MAX_OPTION_LENGTH = 256;
const PROBABILITY_TOLERANCE = 0.001;
export const JEV_REQUEST_TIMEOUT_MS = 12_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return typeof value !== 'number' || Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }

  if (isRecord(value)) {
    return Object.values(value).every((item) => isJsonValue(item));
  }

  return false;
}

function isDecisionEntry(value: unknown): value is DecisionEntry {
  if (typeof value === 'string') {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }

  return isRecord(value) && Object.values(value).every((item) => isJsonValue(item));
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function validationError(message: string): never {
  throw new DecisionError('validation', message);
}

function validateQuestion(id: string, question: unknown): void {
  if (!isRecord(question) || typeof question.type !== 'string') {
    validationError(`Invalid question ${id}`);
  }

  if (!isDecisionEntry(question.instructions)) {
    validationError(`Question ${id} has invalid instructions`);
  }

  if (question.type === 'noul') {
    if (question.criteria !== undefined) {
      if (!isRecord(question.criteria)) {
        validationError(`Noul question ${id} has invalid criteria`);
      }

      if (
        !hasOwn(question.criteria, 'true') ||
        !hasOwn(question.criteria, 'false') ||
        !isDecisionEntry(question.criteria.true) ||
        !isDecisionEntry(question.criteria.false)
      ) {
        validationError(`Noul question ${id} needs true and false criteria`);
      }
    }
    return;
  }

  if (question.type === 'choice') {
    if (!isRecord(question.criteria)) {
      validationError(`Choice question ${id} has invalid criteria`);
    }

    const labels = Object.keys(question.criteria);
    if (labels.length === 0 || labels.length > 255) {
      validationError(`Choice question ${id} must have 1..255 options`);
    }

    for (const label of labels) {
      if (label.length === 0 || label.length > MAX_OPTION_LENGTH) {
        validationError(`Choice question ${id} has an invalid option label`);
      }

      const criterion = question.criteria[label];
      if (criterion !== null && !isDecisionEntry(criterion)) {
        validationError(`Choice question ${id} has invalid option ${label}`);
      }
    }
    return;
  }

  validationError(`Unknown question type for ${id}`);
}

/** Validate the portable Alpha Decisions request before a network call. */
export function validateDecisionsRequest(request: unknown): asserts request is DecisionsRequest {
  if (!isRecord(request)) {
    validationError('Decision request must be an object');
  }

  if (
    typeof request.model !== 'string' ||
    request.model.trim().length === 0 ||
    request.model.length > MAX_ID_LENGTH
  ) {
    validationError('Decision request has an invalid model');
  }

  if (
    typeof request.state !== 'string' &&
    !Array.isArray(request.state) &&
    !isRecord(request.state)
  ) {
    validationError('Decision request has invalid state');
  }

  if (!isRecord(request.questions) || Object.keys(request.questions).length === 0) {
    validationError('Decision request needs at least one question');
  }

  for (const [id, question] of Object.entries(request.questions)) {
    if (id.length === 0 || id.length > MAX_ID_LENGTH) {
      validationError('Decision question id is too long or empty');
    }
    validateQuestion(id, question);
  }

  for (const field of ['session_id', 'user'] as const) {
    const value = request[field];
    if (value !== undefined && (typeof value !== 'string' || unicodeLength(value) > 256)) {
      validationError(`${field} must be at most 256 characters`);
    }
  }

  if (!isJsonValue(request.state)) {
    validationError('Decision state is not JSON');
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(request);
  } catch {
    validationError('Decision request cannot be serialized');
  }

  if (new TextEncoder().encode(serialized).byteLength > MAX_DECISION_BODY_BYTES) {
    validationError('Decision request is too large');
  }
}

function requireProbability(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new DecisionError('response', `Invalid probability for ${label}`);
  }
  return value;
}

function parseChoiceAnswer(
  questionId: string,
  question: ChoiceQuestion,
  answer: Record<string, unknown>,
  requireProbabilities: boolean,
): ChoiceAnswer {
  if (answer.type !== 'choice' || typeof answer.choice !== 'string') {
    throw new DecisionError('response', `Wrong answer type for ${questionId}`);
  }

  const labels = Object.keys(question.criteria);
  if (!labels.includes(answer.choice)) {
    throw new DecisionError('response', `Unknown choice for ${questionId}`);
  }

  let probabilities: Record<string, number> | undefined;
  if (answer.probabilities !== undefined) {
    if (!isRecord(answer.probabilities)) {
      throw new DecisionError('response', `Invalid probabilities for ${questionId}`);
    }

    const probabilityLabels = Object.keys(answer.probabilities);
    if (
      probabilityLabels.length !== labels.length ||
      labels.some((label) => !hasOwn(answer.probabilities as Record<string, unknown>, label)) ||
      probabilityLabels.some((label) => !labels.includes(label))
    ) {
      throw new DecisionError('response', `Incomplete probabilities for ${questionId}`);
    }

    probabilities = {};
    let sum = 0;
    for (const label of labels) {
      const probability = requireProbability(answer.probabilities[label], label);
      probabilities[label] = probability;
      sum += probability;
    }
    if (Math.abs(sum - 1) > PROBABILITY_TOLERANCE) {
      throw new DecisionError('response', `Probabilities do not sum to one for ${questionId}`);
    }

    const maximum = Math.max(...Object.values(probabilities));
    const selectedProbability = probabilities[answer.choice];
    if (
      selectedProbability === undefined ||
      selectedProbability < maximum - PROBABILITY_TOLERANCE
    ) {
      throw new DecisionError('response', `Choice is not the most probable option for ${questionId}`);
    }
  } else if (requireProbabilities) {
    throw new DecisionError('response', `Missing probabilities for ${questionId}`);
  }

  let confidence: number | undefined;
  if (answer.confidence !== undefined) {
    confidence = requireProbability(answer.confidence, `${questionId}.confidence`);
  }

  return {
    type: 'choice',
    choice: answer.choice,
    ...(confidence === undefined ? {} : { confidence }),
    ...(probabilities === undefined ? {} : { probabilities }),
  };
}

/** Parse and validate every answer needed by the submitted question map. */
export function parseDecisionsResponse(
  payload: unknown,
  questions: Record<string, DecisionQuestion>,
  requireChoiceProbabilities = true,
): DecisionsResponse {
  if (!isRecord(payload)) {
    throw new DecisionError('response', 'OpenRouter returned a non-object response');
  }

  if (hasOwn(payload, 'error')) {
    throw new DecisionError('response', 'OpenRouter returned an error envelope');
  }

  if (typeof payload.model !== 'string' || payload.model.length === 0) {
    throw new DecisionError('response', 'OpenRouter response has no model');
  }

  if (
    (hasOwn(payload, 'id') && payload.id !== undefined && typeof payload.id !== 'string') ||
    (hasOwn(payload, 'provider') &&
      payload.provider !== undefined &&
      typeof payload.provider !== 'string')
  ) {
    throw new DecisionError('response', 'OpenRouter response has invalid metadata');
  }

  if (!isRecord(payload.answers) || !isRecord(payload.usage)) {
    throw new DecisionError('response', 'OpenRouter response is missing answers or usage');
  }

  const expectedIds = Object.keys(questions);
  const answerIds = Object.keys(payload.answers);
  if (
    answerIds.length !== expectedIds.length ||
    expectedIds.some((id) => !hasOwn(payload.answers as Record<string, unknown>, id)) ||
    answerIds.some((id) => !hasOwn(questions, id))
  ) {
    throw new DecisionError('response', 'OpenRouter response has unexpected answer ids');
  }

  const inputTokens = payload.usage.input_tokens;
  const outputTokens = payload.usage.output_tokens;
  if (
    typeof inputTokens !== 'number' ||
    !Number.isInteger(inputTokens) ||
    inputTokens < 0 ||
    typeof outputTokens !== 'number' ||
    !Number.isInteger(outputTokens) ||
    outputTokens < 0
  ) {
    throw new DecisionError('response', 'OpenRouter response has invalid usage');
  }

  let cost: number | undefined;
  if (payload.usage.cost !== undefined) {
    if (
      typeof payload.usage.cost !== 'number' ||
      !Number.isFinite(payload.usage.cost) ||
      payload.usage.cost < 0
    ) {
      throw new DecisionError('response', 'OpenRouter response has invalid cost');
    }
    cost = payload.usage.cost;
  }

  const answers: Record<string, DecisionAnswer> = {};
  for (const id of expectedIds) {
    const question = questions[id];
    const rawAnswer = payload.answers[id];
    if (!question || !isRecord(rawAnswer)) {
      throw new DecisionError('response', `Invalid answer for ${id}`);
    }

    if (question.type === 'noul') {
      if (rawAnswer.type !== 'noul') {
        throw new DecisionError('response', `Wrong answer type for ${id}`);
      }
      answers[id] = {
        type: 'noul',
        noul: requireProbability(rawAnswer.noul, `${id}.noul`),
      };
    } else {
      answers[id] = parseChoiceAnswer(id, question, rawAnswer, requireChoiceProbabilities);
    }
  }

  return {
    ...(typeof payload.id === 'string' ? { id: payload.id } : {}),
    model: payload.model,
    ...(typeof payload.provider === 'string' ? { provider: payload.provider } : {}),
    answers,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      ...(cost === undefined ? {} : { cost }),
    },
  };
}

function httpErrorStatusIsUsefulToCallers(status: number): boolean {
  return status >= 400 && status <= 599;
}

/** Make the one raw Alpha Decisions request used by the Worker. */
export async function evaluateJevDecisions(
  token: string,
  request: DecisionsRequest,
): Promise<DecisionsResponse> {
  if (token.trim().length === 0) {
    throw new DecisionError('validation', 'OpenRouter token is not configured');
  }

  validateDecisionsRequest(request);

  let body: string;
  try {
    body = JSON.stringify(request);
  } catch {
    throw new DecisionError('validation', 'Decision request cannot be serialized');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JEV_REQUEST_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await fetch(OPENROUTER_DECISIONS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: controller.signal,
      });
    } catch {
      throw new DecisionError('network', 'OpenRouter request failed');
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new DecisionError('response', 'OpenRouter returned invalid JSON', response.status);
    }

    if (!response.ok) {
      throw new DecisionError(
        'http',
        'OpenRouter rejected the decision request',
        httpErrorStatusIsUsefulToCallers(response.status) ? response.status : undefined,
      );
    }

    return parseDecisionsResponse(payload, request.questions, true);
  } finally {
    clearTimeout(timeout);
  }
}

export function getNoulAnswer(response: DecisionsResponse, id: string): NoulAnswer {
  const answer = response.answers[id];
  if (!answer || answer.type !== 'noul') {
    throw new DecisionError('response', `Expected a Noul answer for ${id}`);
  }
  return answer;
}

export function getChoiceAnswer(response: DecisionsResponse, id: string): ChoiceAnswer {
  const answer = response.answers[id];
  if (!answer || answer.type !== 'choice' || !answer.probabilities) {
    throw new DecisionError('response', `Expected a Choice answer for ${id}`);
  }
  return answer;
}
