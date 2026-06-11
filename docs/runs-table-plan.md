# План: раны в отдельную таблицу + LLM-анализатор

Дата: 2026-06-11. Статус: код готов (v1.3.0), осталось применить `002_runs.sql`
в Supabase SQL Editor. Удаление IndexedDB подтверждено и выполнено.

## Цель

1. Хранить каждый запуск (run) отдельной строкой в таблице Supabase (под капотом это
   Postgres — та же база, где уже живёт `kv_store`) вместо общего JSON-блоба.
2. Подключить LLM-анализатор (Claude Code локально, позже OpenRouter), который оценивает
   ответы моделей и отслеживает репутацию **signNow, pdfFiller, airSlate** во времени.

## Почему не блоб

- Анализатор и приложение пишут одновременно → в блобе last-write-wins, потеря данных.
- Исторический анализ = SQL по строкам. По блобу — никак.
- Лимит 500 ранов и пересылка всего блоба при каждом автосейве исчезают.

## Этап 1 — схема БД

`supabase/migrations/002_runs.sql`:

```sql
create table runs (
  id            uuid primary key default gen_random_uuid(),
  workspace     text not null default 'default',
  created_at    timestamptz not null default now(),
  provider      text not null,              -- google_ai, ...
  prompt        text not null,
  answer        text not null,
  sources       jsonb not null default '[]',
  -- дешёвые метрики, считаются кодом при вставке (как сейчас)
  visibility_score    int,
  sentiment           text,
  brand_mentions      jsonb,
  competitor_mentions jsonb
);
create index runs_created_at_idx on runs (created_at desc);
create index runs_prompt_idx on runs (prompt);

create table run_analyses (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references runs(id) on delete cascade,
  analyzer       text not null,             -- 'claude-code' | 'openrouter:<model>'
  rubric_version text not null,             -- 'v1', 'v2'...
  verdict        jsonb not null,
  created_at     timestamptz not null default now(),
  unique (run_id, analyzer, rubric_version) -- повторный прогон = новая версия рубрики
);
```

RLS как у `kv_store`: включён, политик нет, доступ только через service_role.

Формат `verdict` (рубрика v1):

```json
{
  "brands": {
    "pdfFiller": {
      "mentioned": true,
      "tone": "mixed",
      "position": "recommended | listed | criticized | absent",
      "claims_positive": ["..."],
      "claims_negative": ["billing complaints after trial"],
      "negative_sources": ["reddit.com/r/assholedesign", "trustpilot.com"]
    },
    "signNow": { "...": "..." },
    "airSlate": { "...": "..." }
  },
  "summary": "1-2 предложения"
}
```

## Этап 2 — API

- `app/api/runs/route.ts`: `POST` (вставка батча после запуска), `GET ?limit&offset&workspace`
  (новые сверху), `DELETE ?id=`.
- `kv_store` и `/api/state` остаются как есть — только под настройки
  (brand, competitors, customPrompts, schedule...). Поле `runs` из блоба уходит.

## Этап 3 — клиент

`components/sovereign-dashboard.tsx`:
- Загрузка: настройки из `/api/state` + последние раны из `/api/runs` (limit 100).
- После запуска: `POST /api/runs` вместо записи в стейт-блоб.
- Удаление рана: `DELETE /api/runs?id=`.
- `runs` исключить из автосейва блоба. Лимит `.slice(0, 500)` убрать.

## Этап 4 — миграция данных

✅ Сделано автоматикой вместо скрипта: при первой загрузке воркспейса клиент видит,
что в таблице `runs` пусто, а в блобе лежат старые раны — переносит их в таблицу
(`persistRuns`), после чего автосейв сохраняет блоб уже без `runs`. Если таблицы
ещё нет (миграция 002 не применена) — загрузка падает с ошибкой на экране,
автосейв заблокирован, старые данные не теряются.

## Этап 5 — анализатор

1. **Claude Code (старт):** скрипт/инструкция — выбрать раны без записи в `run_analyses`
   (для текущей рубрики), оценить по рубрике v1, вставить verdict через REST.
   Бесплатно, рубрику легко итерировать.
2. **OpenRouter (автоматика, позже):** роут `app/api/analyze-runs/route.ts` по образцу
   `lib/server/openrouter-sro.ts` + cron (vercel.json / GitHub Action).
   Нужен `OPENROUTER_API_KEY` в `.env`.

Отчёты (потом): SQL/вкладка — динамика тона по брендам, топ повторяющихся
негативных тезисов, источники негатива.

## Решение по IndexedDB — ПРЕДЛОЖЕНИЕ: удалить

Сейчас в cloud-режиме IDB **не ускоряет** загрузку (чтение всегда идёт сначала в облако),
а служит только fallback'ом при недоступности Supabase. Опасный сценарий: облако
недоступно при загрузке → подхватили устаревшую копию из IDB → автосейв заливает её
обратно в облако → откат свежих данных.

Удаляем: `idb-keyval`, localStorage-зеркало, ветку local-mode в `sovereign-store.ts`,
тумблер CloudSyncCard (облако становится обязательным). При недоступности облака —
явная ошибка на экране вместо тихой работы со старой копией.

Цена: приложение перестаёт работать без настроенного Supabase и офлайн.
Для внутреннего инструмента — приемлемо.

## Порядок работ

1. [x] Миграция 002 (таблицы) — файл готов, **применить в Supabase SQL Editor**
2. [x] `/api/runs` + правка клиента
3. [x] Миграция данных (автоматическая, при первой загрузке)
4. [x] Удаление IndexedDB
5. [ ] Рубрика v1 + первый прогон анализатора через Claude Code
6. [ ] (позже) OpenRouter + cron

## Открытые вопросы

- [x] Удаление IndexedDB — подтверждено, удалено в v1.3.0
- [ ] signNow/airSlate: добавлять ли отдельные промпты под них, или пока только
      отслеживать упоминания в существующих
