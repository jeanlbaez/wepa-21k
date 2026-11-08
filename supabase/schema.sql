-- ===========================================================================
-- Wepa 21K — esquema de Supabase
-- ===========================================================================
-- Cómo correrlo:
--   Supabase → tu proyecto → SQL Editor → New query → pega todo esto → Run
--
-- Qué crea:
--   · 3 tablas (runners, reactions, meta) con forma id + data jsonb
--   · realtime en las 3, para que el tablero se actualice solo
--   · un bucket público "photos" para el álbum
--   · RLS abierto al rol `anon` (o sea: cualquiera con el enlace)
--
-- NO hace falta activar el login anónimo de Supabase. La app no abre sesión:
-- usa la anon key sola, que corresponde al rol `anon`, y las policies de
-- abajo le dan permiso a ese rol. La identidad por persona la guarda el
-- propio teléfono en localStorage.
--
-- OJO con el modelo de seguridad: en GitHub Pages no hay invitados ni dueño,
-- así que cualquiera que tenga el enlace puede escribir y borrar. Para un
-- grupo de corredores está bien. Si el enlace se hace público de verdad,
-- conviene cerrar esto (ver el bloque comentado al final).
-- ===========================================================================

-- --- tablas ----------------------------------------------------------------
create table if not exists public.runners (
  id         text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.reactions (
  id         text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.meta (
  id         text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- --- mantener updated_at ---------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists t_runners_touch on public.runners;
create trigger t_runners_touch before update on public.runners
  for each row execute function public.touch_updated_at();

drop trigger if exists t_reactions_touch on public.reactions;
create trigger t_reactions_touch before update on public.reactions
  for each row execute function public.touch_updated_at();

drop trigger if exists t_meta_touch on public.meta;
create trigger t_meta_touch before update on public.meta
  for each row execute function public.touch_updated_at();

-- --- realtime --------------------------------------------------------------
-- Necesario para que onSnapshot reciba los cambios de los demás.
alter publication supabase_realtime add table public.runners;
alter publication supabase_realtime add table public.reactions;
alter publication supabase_realtime add table public.meta;

-- Sin esto, un DELETE viaja solo con la llave primaria y, con RLS activo,
-- el evento se puede perder: alguien borra un corredor o quita un ¡Wepa! y
-- a los demás no se les actualiza la pantalla hasta recargar.
alter table public.runners   replica identity full;
alter table public.reactions replica identity full;
alter table public.meta      replica identity full;

-- Si alguna de las tres líneas de arriba da error porque ya estaba añadida,
-- no pasa nada: seguí con el resto.

-- --- RLS -------------------------------------------------------------------
alter table public.runners   enable row level security;
alter table public.reactions enable row level security;
alter table public.meta      enable row level security;

-- Lectura y escritura para cualquier sesión (incluida la anónima).
do $$
declare t text;
begin
  for t in select unnest(array['runners','reactions','meta']) loop
    execute format('drop policy if exists p_read  on public.%I', t);
    execute format('drop policy if exists p_write on public.%I', t);
    execute format(
      'create policy p_read on public.%I for select using (true)', t);
    execute format(
      'create policy p_write on public.%I for all to anon, authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- --- storage: bucket de fotos ---------------------------------------------
insert into storage.buckets (id, name, public)
values ('photos', 'photos', true)
on conflict (id) do update set public = true;

drop policy if exists photos_read   on storage.objects;
drop policy if exists photos_write  on storage.objects;
drop policy if exists photos_delete on storage.objects;

create policy photos_read on storage.objects
  for select using (bucket_id = 'photos');

create policy photos_write on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'photos');

create policy photos_delete on storage.objects
  for delete to anon, authenticated
  using (bucket_id = 'photos');

-- ===========================================================================
-- OPCIONAL — cerrar la escritura con una clave de grupo
-- ===========================================================================
-- Si querés que solo quien sepa una clave pueda escribir, lo más simple es
-- dejar p_read abierto y reemplazar p_write por algo así, mandando la clave
-- en el header de la petición:
--
--   create policy p_write on public.runners for all to anon, authenticated
--     using (current_setting('request.headers', true)::json->>'x-wepa-key'
--            = 'LA-CLAVE-DEL-GRUPO')
--     with check (current_setting('request.headers', true)::json->>'x-wepa-key'
--            = 'LA-CLAVE-DEL-GRUPO');
--
-- Y en js/claude-supabase-shim.js, pasarle a createClient:
--   { global: { headers: { 'x-wepa-key': 'LA-CLAVE-DEL-GRUPO' } } }
--
-- Eso NO es seguridad fuerte (la clave viaja en el navegador), pero evita
-- que un desconocido que tropiece con el enlace borre el tablero.
-- ===========================================================================
