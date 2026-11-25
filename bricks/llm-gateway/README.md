# LLM Gateway & Prompt Router (`@poc/llm-gateway`)

Prompt templates, text generation through a provider adapter, and per-workspace token usage logs, under `/api/ai`.
No provider adapter is registered by default: until one is connected, `POST /api/ai/generate` answers
`503 NOT_CONFIGURED` (story 0.9).

## Billing (story 1.13)

Every generation is paid for from the caller's workspace wallet, unless the app turns billing off.

| Setting       | Values             | Default  |
| ------------- | ------------------ | -------- |
| `billingMode` | `wallet` or `none` | `wallet` |

The setting is passed to the routes as the option `billing`.

- **`wallet`:** the assembler wires the route option `charger` to credit-wallet's `walletCharger` export
  (`{ "$capability": "credit-wallet.walletCharger" }`; credit-wallet lists it in `worker.capabilityExports`).
  llm-gateway never imports credit-wallet. A blueprint that enables llm-gateway with billing `wallet` but not
  credit-wallet **fails to assemble**, with a message that names both fixes (enable credit-wallet, or set `billingMode`
  to `none`). If the routes are mounted by hand without a charger, `POST /api/ai/generate` answers
  `503 BILLING_NOT_CONFIGURED`.
- **`none`:** nothing is charged, and every successful response says `"billed": false`. Choose this only for an app
  whose operator pays for generation some other way.

What a call does, in order:

1. The model must be on the allowlist (`models`), or the call gets `400 MODEL_NOT_ALLOWED`.
2. `maxTokens` must be in range (`400`), and the prompt, typed or hydrated from a template, at most 65536 characters
   (`400 PROMPT_TOO_LONG`).
3. One of the app's providers (`provider`, then its configured `fallbackProviders`) must be connected, or the call gets
   `503 NOT_CONFIGURED`.
4. **Reserve.** The most the call can cost is worked out from an upper estimate of the prompt's tokens (its UTF-8
   length in bytes plus 16 for the provider's framing; a byte-level BPE token covers at least one byte) plus
   `maxTokens`, at the model's rates. That amount is debited from the wallet in one atomic step, with the idempotency
   key `ai:<log id>`. If the wallet cannot cover it, the call gets `402 INSUFFICIENT_CREDITS` and nothing is generated.
   Because the debit is the balance check, parallel calls cannot all pass on one balance: only those the balance covers
   go on to generate.
5. A log row is written with the status `reserved` before generating, so a call that is cancelled or crashes from here
   on leaves a record of the credits it holds.
6. The text is generated. If every provider fails, the whole reservation is refunded (key `ai:<log id>:refund`), the
   row becomes `refunded`, and the call gets `502 PROVIDER_ERROR`.
7. **Settle.** The billed cost is capped at the reservation: prompt tokens are billed up to the reservation's estimate
   and completion tokens up to `maxTokens`. Tokens a provider reports beyond those caps are not billed. The rest of the
   reservation is refunded with the key `ai:<log id>:refund`, and the row is updated.

| `billing_status` | Meaning                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `reserved`       | The call's maximum is held and the call has not finished (see below).                                      |
| `charged`        | The text was returned; the wallet paid the actual cost (`cost_credits`) and got the rest back.             |
| `refund_failed`  | The text was returned, but refunding the unused part failed; `cost_credits` is the whole reservation.       |
| `refunded`       | Every provider failed and the whole reservation was refunded; `cost_credits` is 0.                         |
| `billing_failed` | No text, and credits may still be held: the refund failed, or the reservation's outcome was unknown. `cost_credits` is what is held as far as is known. |
| `not_billed`     | Billing `none`, and every row written before 1.13.                                                         |

**Reconciling.** A row still `reserved` well after the request time limit is a call that was cancelled or crashed
between its reservation and its settlement: its `cost_credits` are held in the wallet (ledger key `ai:<log id>`) and
were never refunded. Rows with `refund_failed` or a non-zero `billing_failed` are held credits too. Return them with a
refund under `ai:<log id>:refund`, which pays back at most what the reservation took and never twice.

