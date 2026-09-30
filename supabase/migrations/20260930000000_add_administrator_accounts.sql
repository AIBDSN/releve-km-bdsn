-- Administration des accès : le rôle "manager" conserve l'accès au parc,
-- tandis que ce marqueur donne accès à la gestion des comptes.
alter table public.profils
  add column if not exists est_administrateur boolean not null default false;

create or replace function public.est_administrateur()
returns boolean
language sql
stable
security definer
set search_path to public, pg_temp
as $$
  select exists (
    select 1
    from public.profils p
    where p.id = auth.uid()
      and p.actif = true
      and p.est_administrateur = true
  );
$$;

revoke all on function public.est_administrateur() from public, anon, authenticated;
grant execute on function public.est_administrateur() to authenticated;

-- Les comptes déjà connus qui doivent administrer l'application.
-- Rachid BEN DAOUD sera marqué administrateur à sa création, car son profil
-- n'existe pas encore dans la base à la date de cette migration.
update public.profils
set role = 'manager', est_administrateur = true
where (upper(trim(nom)) = 'KHALI' and lower(trim(prenom)) = 'mounir')
   or (upper(trim(nom)) = 'NHIV' and lower(trim(prenom)) = 'narith');
