import {
  buildClassifyRequest,
  buildJudgeChoiceRequest,
  buildJudgeNoulRequest,
  buildTruthRequest,
  extractTargetText,
  formatChoiceAnswer,
  formatJudgeAnswer,
  formatTruthAnswer,
  HELP_TEXT,
  MODEL_ERROR_TEXT,
  NO_CANDIDATES_TEXT,
  parseCommand,
  readJudgeNoulProbability,
  TARGET_REQUIRED_TEXT,
  tokenizeJudgeCandidates,
  type ParsedCommand,
} from './commands';
import {
  evaluateJevDecisions,
  getChoiceAnswer,
  getNoulAnswer,
} from './jev';
import {
  answerGuestQuery,
  parseGuestUpdate,
  TELEGRAM_SECRET_HEADER,
  type GuestUpdate,
} from './telegram';

export interface GuestProcessingEnv {
  JEV_OPENROUTER_TOKEN: string;
  TELEGRAM_BOT_TOKEN: string;
}

export interface Env extends GuestProcessingEnv {
  TELEGRAM_WEBHOOK_SECRET: string;
}

const MAX_WEBHOOK_BODY_BYTES = 200_000;

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function getCommandText(update: GuestUpdate): string | null {
  const message = update.guest_message;
  if (typeof message.text === 'string' && message.text.trim().length > 0) {
    return message.text;
  }
  if (typeof message.caption === 'string' && message.caption.trim().length > 0) {
    return message.caption;
  }
  return null;
}

async function executeCommand(
  command: ParsedCommand,
  targetText: string,
  openRouterToken: string,
): Promise<string> {
  if (command.kind === 'is_this_true') {
    const response = await evaluateJevDecisions(openRouterToken, buildTruthRequest(targetText));
    return formatTruthAnswer(getNoulAnswer(response, 'truth'));
  }

  if (command.kind === 'classify') {
    const built = buildClassifyRequest(targetText, command.options);
    const response = await evaluateJevDecisions(openRouterToken, built.request);
    return formatChoiceAnswer(getChoiceAnswer(response, 'classification'), built.mapping);
  }

  // `/judge` extracts possible bucket names from its free-form request. The
  // replied message is classified only after the requested buckets are known.
  const candidates = tokenizeJudgeCandidates(command.prompt);
  if (candidates.length === 0) {
    return NO_CANDIDATES_TEXT;
  }

  const noulResponse = await evaluateJevDecisions(
    openRouterToken,
    buildJudgeNoulRequest(command.prompt, candidates),
  );
  const selected = candidates.filter((_, index) => {
    const probability = readJudgeNoulProbability(noulResponse, `q_${index}`);
    return probability >= 0.5;
  });

  if (selected.length === 0) {
    return NO_CANDIDATES_TEXT;
  }

  const builtChoice = buildJudgeChoiceRequest(targetText, command.prompt, selected);
  const choiceResponse = await evaluateJevDecisions(openRouterToken, builtChoice.request);
  return formatJudgeAnswer(
    selected,
    getChoiceAnswer(choiceResponse, 'bucket'),
    builtChoice.mapping,
  );
}

export async function processGuestUpdate(
  update: GuestUpdate,
  env: GuestProcessingEnv,
): Promise<void> {
  const guestQueryId = update.guest_message.guest_query_id;
  if (typeof guestQueryId !== 'string' || guestQueryId.length === 0) {
    throw new Error('invalid_guest_update');
  }

  const commandText = getCommandText(update);
  const command = commandText === null ? null : parseCommand(commandText);
  let answer: string;

  if (command === null) {
    answer = HELP_TEXT;
  } else {
    const targetText = extractTargetText(update);
    if (targetText === null) {
      answer = TARGET_REQUIRED_TEXT;
    } else {
      try {
        answer = await executeCommand(command, targetText, env.JEV_OPENROUTER_TOKEN);
      } catch {
        // Do not echo provider errors, response bodies, prompts, or secrets.
        answer = MODEL_ERROR_TEXT;
      }
    }
  }

  await answerGuestQuery(env.TELEGRAM_BOT_TOKEN, guestQueryId, answer);
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    return jsonResponse({ ok: false, error: 'misconfigured' }, 500);
  }

  const suppliedSecret = request.headers.get(TELEGRAM_SECRET_HEADER);
  if (suppliedSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return jsonResponse({ ok: false, error: 'payload_too_large' }, 413);
  }

  let value: unknown;
  try {
    value = JSON.parse(rawBody) as unknown;
  } catch {
    return jsonResponse({ ok: false, error: 'invalid_json' }, 400);
  }

  const update = parseGuestUpdate(value);
  if (!update) {
    // Telegram can still deliver updates queued before `allowed_updates` was
    // narrowed. Acknowledge unrelated update kinds so they are not retried.
    if (typeof value === 'object' && value !== null && !('guest_message' in value)) {
      return jsonResponse({ ok: true, ignored: true });
    }
    return jsonResponse({ ok: false, error: 'invalid_guest_update' }, 400);
  }

  if (!env.TELEGRAM_BOT_TOKEN) {
    return jsonResponse({ ok: false, error: 'misconfigured' }, 500);
  }

  try {
    await processGuestUpdate(update, env);
  } catch {
    return jsonResponse({ ok: false, error: 'telegram_delivery_failed' }, 502);
  }

  return jsonResponse({ ok: true });
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/health') {
    return jsonResponse({ ok: true, service: 'judge-jev' });
  }

  if (request.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);
  }

  return handleWebhook(request, env);
}

export default {
  fetch: handleRequest,
};
