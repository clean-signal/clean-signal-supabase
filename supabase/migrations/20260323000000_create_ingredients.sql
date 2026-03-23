-- Ingredient reference table: every unique ingredient encountered from OFF
create table public.ingredients (
  id text primary key,
  name text not null,
  type text not null default 'ingredient',
  risk_tier text,
  risk_reason text,
  vegan text,
  vegetarian text,
  description text,
  product_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_ingredients_type on public.ingredients (type);
create index idx_ingredients_risk_tier on public.ingredients (risk_tier) where risk_tier is not null;
create index idx_ingredients_product_count on public.ingredients (product_count desc);

alter table public.ingredients enable row level security;

create policy "anon_read_ingredients" on public.ingredients
  for select to anon using (true);
create policy "anon_insert_ingredients" on public.ingredients
  for insert to anon with check (true);
create policy "anon_update_ingredients" on public.ingredients
  for update to anon using (true);

-- Junction table: which ingredients are in which products
create table public.product_ingredients (
  barcode text not null references public.products(barcode) on delete cascade,
  ingredient_id text not null references public.ingredients(id),
  position integer not null,
  percent_estimate numeric,
  parent_ingredient_id text references public.ingredients(id),
  depth integer not null default 0,
  primary key (barcode, position)
);

create index idx_product_ingredients_barcode on public.product_ingredients (barcode);
create index idx_product_ingredients_ingredient_id on public.product_ingredients (ingredient_id);

alter table public.product_ingredients enable row level security;

create policy "anon_read_product_ingredients" on public.product_ingredients
  for select to anon using (true);
create policy "anon_insert_product_ingredients" on public.product_ingredients
  for insert to anon with check (true);
create policy "anon_delete_product_ingredients" on public.product_ingredients
  for delete to anon using (true);

-- RPC to refresh product_count for a set of ingredient IDs
create or replace function public.refresh_ingredient_counts(ingredient_ids text[])
returns void as $$
begin
  update public.ingredients i
    set product_count = coalesce(c.cnt, 0),
        updated_at = now()
    from (
      select ingredient_id, count(distinct barcode) as cnt
      from public.product_ingredients
      where ingredient_id = any(ingredient_ids)
      group by ingredient_id
    ) c
    where i.id = c.ingredient_id;

  -- Zero out any that have no rows left
  update public.ingredients
    set product_count = 0, updated_at = now()
    where id = any(ingredient_ids)
      and id not in (
        select distinct ingredient_id from public.product_ingredients
        where ingredient_id = any(ingredient_ids)
      );
end;
$$ language plpgsql;
