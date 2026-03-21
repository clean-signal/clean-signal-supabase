-- Track barcodes that weren't found in Open Food Facts
create table public.not_found_barcodes (
  barcode text primary key,
  scan_count integer not null default 1,
  first_scanned_at timestamptz not null default now(),
  last_scanned_at timestamptz not null default now()
);

alter table public.not_found_barcodes enable row level security;

create policy "anon_read_not_found" on public.not_found_barcodes
  for select to anon using (true);

create policy "anon_insert_not_found" on public.not_found_barcodes
  for insert to anon with check (true);

create policy "anon_update_not_found" on public.not_found_barcodes
  for update to anon using (true);
