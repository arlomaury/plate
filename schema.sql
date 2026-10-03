-- Plate database schema
-- Run this in Supabase (safe to re-run): Dashboard > SQL Editor > New query > paste > Run.

create extension if not exists "pgcrypto";

-- Per-user profile blob (height, weight, goal, etc.)
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- One row per logged meal
create table if not exists public.meals (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  ts          timestamptz not null default now(),
  name        text not null,
  description text default '',
  items       jsonb not null default '[]'::jsonb,   -- [{name, calories, protein, carbs, fat}]
  kcal        int  not null default 0,
  protein     int  not null default 0,
  carbs       int  not null default 0,
  fat         int  not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists meals_user_ts on public.meals (user_id, ts desc);

-- Size and sanity limits (see schema_limits.sql to add these to an existing database)
alter table public.meals drop constraint if exists meals_name_len;
alter table public.meals drop constraint if exists meals_desc_len;
alter table public.meals drop constraint if exists meals_items_size;
alter table public.meals drop constraint if exists meals_numbers;
alter table public.meals
  add constraint meals_name_len   check (char_length(name) <= 200),
  add constraint meals_desc_len   check (char_length(description) <= 2000),
  add constraint meals_items_size check (pg_column_size(items) <= 65536 and jsonb_typeof(items) = 'array'),
  add constraint meals_numbers    check (kcal between 0 and 100000 and protein between 0 and 10000
                                         and carbs between 0 and 10000 and fat between 0 and 10000);
alter table public.profiles drop constraint if exists profiles_data_size;
alter table public.profiles
  add constraint profiles_data_size check (pg_column_size(data) <= 8192 and jsonb_typeof(data) = 'object');

-- Row Level Security: each user can only touch their own rows
alter table public.profiles enable row level security;
alter table public.meals    enable row level security;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own meals" on public.meals;
create policy "own meals" on public.meals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Live sync across devices
-- (guarded so the whole file can be re-run safely)
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'meals') then
    alter publication supabase_realtime add table public.meals;
  end if;
end $$;
