-- Optional hardening for an existing Plate database.
-- Run once in Supabase: SQL Editor > New query > paste > Run.
-- (New installs get these from schema.sql.)
--
-- Size limits so a single account can't fill the database with oversized
-- rows, and sanity limits on the numbers.

alter table public.meals
  add constraint meals_name_len   check (char_length(name) <= 200),
  add constraint meals_desc_len   check (char_length(description) <= 2000),
  add constraint meals_items_size check (pg_column_size(items) <= 65536 and jsonb_typeof(items) = 'array'),
  add constraint meals_numbers    check (kcal between 0 and 100000 and protein between 0 and 10000
                                         and carbs between 0 and 10000 and fat between 0 and 10000);

alter table public.profiles
  add constraint profiles_data_size check (pg_column_size(data) <= 8192 and jsonb_typeof(data) = 'object');

-- Live sync of deletes across devices (see schema.sql).
alter table public.meals replica identity full;
