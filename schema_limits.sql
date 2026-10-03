-- Optional hardening for an existing Plate database.
-- Run in Supabase: SQL Editor > New query > paste > Run. Safe to run again.
-- (New installs get these from schema.sql.)
--
-- Size limits so a single account can't fill the database with oversized
-- rows, and sanity limits on the numbers.

alter table public.meals
  drop constraint if exists meals_name_len,
  drop constraint if exists meals_desc_len,
  drop constraint if exists meals_items_size,
  drop constraint if exists meals_numbers,
  add constraint meals_name_len   check (char_length(name) <= 200),
  add constraint meals_desc_len   check (char_length(description) <= 2000),
  add constraint meals_items_size check (pg_column_size(items) <= 65536 and jsonb_typeof(items) = 'array'),
  add constraint meals_numbers    check (kcal between 0 and 100000 and protein between 0 and 10000
                                         and carbs between 0 and 10000 and fat between 0 and 10000);

alter table public.profiles
  drop constraint if exists profiles_data_size,
  add constraint profiles_data_size check (pg_column_size(data) <= 8192 and jsonb_typeof(data) = 'object');

-- Kept from an earlier version; see the note on deletes in schema.sql.
alter table public.meals replica identity full;
