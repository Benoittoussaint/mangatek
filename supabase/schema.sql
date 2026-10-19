-- Mangatek : table des mangas, dans la même base Supabase que Phonotek.
-- Les comptes et la table « profiles » sont ceux de Phonotek : rien à recréer.
-- Les couvertures vont dans le stockage « covers » de Phonotek (dossier de chaque membre).
-- À coller dans Supabase > SQL Editor > New query, puis « Run ».

-- Mangas : collection et wishlist de chaque membre.
-- Le détail de chaque tome est rangé dans la colonne « data ».
create table if not exists public.mangas (
  id text primary key,
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists mangas_owner_idx on public.mangas (owner);
alter table public.mangas enable row level security;
-- Chacun voit la collection de tout le monde...
create policy "mangas visibles par les membres" on public.mangas
  for select to authenticated using (true);
-- ... mais ne modifie que la sienne.
create policy "chacun ajoute ses mangas" on public.mangas
  for insert to authenticated with check (owner = (select auth.uid()));
create policy "chacun modifie ses mangas" on public.mangas
  for update to authenticated using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
create policy "chacun supprime ses mangas" on public.mangas
  for delete to authenticated using (owner = (select auth.uid()));

-- Fonction déjà créée pour Phonotek (touch_updated_at) : on la réutilise.
create trigger mangas_touch before update on public.mangas
  for each row execute function public.touch_updated_at();
