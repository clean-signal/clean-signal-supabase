# Clean Signal — Supabase Backend

Barcode nutrition lookup app. Scan a food barcode → get nutritional info from Open Food Facts, cached in Supabase.

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

```bash
supabase link --project-ref zijbiydtfezbbgyikcgc
supabase db push                                    # Push new migrations
supabase functions deploy lookup-barcode --no-verify-jwt  # Deploy Edge Function
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
| nova_group | integer | 1=unprocessed, 4=ultra-processed |
| ingredients_text | text | |
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

## Edge Function: lookup-barcode

**Endpoint**: `POST /functions/v1/lookup-barcode`
**Body**: `{ "barcode": "50457250" }`

### Flow
1. Check `products` table for cached data
2. If found and < 30 days old → return `{ source: "cache", product: {...} }`
3. If stale or missing → call Open Food Facts API
4. If API returns product → upsert into `products`, return `{ source: "api", product: {...} }`
5. If API returns 404 or `status: 0` → log to `not_found_barcodes`, return `{ error: "Product not found" }` (HTTP 404)

### Known gotcha
Open Food Facts returns **HTTP 404** (not 200 with `status: 0`) for some missing products. The function handles both cases.

### Logging
All requests are logged with `console.log`/`console.warn`/`console.error` prefixed with `[lookup-barcode]`. View logs in the Supabase dashboard (CLI v2.72.7 doesn't support `functions logs`).

### Debugging production
Query tables directly with service role key:
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
