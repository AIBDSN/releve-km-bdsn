# Relevé kilométrique BDSN

Application web statique pour collecter les relevés kilométriques mensuels des véhicules de l'agence Boucles de Seine Nord.

## Pages

- `index.html` : saisie terrain pour les techniciens.
- `manager.html` : pilotage manager, suivi des véhicules et export CSV pour Excel.

## Sécurité

Les deux pages utilisent une clé publique Supabase côté navigateur. C'est normal pour une application statique, mais la sécurité dépend des règles Supabase :

- activer et vérifier les politiques RLS sur `profils`, `vehicules`, `releves_km` et `vue_parc` ;
- limiter la lecture manager aux comptes ayant `role = manager` ;
- limiter l'insertion de relevés à l'utilisateur connecté, avec `auteur_id = auth.uid()` ;
- bloquer les dates futures et les dates trop anciennes côté base, pas seulement côté interface ;
- conserver une protection anti-bruteforce/rate limit sur l'authentification, car les techniciens utilisent un PIN à 6 chiffres ;
- éviter toute donnée libre non maîtrisée dans les champs affichés publiquement.

Les pages empêchent l'indexation, ne transmettent pas de referrer, échappent les données affichées dans l'interface, et l'export CSV neutralise les valeurs pouvant être interprétées comme formules par Excel.
