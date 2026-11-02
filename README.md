# steady-backend

The coach proxy for [Steady](https://github.com/jnnabugwu/steady): Vercel functions that
stream Claude (Opus 5.5) replies to the iPhone app.

- Holds the Anthropic API key. The app never has it.
- Verifies Apple App Attest on every request, so only the genuine Steady app on a real
  iPhone can use it.
- Owns the coach's system prompt and guardrails, so a guardrail fix ships without App Review.
- Keeps no conversation text: logs are metadata only (status, token counts, latency).
- Caps cost per device per day.

Design and tasks: [jnnabugwu/steady#149](https://github.com/jnnabugwu/steady/issues/149)
(tracking: [#155](https://github.com/jnnabugwu/steady/issues/155)).

## Secrets

`ANTHROPIC_API_KEY` and the Upstash Redis variables live in the Vercel project's
environment variables only. For local development, `vercel env pull .env.local`; `.env*`
files and `.vercel/` are gitignored. Never commit a key.
