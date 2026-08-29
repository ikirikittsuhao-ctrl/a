create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null check (char_length(username) between 3 and 32),
  display_name text not null default 'User' check (char_length(display_name) between 1 and 50),
  avatar_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  friend_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'accepted' check (status in ('pending','accepted','blocked')),
  created_at timestamptz not null default now(),
  unique(user_id, friend_id),
  check(user_id <> friend_id)
);

create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('direct','group')),
  name text,
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  check ((type='group') or name is null)
);

create table if not exists public.chat_members (
  chat_id uuid not null references public.chats(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member')),
  joined_at timestamptz not null default now(),
  primary key(chat_id,user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

create table if not exists public.qr_tokens (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  token_hash text unique not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists messages_chat_created_idx on public.messages(chat_id, created_at);
create index if not exists members_user_idx on public.chat_members(user_id);
create index if not exists friendships_user_idx on public.friendships(user_id);

alter table public.profiles enable row level security;
alter table public.friendships enable row level security;
alter table public.chats enable row level security;
alter table public.chat_members enable row level security;
alter table public.messages enable row level security;
alter table public.qr_tokens enable row level security;

-- Node.js server uses the service role after validating the user's JWT.
-- This policy set prevents anonymous/direct client access if the anon key is ever exposed.
create policy "profiles self read" on public.profiles for select using (auth.uid() = id);
create policy "profiles self update" on public.profiles for update using (auth.uid() = id);
create policy "friendships self" on public.friendships for all using (auth.uid() = user_id or auth.uid() = friend_id);
create policy "members self read" on public.chat_members for select using (auth.uid() = user_id);
create policy "messages member read" on public.messages for select using (
  exists(select 1 from public.chat_members m where m.chat_id = messages.chat_id and m.user_id = auth.uid())
);
create policy "messages sender insert" on public.messages for insert with check (auth.uid() = sender_id);
create policy "chats member read" on public.chats for select using (
  exists(select 1 from public.chat_members m where m.chat_id = chats.id and m.user_id = auth.uid())
);

create or replace function public.create_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles(id, username, display_name)
  values (
    new.id,
    coalesce(lower(split_part(new.email,'@',1)) || '_' || substr(new.id::text,1,6), 'user_' || substr(new.id::text,1,8)),
    coalesce(new.raw_user_meta_data->>'display_name','User')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.create_profile();
