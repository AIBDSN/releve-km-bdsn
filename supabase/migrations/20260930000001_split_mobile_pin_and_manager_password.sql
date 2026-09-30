-- Separate the mobile PIN account from the manager/admin password account.
-- Existing profile ids remain the mobile Auth users so historical readings keep
-- their author links. Managers can additionally have a technical Auth user in
-- manager_auth_id for the dashboard and account administration.

alter table public.profils
  add column if not exists manager_auth_id uuid unique references auth.users(id) on delete set null,
  add column if not exists manager_mdp_a_changer boolean not null default false;

create index if not exists profils_manager_auth_id_idx
  on public.profils(manager_auth_id)
  where manager_auth_id is not null;

drop policy if exists profils_lire_compte_manager on public.profils;
create policy profils_lire_compte_manager
on public.profils
for select
to authenticated
using (manager_auth_id = auth.uid());

create or replace function public.est_manager()
returns boolean
language sql
stable
security definer
set search_path to public, pg_temp
as $$
  select exists (
    select 1
    from public.profils p
    where p.actif = true
      and p.role = 'manager'
      and (p.id = auth.uid() or p.manager_auth_id = auth.uid())
  );
$$;

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
    where p.actif = true
      and p.est_administrateur = true
      and (p.id = auth.uid() or p.manager_auth_id = auth.uid())
  );
$$;

create or replace function public.manager_mdp_change_effectue()
returns void
language sql
security definer
set search_path to public, pg_temp
as $$
  update public.profils
  set manager_mdp_a_changer = false
  where manager_auth_id = auth.uid()
    and actif = true
    and role = 'manager';
$$;

revoke all on function public.manager_mdp_change_effectue() from public, anon, authenticated;
grant execute on function public.manager_mdp_change_effectue() to authenticated;

revoke all on function public.est_manager() from public, anon, authenticated;
grant execute on function public.est_manager() to authenticated;

revoke all on function public.est_administrateur() from public, anon, authenticated;
grant execute on function public.est_administrateur() to authenticated;
