-- Simple Voice Room - Supabase schema
create extension if not exists pgcrypto;

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.access_keys (
  id uuid primary key default gen_random_uuid(),
  key_hash text not null unique,
  room_id uuid not null references public.rooms(id) on delete restrict,
  used_by uuid references auth.users(id) on delete set null,
  used_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  constraint access_key_usage_check check ((used_by is null and used_at is null) or (used_by is not null and used_at is not null))
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (char_length(username) between 3 and 24),
  room_id uuid not null references public.rooms(id) on delete restrict,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists access_keys_room_idx on public.access_keys(room_id);
create index if not exists profiles_room_idx on public.profiles(room_id);

alter table public.rooms enable row level security;
alter table public.access_keys enable row level security;
alter table public.profiles enable row level security;

-- Authenticated users can only see their own room and the profiles inside it.
create policy "users can read own room" on public.rooms for select to authenticated
using (id = (select room_id from public.profiles where id = auth.uid()));

create policy "users can read profiles in own room" on public.profiles for select to authenticated
using (room_id = (select room_id from public.profiles where id = auth.uid()));

-- A user may not directly insert/update/delete profiles. The claim function does it securely.
-- Access keys are intentionally inaccessible directly; RPCs below are the API surface.

create or replace function public.validate_access_key(p_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_hash text; v_room uuid; v_valid boolean;
begin
  v_hash := encode(digest(p_key, 'sha256'), 'hex');
  select room_id into v_room from public.access_keys
   where key_hash = v_hash and used_by is null
   and (expires_at is null or expires_at > now())
   limit 1;
  v_valid := v_room is not null;
  return jsonb_build_object('valid', v_valid, 'room_id', v_room);
end;
$$;

create or replace function public.claim_access_key(p_key text, p_user_id uuid, p_username text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_hash text; v_room uuid; v_count integer;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'Não autorizado';
  end if;
  if p_username !~ '^[A-Za-z0-9_.-]{3,24}$' then
    raise exception 'Nome de usuário inválido';
  end if;
  v_hash := encode(digest(p_key, 'sha256'), 'hex');
  select room_id into v_room from public.access_keys
   where key_hash = v_hash and used_by is null
   and (expires_at is null or expires_at > now())
   for update;
  if v_room is null then raise exception 'Key inválida, expirada ou já utilizada'; end if;

  if exists(select 1 from public.profiles where id=p_user_id) then
    raise exception 'Usuário já possui perfil';
  end if;
  if exists(select 1 from public.profiles where username=p_username) then
    raise exception 'Nome de usuário já existe';
  end if;

  insert into public.profiles(id,username,room_id) values(p_user_id,p_username,v_room);
  update public.access_keys set used_by=p_user_id, used_at=now() where key_hash=v_hash;
  get diagnostics v_count = row_count;
  return jsonb_build_object('success', true, 'room_id', v_room);
end;
$$;

revoke all on function public.validate_access_key(text) from public;
grant execute on function public.validate_access_key(text) to anon, authenticated;
revoke all on function public.claim_access_key(text,uuid,text) from public;
grant execute on function public.claim_access_key(text,uuid,text) to authenticated;

-- Helper for initial setup. Run manually in SQL editor to create the first room.
-- insert into public.rooms(name) values ('Sala 1');
-- Then create a key hash. Example using pgcrypto directly:
-- insert into public.access_keys(key_hash, room_id) values
-- (encode(digest('COLOQUE_UMA_KEY_LONGA_AQUI', 'sha256'), 'hex'), 'ROOM_UUID_AQUI');

-- Admins can be promoted manually:
-- update public.profiles set is_admin = true where username = 'nome';
