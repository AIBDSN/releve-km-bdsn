-- Applied to production on 2026-09-10.
-- Keep unaffiliated Auth users out of fleet data and narrow RPC execution rights.

drop policy if exists vehicules_lire on public.vehicules;
create policy vehicules_lire
on public.vehicules
for select
to authenticated
using (
  (
    actif = true
    and exists (
      select 1
      from public.profils p
      where p.id = auth.uid()
        and p.actif = true
    )
  )
  or public.est_manager()
);

create or replace function public.dernier_releve(p_vehicule_id uuid)
returns table(kilometrage integer, date_releve date)
language sql
stable
security definer
set search_path to public, pg_temp
as $$
  select r.kilometrage, r.date_releve
  from public.releves_km r
  where r.vehicule_id = p_vehicule_id
    and exists (
      select 1
      from public.profils p
      where p.id = auth.uid()
        and p.actif = true
    )
  order by r.date_releve desc, r.cree_le desc
  limit 1;
$$;

create or replace function public.pin_change_effectue()
returns void
language sql
security definer
set search_path to public, pg_temp
as $$
  update public.profils
  set pin_a_changer = false
  where id = auth.uid()
    and actif = true;
$$;

create or replace function public.rechercher_collaborateur(terme text)
returns table(jeton text, affichage text, site text)
language sql
stable
security definer
set search_path to public, pg_temp
as $$
  select
    p.jeton,
    p.prenom || '_' || upper(left(p.nom, 1)) as affichage,
    p.site
  from public.profils p
  where p.actif = true
    and length(trim(coalesce(terme, ''))) >= 3
    and (
      lower(p.matricule) like lower(trim(terme)) || '%'
      or lower(p.prenom) like lower(trim(terme)) || '%'
      or lower(p.nom) like lower(trim(terme)) || '%'
    )
  order by p.prenom, p.nom
  limit 5;
$$;

revoke all on function public.dernier_releve(uuid) from public, anon, authenticated;
grant execute on function public.dernier_releve(uuid) to authenticated;

revoke all on function public.est_manager() from public, anon, authenticated;
grant execute on function public.est_manager() to authenticated;

revoke all on function public.pin_change_effectue() from public, anon, authenticated;
grant execute on function public.pin_change_effectue() to authenticated;

revoke all on function public.rechercher_collaborateur(text) from public, anon, authenticated;
grant execute on function public.rechercher_collaborateur(text) to anon, authenticated;

revoke all on function public.rls_auto_enable() from public, anon, authenticated;

alter function public.valider_date_releve() set search_path to pg_catalog, public;
