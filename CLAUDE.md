# Clean Signal — Supabase Backend

Barcode nutrition lookup app. Scan a food barcode → get nutritional info from Open Food Facts, cached in Supabase. Computes a Clean Score (0-100) based on evidence-based longevity research.

## Stack

- **Database**: Supabase (Postgres 17)
- **Edge Functions**: Deno/TypeScript (deployed to Supabase Edge Runtime)
- **External API**: Open Food Facts (no auth needed, `User-Agent: CleanSignal/1.0`)
- **Supabase CLI**: v2.72.7 (no `functions logs` command — use dashboard for logs)

## Remote Project

- **Project ref**: `zijbiydtfezbbgyikcgc`
- **Dashboard**: https://supabase.com/dashboard/project/zijbiydtfezbbgyikcgc
- **Edge Functions URL**: https://zijbiydtfezbbgyikcgc.supabase.co/functions/v1/
- **Function logs**: https://supabase.com/dashboard/project/zijbiydtfezbbgyikcgc/functions/lookup-barcode/logs
- **GitHub**: https://github.com/clean-signal/clean-signal-supabase

## Local Development

Local ports are offset to avoid conflicts with streak-quest (which uses 543xx).

```bash
supabase start          # Starts on port 54421 (API), 54422 (DB), 54423 (Studio)
supabase db reset       # Wipe and replay migrations
supabase functions serve # Serve Edge Functions locally
```

- **Local API**: http://127.0.0.1:54421
- **Local Studio**: http://127.0.0.1:54423
- **Local DB**: postgresql://postgres:postgres@127.0.0.1:54422/postgres

`psql` is not installed. Use docker exec to query local DB:
```bash
docker exec supabase_db_clean-signal-supabase psql -U postgres -c "SELECT ..."
```

## Deploying

**CI/CD (preferred)**: Push to `main` triggers GitHub Actions (`.github/workflows/deploy.yml`). Runs migrations and deploys all edge functions automatically. Only triggers on changes to `supabase/` directory.

