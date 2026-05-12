-- ============================================================
--  Club Concierge — Supabase Schema
--  Run this in your Supabase project → SQL Editor → New Query
-- ============================================================

-- Enable required extensions
create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";

-- ─── USERS ───────────────────────────────────────────────────
-- One row per Club Concierge subscriber
create table if not exists users (
  id            uuid primary key default uuid_generate_v4(),
  email         text unique not null,
  name          text,
  phone         text,                          -- for SMS notifications
  plan          text not null default 'starter'  -- 'starter' | 'member' | 'concierge'
                  check (plan in ('starter','member','concierge')),
  stripe_customer_id  text unique,
  stripe_subscription_id text,
  active        boolean not null default true,
  trial_ends_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table users is 'Club Concierge subscribers — one row per paying member';

-- ─── CREDENTIALS ─────────────────────────────────────────────
-- Encrypted portal login credentials, one row per portal per user
-- Encryption is done in the application layer (lib/encrypt.js) before insert
create table if not exists credentials (
  id             uuid primary key default uuid_generate_v4(),
  user_id        uuid not null references users(id) on delete cascade,
  portal         text not null default 'invited_clubs',
  username_enc   text not null,   -- AES-256-GCM encrypted, base64-encoded
  password_enc   text not null,   -- AES-256-GCM encrypted, base64-encoded
  iv             text not null,   -- initialization vector for decryption
  auth_tag       text not null,   -- GCM authentication tag
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, portal)
);

comment on table credentials is 'AES-256-GCM encrypted portal credentials — never stored in plaintext';

-- ─── USER_CONFIGS ─────────────────────────────────────────────
-- Per-user booking preferences — mirrors config.json but per user
create table if not exists user_configs (
  id                         uuid primary key default uuid_generate_v4(),
  user_id                    uuid not null unique references users(id) on delete cascade,

  -- Home club settings
  home_club_name             text not null default 'Laurel Springs Golf Club',
  home_club_days_in_advance  int  not null default 6,
  home_club_target_day       text not null default 'Saturday',
  home_earliest_hour         int  not null default 6,
  home_latest_hour           int  not null default 11,

  -- Access Advantage settings
  aa_enabled                 boolean not null default false,
  aa_target_day              text not null default 'Sunday',
  aa_earliest_hour           int  not null default 6,
  aa_latest_hour             int  not null default 9,
  aa_preferred_clubs         text[] default '{}',  -- empty = all clubs

  -- Booking preferences
  number_of_players          int  not null default 2 check (number_of_players between 1 and 4),
  fallback_to_earliest       boolean not null default true,
  club_tiers                 text[] default '{
    "Laurel Springs Golf Club",
    "Atlanta National Golf Club",
    "Eagle Watch Golf Club",
    "Polo Golf & Country Club",
    "Brookstone Golf & Country Club"
  }',

  -- Schedule (cron expressions)
  home_club_cron             text not null default '0 7 * * 0',  -- Sunday 7am
  aa_cron                    text not null default '0 7 * * 1',  -- Monday 7am

  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

comment on table user_configs is 'Per-user booking preferences and schedule configuration';

-- ─── PLAYERS ──────────────────────────────────────────────────
-- Guest player profiles for each user
create table if not exists players (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references users(id) on delete cascade,
  role        text not null default 'guest' check (role in ('primary','guest')),
  slot_index  int  not null default 1,   -- 1, 2, 3 — which guest slot
  first_name  text not null,
  last_name   text not null,
  phone       text,
  created_at  timestamptz not null default now(),
  unique (user_id, slot_index)
);

comment on table players is 'Guest player profiles associated with each member';

-- ─── BOOKINGS ─────────────────────────────────────────────────
-- Every confirmed booking the agent makes
create table if not exists bookings (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references users(id) on delete cascade,
  club_name       text not null,
  booking_date    date not null,
  tee_time        text not null,   -- "8:30 AM"
  tee_time_hour   int,
  num_players     int,
  booking_type    text not null default 'home_club'  -- 'home_club' | 'access_advantage'
                    check (booking_type in ('home_club','access_advantage')),
  in_preferred_window boolean default true,
  status          text not null default 'confirmed'
                    check (status in ('confirmed','cancelled','error')),
  confirmation_ref text,   -- portal confirmation number if available
  raw_response    jsonb,   -- full portal response for debugging
  created_at      timestamptz not null default now()
);

