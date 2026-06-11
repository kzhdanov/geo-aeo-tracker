# Changelog

All notable changes to GEO/AEO Tracker are documented here.

---

## [1.3.0] — 2026-06-11

### ✨ Runs in their own Supabase table; cloud storage is now required

Each scrape run is now stored as a row in a `runs` Postgres table instead of
inside the single `kv_store` JSON blob. This unlocks SQL analytics over run
history, removes the 500-run cap, and lets external analyzers (Claude Code /
OpenRouter) write verdicts without racing the app's autosave. IndexedDB /
localStorage fallbacks are removed — Supabase is the single source of truth.

**What changed**

- **`supabase/migrations/002_runs.sql`** — new `runs` table (one row per scrape
  run, RLS on / service-role only) and `run_analyses` table for upcoming LLM
  analyzer verdicts. Paste and run in your Supabase SQL editor.
- **`app/api/runs/route.ts`** — new `GET / POST / DELETE` route for runs;
  same server-side service-role proxy model as `/api/state`.
- **`lib/server/runs-store.ts`** — list/insert/delete helpers for the table.
- **`lib/client/runs-api.ts`** — client wrapper for `/api/runs`.
- **`lib/client/sovereign-store.ts`** — cloud-only rewrite. No IDB/localStorage
  fallback: serving a stale local copy and autosaving it back could silently
  roll back newer cloud data. Errors now surface in the UI instead.
- **`lib/client/cloud-mode.ts`** — removed (cloud can no longer be toggled off).
- **`components/sovereign-dashboard.tsx`** — runs load from `/api/runs` and
  persist per-row; the settings blob no longer contains `runs`; legacy blob
  runs are lifted into the table automatically on first load; the workspace
  list now syncs to cloud KV too (theme and active-workspace pointer stay in
  localStorage as device prefs); run deletion hits the API.
- **`components/dashboard/tabs/project-settings-tab.tsx`** — Cloud Sync toggle
  card removed.
- **`package.json`** — removed `idb-keyval`.

**Breaking**

- The app now requires `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` and shows
  an error instead of falling back to browser storage when the cloud is
  unreachable. `NEXT_PUBLIC_CLOUD_STORAGE_ENABLED` is no longer read.

---

## [1.2.0] — 2026-04-17

### ✨ New: Optional Supabase cloud persistence

Local-first storage (IndexedDB) remains the default. When you supply three env vars, all app state is automatically synced to your own free Supabase project — across devices, deploys, and browser clears.

**What changed**

- **`app/api/state/route.ts`** — new `GET / PUT / DELETE` route that proxies reads and writes to Supabase using the `service_role` key server-side. The client never calls Supabase directly. Returns `501` gracefully when cloud is not configured.
- **`lib/server/supabase.ts`** — `getServerSupabase()` singleton; reads `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.
- **`lib/server/kv-store.ts`** — `kvGet` / `kvSet` / `kvDelete` helpers used by the route.
- **`lib/client/cloud-mode.ts`** — `isCloudAvailable()` (build-time env flag) and `isCloudEnabledByUser()` (per-browser localStorage toggle, defaults to `true` when cloud is available).
- **`lib/client/sovereign-store.ts`** — rewired to branch on `isCloudActive()`. IDB becomes a local cache when cloud is active; IDB is the authoritative fallback if the cloud route fails. Public API (`loadSovereignValue` / `saveSovereignValue` / `clearSovereignStore`) is unchanged — all existing callers work without modification.
- **`components/dashboard/tabs/project-settings-tab.tsx`** — new **Cloud Sync** card in Project Settings. Shows setup instructions when cloud is not configured; shows an enable/disable toggle when it is.
- **`supabase/migrations/001_kv_store.sql`** — single-table `kv_store` schema (`key TEXT PK, value JSONB, created_at, updated_at`) with an `updated_at` trigger. Paste and run in your Supabase SQL editor to set up.
- **`package.json`** — added `@supabase/supabase-js ^2.103.3`.
- **`README.md`** — new "☁️ Optional: Cloud persistence with Supabase" section with 5-step setup guide; architecture tree updated; API routes table updated; Cloud Sync added to nav.

**Env vars needed (all optional)**

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key   # server-side only, never exposed to client
NEXT_PUBLIC_CLOUD_STORAGE_ENABLED=true
```

**What is NOT synced (intentionally local)**

- Theme preference
- Workspace list / active workspace
- The `sovereign-cloud-sync` toggle state itself

---

## [1.1.0] — 2026-03-22

### ✨ Features

- **Prompt tags** — inline tag editing on prompts; filter bar to narrow prompt list by tag
- **Delete individual responses** — confirmation dialog guards accidental deletes
- **Multiple website URLs** — chip-based input supporting multiple URLs per brand
- **Structured competitors** — `Competitor` type with name, aliases, and websites fields

### 🐛 Fixes

- Increase Bright Data scraper timeout with exponential backoff to reduce timeout failures (#3)
- Backward-compatible data migrations for all new data types

---

## [1.0.0] — 2026-03-13

### ✨ Features

- **SRO Analysis** — full 6-stage pipeline: Gemini Grounding → Cross-Platform Citations → SERP → Page Scraping → Site Context → LLM Analysis. Produces SRO Score (0–100) with prioritized recommendations.
- **Parallel batch runs** — all prompt × model combos execute simultaneously via `Promise.allSettled()`
- **Mobile-responsive** — collapsible sidebar (hamburger at `md:` breakpoint), backdrop overlay, responsive KPI grid and model toolbar

### 🆕 New API routes

`/api/sro-analyze`, `/api/bulk-sro` (SSE), `/api/serp`, `/api/site-context`, `/api/unlocker`, `/api/brightdata-platforms`

### 🐛 Fix

- Grok badge invisible in light mode (#1)

---

## [0.1.0] — 2026-02-14

Initial release — 12-tab dashboard, 6 AI model tracking, local-first storage, demo mode, Bright Data + OpenRouter integration.
