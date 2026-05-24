-- =============================================================================
-- profiles — one row per Supabase auth user
--
-- Holds the Stripe + access-state fields the Next.js dashboard + Stripe
-- webhook need. Real "API tier" lives on the FastAPI Postgres side
-- (subscriptions table); this table is just the front-end mirror.
--
-- Run this once in the Supabase SQL Editor (Dashboard → SQL Editor →
-- New query → paste → Run). Idempotent — safe to re-run.
-- =============================================================================

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  -- PK = the Supabase auth user id. Cascade delete on user removal.
  id          uuid primary key references auth.users(id) on delete cascade,

  -- Mirrored from auth.users.email on signup (handy for filtering /
  -- joining without a fk hop). Kept in sync by the trigger below.
  email       text,

  -- Stripe customer + the currently-active priceId. The Stripe webhook
  -- writes both, the dashboard reads them to render billing state.
  customer_id text,
  price_id    text,

  -- Toggle the webhook flips on checkout.session.completed / invoice.paid
  -- and back off on customer.subscription.deleted. The dashboard layout
  -- could optionally check this to gate features (currently it just
  -- checks auth; we use the FastAPI tier for real gating).
  has_access  boolean not null default false,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- updated_at auto-bump
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Auto-create profile row on new auth.users signup
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row-Level Security
--
-- The service-role key (used by the Stripe webhook + dashboard server
-- routes) bypasses RLS — so this policy mostly protects against direct
-- browser writes if anyone ever tries that path.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;

-- Users can SELECT their own row (so dashboard server components can read it).
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

-- Users can UPDATE their own row, but only the email (NOT has_access /
-- customer_id / price_id — those are webhook-controlled). The cheap way
-- to enforce that is to NOT add an update policy at all: users can
-- update zero columns. Stripe webhook writes via service_role anyway.
-- (If you ever want users to edit their own email/name, add a policy here.)

-- ---------------------------------------------------------------------------
-- Helpful indexes
-- ---------------------------------------------------------------------------
create index if not exists profiles_email_idx       on public.profiles (email);
create index if not exists profiles_customer_id_idx on public.profiles (customer_id);

-- ---------------------------------------------------------------------------
-- Sanity check
-- ---------------------------------------------------------------------------
-- After running this script, sign up via the dashboard and verify:
--   select id, email, has_access, customer_id from public.profiles;
-- A row should appear automatically from the on_auth_user_created trigger.
