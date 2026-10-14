# Fireflies.ai Integration

Captures meeting transcripts from Fireflies.ai into Design Space. Agents can then search meetings: *"what did the client say about pricing?"*

## Setup

### 1. Get your Fireflies API key

1. Log in to https://app.fireflies.ai
2. Go to **Integrations** > **Fireflies API**
3. Copy your API key

### 2. Deploy the webhook

Deploy first, so you have the URL to give Fireflies:

```bash
supabase functions deploy webhook-fireflies --project-ref <your-ref> --no-verify-jwt
```

Your webhook URL will be:
```
https://<your-ref>.supabase.co/functions/v1/webhook-fireflies
```

### 3. Configure the Fireflies webhook

1. In Fireflies, go to **Integrations** > **Webhook** > **Add Config**
2. Enter your webhook URL (check the project ref: a config pointing at the wrong Supabase project fails silently)
3. Select event: **Meeting Transcribed**
4. Click **Continue**. **Fireflies generates the signing secret** and shows it
5. Copy the signing secret from the Fireflies UI

Do not invent a secret of your own: the webhook verifies every request against the secret Fireflies generated, and a mismatch gives a 401 on every event.

### 4. Set Supabase secrets

```bash
supabase secrets set FIREFLIES_API_KEY=your-api-key
supabase secrets set FIREFLIES_WEBHOOK_SECRET=<signing-secret-from-step-3>
```

Keep both in Bitwarden as well; never in a file in the repo. The signature arrives in the `x-hub-signature` header, as raw hex or `sha256=<hex>`; the function accepts both.

### 5. Configure project mapping (optional)

Copy `config.example.json` and set it as an env var:

```bash
supabase secrets set FIREFLIES_PROJECT_MAP='{"rules":[...]}'
```

Or leave it unset — transcripts will be stored with `project: null`.

## Manual Sync

Backfill existing transcripts:

```bash
# Last 7 days (default)
deno run --allow-net --allow-env sync.ts

# Last 30 days
deno run --allow-net --allow-env sync.ts --days 30

# Specific transcript
deno run --allow-net --allow-env sync.ts --id <transcript-id>
```

Required env vars for sync:
```
FIREFLIES_API_KEY=...
DESIGN_SPACE_URL=https://<ref>.supabase.co/functions/v1
DESIGN_SPACE_KEY=<anon-key>
```

## How It Works

1. Fireflies sends a webhook when the meeting is transcribed (post-meeting only, no live push)
2. The edge function fetches the full transcript via GraphQL
3. Transcript is chunked by speaker blocks (~800 tokens each)
4. Summary and action items become a separate high-priority chunk
5. Each chunk is stored with embedding in `design_space` table
6. A broadcast notification tells agents about the new meeting

## Data Model

Each chunk is stored as:
- **category:** `meeting_transcript`
- **source:** `fireflies`
- **source_file:** `fireflies:{transcriptId}` (used for deduplication)
- **topics:** extracted from Fireflies keywords
- **metadata:** meeting title, date, duration, speakers, chunk index

## Rate Limits

- Free/Pro: 50 API requests/day
- Business: 60 requests/minute
- Webhook processing is event-driven (1 call per transcript)