comment on table bookings is 'All bookings made by the agent — one row per confirmed tee time';

create index if not exists bookings_user_id_idx on bookings(user_id);
create index if not exists bookings_date_idx    on bookings(booking_date desc);

-- ─── BOOKING_ATTEMPTS ─────────────────────────────────────────
-- Every run of the scheduler — success or failure
create table if not exists booking_attempts (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid not null references users(id) on delete cascade,
  run_type      text not null default 'availability_check'
                  check (run_type in ('availability_check','booking')),
  attempted_at  timestamptz not null default now(),
  success       boolean not null,
  booking_id    uuid references bookings(id),   -- set if booking was made
  clubs_checked int default 0,
  slots_found   int default 0,
  error_message text,
  duration_ms   int
);

comment on table booking_attempts is 'Audit log of every scheduler run — used for reliability scoring and debugging';

create index if not exists attempts_user_id_idx on booking_attempts(user_id);
create index if not exists attempts_time_idx    on booking_attempts(attempted_at desc);

-- ─── AVAILABILITY_SNAPSHOTS ───────────────────────────────────
-- Rolling window of scraped tee time availability (last 7 days)
create table if not exists availability_snapshots (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references users(id) on delete cascade,
  club_name       text not null,
  snapshot_date   date not null,
  day_of_week     text,
  slots           jsonb not null default '[]',   -- array of {time, hour, slotsAvailable}
  total_slots     int  not null default 0,
  in_window_slots int  not null default 0,
  scraped_at      timestamptz not null default now()
);

create index if not exists snapshots_user_club_idx on availability_snapshots(user_id, club_name, snapshot_date desc);

-- Auto-delete snapshots older than 30 days
create or replace function delete_old_snapshots() returns trigger language plpgsql as $$
begin
  delete from availability_snapshots where scraped_at < now() - interval '30 days';
  return null;
end;
$$;

create or replace trigger cleanup_old_snapshots
  after insert on availability_snapshots
  execute procedure delete_old_snapshots();

-- ─── UPDATED_AT TRIGGERS ──────────────────────────────────────
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace trigger users_updated_at
  before update on users for each row execute procedure touch_updated_at();

create or replace trigger credentials_updated_at
  before update on credentials for each row execute procedure touch_updated_at();

create or replace trigger user_configs_updated_at
  before update on user_configs for each row execute procedure touch_updated_at();

-- ─── ROW LEVEL SECURITY ───────────────────────────────────────
-- Enable RLS so Supabase anon key can only see what it should
alter table users                  enable row level security;
alter table credentials            enable row level security;
alter table user_configs           enable row level security;
alter table players                enable row level security;
alter table bookings               enable row level security;
alter table booking_attempts       enable row level security;
alter table availability_snapshots enable row level security;

-- Service role (your server) can do anything — all other access is denied by default
-- Add specific policies here if you add a user-facing API or Supabase Auth

-- ─── VIEWS ────────────────────────────────────────────────────
-- Admin summary view — one row per user with latest booking
create or replace view user_summary as
  select
    u.id,
    u.email,
    u.name,
    u.plan,
    u.active,
    u.created_at as joined_at,
    c.home_club_name,
    c.number_of_players,
    c.aa_enabled,
    (
      select count(*) from bookings b where b.user_id = u.id
    ) as total_bookings,
    (
      select max(created_at) from bookings b where b.user_id = u.id
    ) as last_booking_at,
    (
      select club_name from bookings b
      where b.user_id = u.id
      order by created_at desc limit 1
    ) as last_booked_club,
    (
      select success from booking_attempts ba
      where ba.user_id = u.id
      order by attempted_at desc limit 1
    ) as last_run_success,
    (
      select error_message from booking_attempts ba
      where ba.user_id = u.id and not success
      order by attempted_at desc limit 1
    ) as last_error
  from users u
  left join user_configs c on c.user_id = u.id
  order by u.created_at desc;

comment on view user_summary is 'Admin dashboard view — all users with latest booking status';
