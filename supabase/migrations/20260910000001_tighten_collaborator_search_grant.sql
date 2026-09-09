-- Collaborator lookup is only needed before authentication.
revoke execute on function public.rechercher_collaborateur(text) from authenticated;
