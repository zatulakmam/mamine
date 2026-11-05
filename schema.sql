-- ============================================================
-- MEMORYLANE — SUPABASE DATABASE SCHEMA
-- Jalankan query ini di Supabase SQL Editor (supabase.com)
-- ============================================================

-- 1. Tabel Albums
create table if not exists public.albums (
  id text primary key,
  uid uuid references auth.users(id) on delete cascade not null,
  name text not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 2. Tabel Photos
create table if not exists public.photos (
  id text primary key,
  uid uuid references auth.users(id) on delete cascade not null,
  name text not null,
  url text not null,
  type text default 'image',
  fav boolean default false,
  album text default '',
  size bigint default 0,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Aktifkan Row Level Security (RLS) agar tiap user hanya bisa akses datanya sendiri
alter table public.albums enable row level security;
alter table public.photos enable row level security;

-- Policies untuk Albums
create policy "Users can view own albums" 
  on public.albums for select 
  using (auth.uid() = uid);

create policy "Users can insert own albums" 
  on public.albums for insert 
  with check (auth.uid() = uid);

create policy "Users can update own albums" 
  on public.albums for update 
  using (auth.uid() = uid);

create policy "Users can delete own albums" 
  on public.albums for delete 
  using (auth.uid() = uid);

-- Policies untuk Photos
create policy "Users can view own photos" 
  on public.photos for select 
  using (auth.uid() = uid);

create policy "Users can insert own photos" 
  on public.photos for insert 
  with check (auth.uid() = uid);

create policy "Users can update own photos" 
  on public.photos for update 
  using (auth.uid() = uid);

create policy "Users can delete own photos" 
  on public.photos for delete 
  using (auth.uid() = uid);
