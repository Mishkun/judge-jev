# judge-jev

`judge-jev` is a small, strict Cloudflare Worker that lets a Telegram bot make
bounded decisions with OpenRouter's Jev model. It is deliberately not a chat
bot: Jev returns typed Noul and Choice decisions, while this Worker owns command
parsing, thresholds, labels, and all user-visible formatting.

The OpenRouter and TypeSafe research behind the request/response contract is in
[`docs/jev-api.md`](docs/jev-api.md).

## User experience

The bot is a **Guest Mode** bot. A user summons it in a chat by mentioning it
in a command or replying to a message from it. The Worker receives one
`guest_message` update containing the summoning command and, when present, the
`guest_message.reply_to_message` context. It reads only the replied message's
`text` or `caption`; it does not fetch chat history or inspect unrelated
messages.

Commands may include Telegram's bot mention suffix (`/judge@my_bot ...`).

### `/is_this_true`

Reply to a text message and send `/is_this_true`. The Worker sends one Noul
question and displays the model's yes probability as `true` and its
complement as `false`:

```text
Вероятности:
true: 0.73
false: 0.27
```

This is a calibrated model probability, not a proof or a guarantee for one
message.

### `/classify a | b`

Reply to a text or media caption and provide a closed set of options separated
by `|`:

```text
/classify факт | мнение
```

The model sees opaque labels (`c_0`, `c_1`), while the Worker maps the answer
back to the exact local option text and prints all Choice probabilities. Empty,
duplicate, or more-than-16 options are rejected.

### `/judge <request>`

Reply to a message and write a free-form classification request. The possible
bucket/category/scale words come from the request itself, not from the replied
text:

```text
/judge оцени: кринж, кайф или жесть
```

The Worker:

1. extracts individual Unicode words from the `/judge` request;
2. splits on whitespace and punctuation, never forming ngrams;
3. removes a small list of obvious Russian and English stopwords;
4. sends **one batched Noul question per candidate**, with the candidate and
   request values in indexed structured state. Each question asks whether its
   candidate is a named category/bucket/scale value in the requested scale;
5. keeps every candidate whose Noul probability is `>= 0.5`, in prompt order;
6. sends a second closed Choice request that classifies the replied text among
   all selected buckets. With exactly one selected bucket, the options are that
   bucket and its explicit `не ...` counterpart.

If no request word reaches `0.5` (or the request has no candidate words), the
bot asks for explicit `|`-separated options and does not make the second Choice
call. Candidate extraction is a deliberately transparent heuristic, not a
general information-extraction system.

## Architecture

```text
Telegram webhook
  │  X-Telegram-Bot-Api-Secret-Token
  ▼
Cloudflare Worker
  ├─ validate Guest Mode update
  ├─ parse command and replied text/caption
  ├─ build local Noul/Choice JSON
  ├─ POST https://openrouter.ai/api/alpha/decisions
  │    model: ~typesafe/jev-latest
  ├─ validate model, answer IDs/types, probabilities, and usage
  └─ POST https://api.telegram.org/bot…/answerGuestQuery
       { guest_query_id, result: InlineQueryResultArticle }
```

There is no OpenAI-compatible chat call, SDK, provider abstraction, fallback
model, or adapter. `src/jev.ts` makes the direct Alpha Decisions request. A
single `/is_this_true` or `/classify` uses one Jev request; `/judge` necessarily
uses two because the second Choice option set depends on the first batched Noul
results. Telegram delivery is a separate Bot API call.

Every successful Jev response is checked at runtime. Noul values must be
finite numbers in `[0, 1]`. Choice labels must be submitted opaque IDs, and
the required probability map must cover exactly the submitted labels, remain in
`[0, 1]`, and sum to one within a small tolerance. Token usage is also checked.

`GET /health` returns a minimal non-secret JSON health response.

## Local setup

Requirements: Node.js 20+ and npm.

```sh
npm install
npm run check
```

For local Worker development, create `.dev.vars` (it is gitignored):

```dotenv
JEV_OPENROUTER_TOKEN=or-...
TELEGRAM_BOT_TOKEN=123456:...
TELEGRAM_WEBHOOK_SECRET=long-random-webhook-secret
```

`TELEGRAM_WEBHOOK_SECRET` must be a random 1–256 character value containing
only `A-Z`, `a-z`, `0-9`, `_`, or `-`, as required by Telegram. Keep it out of
source, fixtures, and logs.

Then run:

```sh
npm run dev
```

The Worker does not read a `.env` file at runtime. For deployment, store the
same values as Wrangler secrets. Use the project-local Wrangler executable via
`npx` (or the npm scripts), rather than relying on a global install:

```sh
npx wrangler secret put JEV_OPENROUTER_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npm run deploy
```

The names are intentionally different from generic provider examples so it is
clear which account is charged and which secret is used. Never put any of the
three values in `wrangler.toml`, source, fixtures, or logs.

### Local Telegram long polling

For local development without a Worker webhook, copy the example environment
file and run the polling wrapper:

```sh
cp .env.example .env
npm run dev:polling
```

The poller requires only `JEV_OPENROUTER_TOKEN` and `TELEGRAM_BOT_TOKEN`; it
does not use a webhook secret. It calls `getWebhookInfo` before polling and
refuses to start when Telegram has an active webhook. To intentionally take
over that bot, set `POLLING_DELETE_WEBHOOK=1`; the wrapper then calls
`deleteWebhook` with `drop_pending_updates=false` before using `getUpdates`.
It polls only `guest_message` updates, advances `offset`, and stops cleanly on
`SIGINT`/`SIGTERM`. It never prints tokens or message content.

## Telegram / BotFather setup