**Required GitHub repo secrets** (set at https://github.com/clean-signal/clean-signal-supabase/settings/secrets/actions):
- `SUPABASE_ACCESS_TOKEN` — generate at https://supabase.com/dashboard/account/tokens
- `SUPABASE_DB_PASSWORD` — database password from project settings

**Manual deploy** (fallback — requires CLI auth and direct DB access on port 5432):
```bash
supabase link --project-ref zijbiydtfezbbgyikcgc
supabase db push
supabase functions deploy lookup-barcode --no-verify-jwt
supabase functions deploy lookup-ingredient --no-verify-jwt
```

After deploying, clear cached products to force re-scoring:
```bash
SERVICE_KEY="<from supabase projects api-keys --project-ref zijbiydtfezbbgyikcgc>"
curl -s -X DELETE "https://zijbiydtfezbbgyikcgc.supabase.co/rest/v1/products?barcode=neq.IMPOSSIBLE" \
  -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY"
```

JWT verification is disabled — no user auth yet.

## Schema

All tables in `public` schema. RLS enabled on everything with anon read/write policies (no auth yet).

### products
Caches successful barcode lookups from Open Food Facts.

| Column | Type | Notes |
|--------|------|-------|
| barcode | text PK | EAN-8, EAN-13, UPC-E, etc. |
| product_name | text | |
| brand | text | |
| energy_kcal_100g | numeric | Per 100g |
| proteins_100g | numeric | Per 100g |
| carbohydrates_100g | numeric | Per 100g |
| fat_100g | numeric | Per 100g |
| saturated_fat_100g | numeric | Per 100g |
| sugars_100g | numeric | Per 100g |
| salt_100g | numeric | Per 100g |
| fiber_100g | numeric | Per 100g |
| nova_group | integer | 1-4, from OFF or estimated by `estimateNova()` |
| nutriscore_grade | text | a-e or "unknown" |
| nutriscore_score | integer | Numeric nutriscore |
| ecoscore_grade | text | a-e |
| ingredients_text | text | |
| ingredients_count | integer | Number of ingredients |
| additives | jsonb | Array of `{id, name}` objects e.g. `[{"id":"E412","name":"Guar gum"}]` |
| allergens | jsonb | Array e.g. `["en:milk", "en:mustard"]` |
| traces | jsonb | Array of trace allergens |
| has_palm_oil | boolean | Derived from ingredients_analysis_tags |
| has_seed_oil | boolean | Derived from ingredients list (recursive check) |
| vegan_status | text | vegan, non-vegan, or unknown |
| vegetarian_status | text | vegetarian, non-vegetarian, or unknown |
| image_url | text | Full-size product image |
| image_small_url | text | Thumbnail product image |
| clean_score | integer | 0-100 evidence-based longevity score |
| clean_score_breakdown | jsonb | Array of `{factor, points, maxPoints, verdict, estimated}` |
| fetched_at | timestamptz | When data was fetched from API — used for 30-day staleness |
| created_at | timestamptz | |

### not_found_barcodes
Tracks barcodes that Open Food Facts doesn't have. These are never cached — always retried with API.

| Column | Type | Notes |
|--------|------|-------|
| barcode | text PK | |
| scan_count | integer | Incremented on each scan |
| first_scanned_at | timestamptz | |
| last_scanned_at | timestamptz | |

### ingredients
Reference table for every unique ingredient encountered from OFF scans. Auto-populated on each API fetch. Curated fields (`risk_tier`, `risk_reason`, `description`) are never overwritten by the edge function.

| Column | Type | Notes |
|--------|------|-------|
| id | text PK | OFF taxonomy ID e.g. `en:wheat-flour`, `en:e322` |
| name | text | Display name from OFF |
| type | text | `ingredient`, `additive`, or `vitamin` (heuristic) |
| risk_tier | text | `red`, `caution`, `positive`, or null (curated) |
| risk_reason | text | Explanation for risk tier (curated) |
| vegan | text | yes/no/maybe from OFF |
| vegetarian | text | yes/no/maybe from OFF |
| description | text | For ingredient pages (curated) |
| product_count | integer | Maintained by trigger — distinct products containing this |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### product_ingredients
Junction table linking products to ingredients. Replaced on each API fetch (delete + insert). PK is `(barcode, position)` not `(barcode, ingredient_id)` because the same ingredient can appear twice in one product (e.g. wheat flour as regular + wholemeal).

| Column | Type | Notes |
|--------|------|-------|
| barcode | text FK → products | ON DELETE CASCADE |
| ingredient_id | text FK → ingredients | |
| position | integer | 1-based order in ingredient list |
| percent_estimate | numeric | From OFF, nullable |
| parent_ingredient_id | text FK → ingredients | null = top-level ingredient |
| depth | integer | 0 = top-level, 1 = sub-ingredient, etc. |

### Ingredient hierarchy design decision

All depths are stored and returned to the client as a flat list. The iOS app displays all ingredients (depth 0, 1, 2, etc.) as equal pills — no nesting in the UI. Rationale: top-level ingredients are often generic category words ("colour", "thickener", "acid") while the actual additives and chemicals that matter for risk scoring are sub-ingredients (e.g. "e150d" under "colour", "guar gum" under "thickener"). Hiding sub-ingredients would hide the most important information. The `depth` and `parent_ingredient_id` fields are preserved in the DB for potential future use but the client treats all ingredients equally.

## Edge Function: lookup-ingredient

**Endpoint**: `POST /functions/v1/lookup-ingredient`
**Body**: `{ "ingredient_id": "en:e412" }`
**Response**: `{ ingredient: {...}, products: [...] }`

Returns the full ingredient record plus all products containing it (barcode, name, brand, score, thumbnail). Used by the iOS ingredient detail page.

## Edge Function: lookup-barcode

**Endpoint**: `POST /functions/v1/lookup-barcode`
**Body**: `{ "barcode": "50457250" }`

### Flow
1. Check `products` table for cached data
2. If found and < 30 days old → return `{ source: "cache", product: {...} }`
3. If stale or missing → call Open Food Facts API
4. If OFF doesn't have NOVA → estimate via `estimateNova()`
5. Resolve additive E-numbers to names via OFF taxonomy API
6. Compute Clean Score with breakdown
7. Upsert into `products`
8. Process ingredients: flatten tree → upsert into `ingredients` → replace `product_ingredients` rows (non-blocking, wrapped in try/catch)
9. Return `{ source: "api", product: {...} }`
10. If API returns 404 or `status: 0` → log to `not_found_barcodes`, return 404

### Clean Score (0-100)

Evidence-based longevity scoring. Weights based on strength of association with all-cause/CVD mortality in large prospective cohorts.

| Factor | Max Points | Threshold | Evidence |
|--------|-----------|-----------|----------|
| Processing (NOVA) | 35 | NOVA 1→35, 2→26, 3→14, 4→0 | Strongest single predictor of UPF mortality |
| Sugars | 20 | Linear 0g→25g per 100g | Robust link to obesity, diabetes, CVD |
| Salt | 20 | Linear 0g→1.5g per 100g | Clear CVD dose-response |
| Saturated fat | 10 | Linear 0g→10g per 100g | Modest CHD/cancer associations |
| Additives | 10 | 0→10, 1→8, 2→6, 3→4, 4→2, 5+→0 | Emerging emulsifier evidence |
| Nutri-Score | 5 | A→5, B→3, C→2, D→1, E→0 | Validated composite sanity check |

**Missing data**: gets full points (benefit of the doubt) but flagged as `estimated: true` in breakdown. The iOS app shows a note when estimated factors exist.

**Hard red flags** (override score after calculation):
- **Industrial trans fats**: ingredients containing "partially hydrogenated" → cap score at 20
- **Processed meat + nitrites**: category match + E249/E250/E251/E252 → subtract 10
- **Alcohol**: `alcohol_100g > 1` → cap score at 50

**NOT scored** (display only): seed oils, palm oil. Evidence for independent mortality impact is weak/controversial — these are markers of UPF patterns, not villains per se.

### NOVA Estimation

When OFF doesn't provide NOVA, `estimateNova()` guesses based on:
- Has additives or UPF marker words (maltodextrin, hydrogenated, etc.) → **NOVA 4**
- Otherwise checks ingredient count and taxonomy status

**Known limitation**: the current estimator is a rough heuristic. It uses OFF's `is_in_taxonomy` flag which is about OFF's data quality, not actual processing level. Needs improvement — likely a proper database mapping ingredient IDs to NOVA categories. For example, tahini (ground sesame) gets NOVA 2 when it should arguably be NOVA 1.

### Known gotchas
- Open Food Facts returns **HTTP 404** (not 200 with `status: 0`) for some missing products. The function handles both.
- OFF sometimes parses storage instructions as ingredients (e.g. "Keep refrigerated below 5°C").
- `additives_tags: []` (empty array) is different from `null` — empty means "confirmed no additives", null means "unknown".
- Additive names are resolved via OFF taxonomy API (`/api/v2/taxonomy?tagtype=additives`) — adds ~200ms to first fetch.

### Logging
All requests are logged with `console.log`/`console.warn`/`console.error` prefixed with `[lookup-barcode]`. View logs in the Supabase dashboard.

### Debugging production
```bash
SERVICE_KEY="<get from supabase projects api-keys --project-ref zijbiydtfezbbgyikcgc>"

# Check cached products
curl -s 'https://zijbiydtfezbbgyikcgc.supabase.co/rest/v1/products?select=*&order=created_at.desc&limit=10' \
  -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY"

# Check not-found barcodes
curl -s 'https://zijbiydtfezbbgyikcgc.supabase.co/rest/v1/not_found_barcodes?select=*&order=last_scanned_at.desc' \
  -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY"

# Test a barcode lookup
curl -s -X POST 'https://zijbiydtfezbbgyikcgc.supabase.co/functions/v1/lookup-barcode' \
  -H 'Content-Type: application/json' -d '{"barcode":"50457250"}'
```

## Conventions

- Migration files: `supabase/migrations/<timestamp>_<description>.sql`
- Every table gets RLS enabled immediately
- Seed data goes in migrations (not seed.sql)
- Edge Functions use `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` env vars (auto-provided)

## Future Work

- **NOVA estimation database**: Build a proper mapping of ingredient IDs → NOVA categories instead of relying on heuristics. The current `estimateNova()` is fragile — it checks `is_in_taxonomy` which reflects OFF data quality, not actual processing level.
- **Additive risk tiers**: Weight specific E-numbers differently (e.g. emulsifiers like E471/E407 more heavily than natural thickeners).
- **Alternative APIs**: For products not in OFF. Will need an ingredient mapping layer when a second data source is added.
- **User accounts**: Auth, dietary preferences, scan history.
