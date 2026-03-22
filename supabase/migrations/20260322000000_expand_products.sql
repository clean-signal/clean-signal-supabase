-- Expand products table with more Open Food Facts data
alter table public.products add column nutriscore_grade text;
alter table public.products add column nutriscore_score integer;
alter table public.products add column image_url text;
alter table public.products add column image_small_url text;
alter table public.products add column ingredients_count integer;
alter table public.products add column additives jsonb;
alter table public.products add column allergens jsonb;
alter table public.products add column traces jsonb;
alter table public.products add column has_palm_oil boolean;
alter table public.products add column has_seed_oil boolean;
alter table public.products add column vegan_status text;
alter table public.products add column vegetarian_status text;
alter table public.products add column ecoscore_grade text;
alter table public.products add column saturated_fat_100g numeric;
alter table public.products add column sugars_100g numeric;
alter table public.products add column salt_100g numeric;
alter table public.products add column fiber_100g numeric;
