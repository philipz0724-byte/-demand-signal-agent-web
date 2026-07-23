# Demand Signal Agent Web

Internal workspace for turning a B2B partner offer into an AI-generated offer profile, ICP and demand signal map.

## Run locally

```bash
npm install
cp .env.example .env.local
npm run dev
```

Add the Supabase publishable/anon key to `.env.local`. Never expose the service-role key or OpenAI key in the frontend.

## Current MVP

- Project dashboard and status overview
- Create prospecting project form
- Project detail workspace
- Supabase `prospecting_projects` integration
- `analyze-prospecting-project` Edge Function invocation
- Loading, ready and failed states
- Demo mode when environment variables are missing
- Responsive desktop/mobile layout

## Expected environment variables

```env
VITE_SUPABASE_URL=https://vgadtonsbclvdexvrvap.supabase.co
VITE_SUPABASE_ANON_KEY=your_publishable_or_anon_key
```

The frontend currently expects project fields named `partner_name`, `website`, `offer`, `target_geography`, `target_customer`, `advantages`, `competitors`, `exclusions`, `status`, `created_at`, and optionally `error_message`.
