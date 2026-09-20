export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';
export const TELEGRAM_API_BASE = 'https://api.telegram.org';
export const MAX_TELEGRAM_MESSAGE_CHARS = 4096;
export const TELEGRAM_REQUEST_TIMEOUT_MS = 12_000;

export interface TelegramMessage {
  message_id?: number;
  date?: number;
  chat?: {
    id: number | string;
    type: string;
  };
  text?: string;
  caption?: string;
  guest_query_id?: string;
  reply_to_message?: TelegramMessage;
}

/** The Bot API Guest Mode update: the query id belongs to guest_message. */
export interface GuestUpdate {
  update_id: number;
  guest_message: TelegramMessage;
}

export interface InlineQueryResultArticle {
  type: 'article';
  id: string;
  title: string;
  input_message_content: {
    message_text: string;
  };
}

export interface AnswerGuestQueryPayload {
  guest_query_id: string;
  result: InlineQueryResultArticle;
}

export class TelegramError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TelegramError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMessage(value: unknown): value is TelegramMessage {
  if (!isRecord(value)) {
    return false;
  }

  for (const field of ['text', 'caption', 'guest_query_id'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      return false;
    }
  }

  if (value.reply_to_message !== undefined && !isMessage(value.reply_to_message)) {
    return false;
  }

  return true;
}

/** Parse only the Guest Mode shape needed by this Worker. */
export function parseGuestUpdate(value: unknown): GuestUpdate | null {
  if (
    !isRecord(value) ||
    typeof value.update_id !== 'number' ||
    !Number.isInteger(value.update_id) ||
    !isMessage(value.guest_message)
  ) {
    return null;
  }

  const guestQueryId = value.guest_message.guest_query_id;
  if (typeof guestQueryId !== 'string' || guestQueryId.length === 0) {
    return null;
  }

  return {
    update_id: value.update_id,
    guest_message: value.guest_message,
  };
}

function truncateMessage(value: string): string {
  return Array.from(value).slice(0, MAX_TELEGRAM_MESSAGE_CHARS).join('');
}

export function createGuestAnswerPayload(
  guestQueryId: string,
  answer: string,
): AnswerGuestQueryPayload {
  return {
    guest_query_id: guestQueryId,
    result: {
      type: 'article',
      id: 'jev-answer',
      title: 'Jev',
      input_message_content: {
        message_text: truncateMessage(answer),
      },
    },
  };
}

/** Call the Bot API's singular answerGuestQuery result endpoint. */
export async function answerGuestQuery(
  botToken: string,
  guestQueryId: string,
  answer: string,
): Promise<void> {
  if (botToken.trim().length === 0 || guestQueryId.length === 0) {
    throw new TelegramError('Telegram configuration is incomplete');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_REQUEST_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await fetch(
        `${TELEGRAM_API_BASE}/bot${botToken}/answerGuestQuery`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(createGuestAnswerPayload(guestQueryId, answer)),
          signal: controller.signal,
        },
      );
    } catch {
      throw new TelegramError('Telegram request failed');
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TelegramError('Telegram returned invalid JSON');
    }

    if (!response.ok || !isRecord(payload) || payload.ok !== true) {
      throw new TelegramError('Telegram rejected the guest answer');
    }
  } finally {
    clearTimeout(timeout);
  }
}
