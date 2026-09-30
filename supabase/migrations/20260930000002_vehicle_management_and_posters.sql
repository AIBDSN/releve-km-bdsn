-- Add vehicle administration fields and QR poster tracking.
-- Vehicles are archived by setting actif=false; they are not deleted.

alter table public.vehicules
  add column if not exists marque text,
  add column if not exists modele_court text,
  add column if not exists affichette_imprimee_le timestamp with time zone,
  add column if not exists archive_le timestamp with time zone,
  add column if not exists archive_par uuid references public.profils(id) on delete set null,
  add column if not exists motif_archivage text;

create index if not exists vehicules_actif_immatriculation_idx
  on public.vehicules(actif, immatriculation);

create index if not exists vehicules_affichette_imprimee_le_idx
  on public.vehicules(affichette_imprimee_le)
  where actif = true;

update public.vehicules
set
  marque = coalesce(nullif(marque, ''), nullif(split_part(coalesce(modele, ''), ' ', 1), '')),
  modele_court = coalesce(
    nullif(modele_court, ''),
    nullif(trim(regexp_replace(coalesce(modele, ''), '^\S+\s*', '')), ''),
    nullif(modele, '')
  )
where marque is null
   or marque = ''
   or modele_court is null
   or modele_court = '';

update public.vehicules
set
  archive_le = coalesce(archive_le, now()),
  motif_archivage = coalesce(nullif(motif_archivage, ''), 'autre')
where actif = false
  and archive_le is null;

create or replace view public.vue_parc as
select
  v.id,
  v.immatriculation,
  v.modele,
  v.site,
  v.actif,
  d.kilometrage as dernier_km,
  d.date_releve as derniere_date,
  case
    when d.date_releve is null then null::integer
    else current_date - d.date_releve
  end as jours_depuis_releve,
  v.marque,
  v.modele_court,
  v.affichette_imprimee_le,
  v.archive_le,
  v.archive_par,
  v.motif_archivage
from public.vehicules v
left join lateral (
  select r.kilometrage, r.date_releve
  from public.releves_km r
  where r.vehicule_id = v.id
  order by r.date_releve desc, r.cree_le desc
  limit 1
) d on true;

alter view public.vue_parc set (security_invoker = true);
