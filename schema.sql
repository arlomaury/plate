-- Plate database schema
-- Run this once in Supabase: Dashboard > SQL Editor > New query > paste > Run.

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
alter publication supabase_realtime add table public.meals;
