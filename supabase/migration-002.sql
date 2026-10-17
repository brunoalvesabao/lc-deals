-- LC Deals — notas (Metascore) e "mais procurados". Rode uma vez no SQL Editor do Supabase.
create table if not exists public.game_meta (
  game_key        text primary key,     -- mesmo nome normalizado usado nas ofertas
  itad_id         text,
  title           text,
  metascore       int,
  steam_score     int,
  waitlisted      int,                  -- quantas pessoas têm o jogo na wishlist do IsThereAnyDeal
  meta_fetched_at timestamptz,
  updated_at      timestamptz default now()
);
create index if not exists game_meta_itad_idx on public.game_meta(itad_id);
alter table public.game_meta enable row level security;
drop policy if exists "leitura publica meta" on public.game_meta;
create policy "leitura publica meta" on public.game_meta for select using (true);
