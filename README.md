# Nag agent

A nagging assistant + dashboard that watches Gmail, ClickUp, and Google Calendar for Utah Broadband ops.

See [CLAUDE.md](./CLAUDE.md) for the full design + architecture.

## Local dev

```bash
cp .env.example .env
# Fill in VITE_SUPABASE_ANON_KEY from Supabase dashboard -> Settings -> API
npm install
npm run dev
```

Opens at http://localhost:5173.

## Deploy

```bash
npm run deploy
```

Pushes to `gh-pages` branch. GitHub Pages serves it at https://criddell-blip.github.io/nag-agent/.

## Supabase

- Project ref: `dcmltuyyrmodaqhuudyd`
- URL: https://dcmltuyyrmodaqhuudyd.supabase.co
- Migrations live in `supabase/migrations/` (applied via MCP or `npx supabase db push`)
- Edge Functions live in `supabase/functions/`
