-- =====================================================================
-- LC Deals — estrutura do banco (rode TUDO de uma vez no SQL Editor)
-- Apaga a tabela antiga "deals" (que estava com lixo/duplicatas) e recria.
-- =====================================================================

drop table if exists public.deals cascade;
drop table if exists public.price_history cascade;
drop table if exists public.sync_runs cascade;

-- Uma linha = um jogo numa loja (ex: "steam:1145360", "xbox:9NBLGGH4R315")
create table public.deals (
  id              text primary key,
  game_key        text not null,               -- título normalizado: junta o mesmo jogo de lojas diferentes
  title           text not null,
  source          text not null,               -- qual coletor trouxe a linha (itad, xbox, nintendo...) — usado na limpeza
  store           text not null,               -- steam | epic | nuuvem | humble | nintendo | xbox | playstation | instant_gaming
  platform        text not null,               -- pc | switch | xbox | ps | giftcard
  category        text not null,               -- game_deal | free_game | free_upcoming | gift_card | bundle | dlc
  original_price  numeric(10,2),
  discount_price  numeric(10,2),
  discount_pct    int default 0,
  currency        text default 'BRL',
  history_low     numeric(10,2),               -- menor preço histórico vindo da fonte (ITAD), quando existir
  own_low         numeric(10,2),               -- menor preço que o NOSSO robô já viu (preenchido pelo gatilho)
  is_lowest_ever  boolean default false,       -- calculado pelo gatilho
  image_url       text,
  deal_url        text not null,
  expires_at      timestamptz,
  first_seen_at   timestamptz default now(),
  last_seen_at    timestamptz default now(),
  updated_at      timestamptz default now()
);

create index deals_store_idx     on public.deals(store);
create index deals_platform_idx  on public.deals(platform);
create index deals_category_idx  on public.deals(category);
create index deals_game_key_idx  on public.deals(game_key);

-- Histórico de preços (só grava quando o preço MUDA) — é isso que gera o "menor preço histórico" dos consoles
create table public.price_history (
  id          bigserial primary key,
  deal_id     text not null,
  price       numeric(10,2) not null,
  recorded_at timestamptz default now()
);
create index price_history_deal_idx on public.price_history(deal_id, recorded_at);

-- Resultado de cada loja em cada execução (o site mostra isso na barra de status)
create table public.sync_runs (
  source   text primary key,
  ok       boolean not null,
  count    int not null default 0,
  message  text,
  ran_at   timestamptz default now()
);

-- Gatilho: mantém own_low, histórico e a flag de menor preço
create or replace function public.deals_before_write() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();

  if tg_op = 'INSERT' then
    new.own_low := new.discount_price;
    insert into public.price_history(deal_id, price) values (new.id, new.discount_price);
  else
    new.first_seen_at := old.first_seen_at;
    new.own_low := least(coalesce(old.own_low, new.discount_price), new.discount_price);
    if new.discount_price is distinct from old.discount_price then
      insert into public.price_history(deal_id, price) values (new.id, new.discount_price);
    end if;
  end if;

  if new.history_low is not null then
    -- Fonte com histórico de verdade (PC via IsThereAnyDeal)
    new.is_lowest_ever := new.discount_price <= new.history_low;
  elsif tg_op = 'UPDATE' and old.first_seen_at < now() - interval '7 days' then
    -- Consoles: só confia no próprio histórico depois de 7 dias acompanhando
    new.is_lowest_ever := new.discount_price <= coalesce(old.own_low, new.discount_price);
  else
    new.is_lowest_ever := false;
  end if;

  return new;
end $$;

create trigger deals_before_write
before insert or update on public.deals
for each row execute function public.deals_before_write();

-- Segurança: o site (chave anon) só LÊ. Quem escreve é o robô com a service_role.
alter table public.deals enable row level security;
alter table public.price_history enable row level security;
alter table public.sync_runs enable row level security;

create policy "leitura publica deals"   on public.deals         for select using (true);
create policy "leitura publica history" on public.price_history for select using (true);
create policy "leitura publica runs"    on public.sync_runs     for select using (true);