1. Create a bot with [@BotFather](https://t.me/BotFather).
2. In BotFather's bot settings Mini App, enable **Guest Mode**. Guest Mode was
   introduced in Bot API 10.0 and is available in the Bot API 10.3 contract.
3. Add the commands in BotFather's command editor (or use `setMyCommands`):
   `/is_this_true`, `/classify`, and `/judge`.
4. Deploy the Worker over HTTPS and set its webhook. `allowed_updates` should
   include `guest_message`:

```sh
curl -fsS -X POST \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  --data "$(node -e 'process.stdout.write(JSON.stringify({url: process.argv[1], secret_token: process.argv[2], allowed_updates: ["guest_message"]}))' \
    'https://judge-jev.example.workers.dev/' "$TELEGRAM_WEBHOOK_SECRET")"
```

Telegram will then send the exact relevant shape:

```json
{
  "update_id": 42,
  "guest_message": {
    "guest_query_id": "…",
    "text": "/judge оцени: кринж, кайф или жесть",
    "reply_to_message": { "text": "это очень спорно" }
  }
}
```

The Worker verifies the `X-Telegram-Bot-Api-Secret-Token` header before reading
the request body. The answer call uses the singular `result` parameter required
by `answerGuestQuery`, not the `results` array used by `answerInlineQuery`.

## Opt-in live smoke test

Unit tests never call a model. To intentionally spend a small amount of
OpenRouter credit on a synthetic request, set `JEV_OPENROUTER_TOKEN` in the
shell and run:

```sh
JEV_OPENROUTER_TOKEN=or-... npm run smoke
```

The script checks the typed response and prints only pass/fail status. It never
prints the token, request, response, or user content. Do not run it in CI or
with production-sensitive text.

## Heuristic Russian `/judge` examples

These are **expected bucket-word examples for a heuristic**, not accuracy
claims. Jev may return a different probability on an ambiguous or multilingual
case; the examples are useful as a small human-readable gold set, not as a
contract. The first list is what the first-stage Nouls may extract. The second
list is the final Choice set: a single extracted bucket gets an explicit
negative option.

| `/judge` request | Extracted buckets | Final Choice buckets | Replied text (optional) |
| --- | --- | --- | --- |
| `оцени: кринж, кайф или жесть` | `[кринж, кайф, жесть]` | `[кринж, кайф, жесть]` | `этот ролик` |
| `это база?` | `[база]` | `[база, не база]` | `так принято` |
| `выбери уровень: низкий, средний или высокий` | `[низкий, средний, высокий]` | `[низкий, средний, высокий]` | `умеренная нагрузка` |
| `оцени тон: дружелюбный, нейтральный, грубый` | `[дружелюбный, нейтральный, грубый]` | `[дружелюбный, нейтральный, грубый]` | `Спасибо за помощь` |
| `это фейк или правда?` | `[фейк, правда]` | `[фейк, правда]` | `Новость из чата` |
| `определи статус: новая, в работе, готова` | `[новая, в работе, готова]` | `[новая, в работе, готова]` | `Задача закрыта` |
| `оцени риск: безопасно, спорно или опасно` | `[безопасно, спорно, опасно]` | `[безопасно, спорно, опасно]` | `Ссылка на сайт` |
| `выбери жанр — комедия, драма или хоррор` | `[комедия, драма, хоррор]` | `[комедия, драма, хоррор]` | `Сюжет фильма` |
| `это мем?` | `[мем]` | `[мем, не мем]` | `картинка` |
| `поставь приоритет: p0, p1 или p2` | `[p0, p1, p2]` | `[p0, p1, p2]` | `Срочный баг` |
| `норм или токсично?` | `[норм, токсично]` | `[норм, токсично]` | `Комментарий` |
| `насколько срочно: низкая, средняя, высокая` | `[низкая, средняя, высокая]` | `[низкая, средняя, высокая]` | `Запрос коллеги` |

Words such as `и`, `в`, `на`, `или`, and `это` are removed before the Noul
batch. If no prompt word reaches `0.5`, the clarification suggests explicit
options such as `/classify кринж | кайф | жесть`.

## Privacy and operational limits

* The OpenRouter bearer token and Telegram bot token are server-side secrets.
  They are never returned to the client and the Worker contains no logging of
  prompts, captions, request bodies, headers, or provider response bodies.
* The replied text/caption and command prompt are sent to OpenRouter because
  they are the model input. OpenRouter/provider retention and data policies can
  vary; check the current policy for the chosen route before handling sensitive
  data. This project does not claim zero retention.
* No database or long-term conversation memory is used. Guest Mode does not
  grant chat history, and the Worker reads only the single replied message.
* Input, command, option, candidate, request-body, and outgoing-message lengths
  are capped. `/judge` batches at most 32 prompt candidates and keeps the
  serialized Decisions request under a conservative byte budget. Choice options
  use opaque code-owned IDs; arbitrary model text is never parsed into a label.
* Jev's calibration is a population-level property. Thresholds, including the
  `/judge` `>= 0.5` rule, need evaluation against a labeled set before relying
  on the bot for consequential decisions. `/judge` deliberately returns a
  heuristic bucket and should not trigger external side effects.

## Verification

```sh
npm test
npm run typecheck
```

`npm run check` runs both commands in sequence.

The tests cover command mentions, text/caption targeting, Unicode tokenization,
stopword removal, candidate caps, opaque labels, request construction, strict
response validation, webhook secret rejection, the exact Guest Mode update, the
singular `answerGuestQuery` article shape, the batched `/judge` flow, and the
no-candidate fast path. Polling tests cover response parsing, offset progression,
webhook refusal/takeover helpers, and shared-update shutdown behavior.