**Failures around the money.**

- **The reservation debit errors.** It is retried once with the same key. The wallet checks the balance before the
  key, so a retry whose first attempt did commit can be refused for the balance; the charger then finds the
  reservation on the ledger and answers "duplicate", so nothing is taken twice and the call goes on. If the outcome is
  still unknown (two errors), the call answers `500 INTERNAL_ERROR` without generating: it refunds under
  `ai:<log id>:refund` (which returns only what was actually taken, so it is safe when nothing committed), writes a
  `billing_failed` row, and logs the log id, the workspace and the amount with the correlation id.
- **A refund errors.** It is retried once with the same key. If it errors again, the ledger is checked for the refund
  key to tell whether it happened. Only if it did not does the row say `refund_failed` (or `billing_failed` after a
  provider failure). The text is returned either way, and the error is logged with a correlation id.
- **Writing the log row fails.** The text the caller paid for is still returned, and the error is logged with a
  correlation id.

`GET /api/ai/usage` counts delivered generations only: `charged`, `refund_failed` and `not_billed` rows. `reserved`,
`refunded` and `billing_failed` rows are left out of the totals and the count.

## Models and cost

| Setting  | Format                                                         | Default           |
| -------- | -------------------------------------------------------------- | ----------------- |
| `models` | comma-separated `id:promptCreditsPer1k:completionCreditsPer1k` | `gpt-4o-mini:1:2` |

For example, `gpt-4o-mini:1:2,@cf/meta/llama-3.1-8b-instruct:0.5:1`. Each entry is read from the right: the last two
fields are the rates and the rest is the id, so an id may contain `:`. Rates are 0 to 999999 and may have up to six
decimals. **The first model is the default**, both for a call that names no model and for a template created without
one. A model listed twice keeps its first price. The cost of a call is

```
ceil(promptTokens * promptCreditsPer1k / 1000 + completionTokens * completionCreditsPer1k / 1000)
```

and at least 1 credit for every successful call. It is priced at the model the caller asked for, whatever name the
provider reports back. A request for a model that is not listed gets `400 MODEL_NOT_ALLOWED`. So does a template whose
`default_model` is not listed, both when the template is created and when it is used. A malformed `models` value is
refused when the blueprint is assembled (the setting declares a pattern).

## maxTokens

| Setting     | Values      | Default |
| ----------- | ----------- | ------- |
| `maxTokens` | 1 to 131072 | 4096    |

The setting is the ceiling. A request may send `maxTokens`, a whole number from 1 up to that ceiling. Anything else
gets `400`. A request without it uses the ceiling. The value is passed to the provider adapter:
`adapter.generate(prompt, model, { temperature, maxTokens })`.

## Providers

| Setting             | Format                                     | Default |
| ------------------- | ------------------------------------------ | ------- |
| `defaultProvider`   | `workers-ai`, `openai`, `anthropic`, `gemini` | `workers-ai` |
| `fallbackProviders` | up to three comma-separated provider names | (none)  |

Only the app chooses providers: the primary one, then its fallbacks in order, without repeats. A request body cannot
name a provider or add a fallback; such fields are ignored.

## Templates

A template's text is at most 65536 characters with at most 256 `{{placeholders}}` (`400 TOO_MANY_PLACEHOLDERS`), and
the prompt after they are filled in is at most 65536 characters (`400 PROMPT_TOO_LONG`). Filling stops as soon as the
prompt passes that limit, so a template with many placeholders and a large variable never builds the long string. A request may send at most 64 variables, each value at most 16384 characters.

## Errors

- **Provider failure** (every provider in the chain failed): `502 { code: "PROVIDER_ERROR", error: "The AI provider
  could not complete the request", correlationId }`. The provider's own message is written only to `console.error`,
  with the same correlation id. It never reaches the caller.
- **Unexpected failure:** `500 { code: "INTERNAL_ERROR", error: "Internal error", correlationId }`, with the details
  in the log only.
