# Relevé kilométrique BDSN

Application web statique pour collecter les relevés kilométriques mensuels des véhicules de l'agence Boucles de Seine Nord.

## Pages

- `index.html` : saisie terrain pour les techniciens.
- `manager.html` : pilotage manager, suivi des véhicules et export CSV pour Excel.
- `accounts.html` : gestion des comptes, réservée aux administrateurs.

## Sécurité

Les deux pages utilisent une clé publique Supabase côté navigateur. C'est normal pour une application statique, mais la sécurité dépend des règles Supabase :

- activer et vérifier les politiques RLS sur `profils`, `vehicules`, `releves_km` et `vue_parc` ;
- limiter la lecture manager aux comptes ayant `role = manager` ;
- limiter l'insertion de relevés à l'utilisateur connecté, avec `auteur_id = auth.uid()` ;
- bloquer les dates futures et les dates trop anciennes côté base, pas seulement côté interface ;
- conserver une protection anti-bruteforce/rate limit sur l'authentification, car les techniciens utilisent un PIN à 6 chiffres ;
- éviter toute donnée libre non maîtrisée dans les champs affichés publiquement.

Dans Supabase Auth, désactiver l'inscription publique et activer la protection contre les mots de passe compromis. Ces deux réglages ne sont pas stockés dans les migrations SQL : ils se configurent dans le tableau de bord Supabase et doivent rester activés.

## Gestion des comptes

La gestion des comptes passe par `/api/accounts`, une fonction Vercel qui vérifie le
jeton Supabase de l'appelant et son indicateur `est_administrateur`. La page navigateur
ne reçoit jamais la clé de service Supabase.

Les accès sont volontairement séparés :

- compte mobile : `NNI@vlg-releve.local`, PIN à 6 chiffres, utilisé pour la saisie terrain ;
- compte manager : `prenom.initiale@bdsn.vlg`, mot de passe d'au moins 8 caractères,
  utilisé pour le parc, l'export et l'administration.

Le bouton `Nouveau PIN mobile` ne change que le PIN terrain. Le bouton
`Nouveau mot de passe manager` crée ou réinitialise le compte manager technique et force
le changement du mot de passe à la prochaine connexion manager.

Avant la mise en ligne, appliquer la migration
`20260930000000_add_administrator_accounts.sql`, puis
`20260930000001_split_mobile_pin_and_manager_password.sql`. Renseigner les variables
Vercel `SUPABASE_URL`, `SUPABASE_ANON_KEY` et `SUPABASE_SERVICE_ROLE_KEY` (production
uniquement). Le fichier `.env.example` sert uniquement de modèle : aucune valeur secrète
ne doit être commitée.

Les pages empêchent l'indexation, ne transmettent pas de referrer, échappent les données affichées dans l'interface, et l'export CSV neutralise les valeurs pouvant être interprétées comme formules par Excel.
