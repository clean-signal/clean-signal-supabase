-- Products table: caches barcode lookups from Open Food Facts
create table public.products (
  barcode text primary key,
  product_name text,
  brand text,
  energy_kcal_100g numeric,
  proteins_100g numeric,
  carbohydrates_100g numeric,
  fat_100g numeric,
  nova_group integer,
  ingredients_text text,
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Index for staleness checks
create index idx_products_fetched_at on public.products (fetched_at);

-- No RLS needed yet (no user auth)
alter table public.products enable row level security;

-- Allow anonymous read/write since there's no auth
create policy "anon_read_products" on public.products
  for select to anon using (true);

create policy "anon_insert_products" on public.products
  for insert to anon with check (true);

create policy "anon_update_products" on public.products
  for update to anon using (true);
