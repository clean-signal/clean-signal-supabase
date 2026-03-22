-- Clean Score: 0-100 cleanliness rating with breakdown
alter table public.products add column if not exists clean_score integer;
alter table public.products add column if not exists clean_score_breakdown jsonb;
