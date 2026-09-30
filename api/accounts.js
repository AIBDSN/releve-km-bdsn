/*
 * API d'administration des comptes BDSN.
 * SUPABASE_SERVICE_ROLE_KEY ne doit exister que dans les variables Vercel :
 * elle n'est jamais envoyée au navigateur.
 */

const MAX_BULK = 80;
const EMAIL_DOMAIN = '@vlg-releve.local';
const MANAGER_EMAIL_DOMAIN = '@bdsn.vlg';
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

function send(res, status, body) {
  res.status(status).setHeader('Cache-Control', JSON_HEADERS['Cache-Control']).json(body);
}

function configuration() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const publicKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !serviceKey || !publicKey) throw new Error('Configuration serveur incomplète.');
  return { url: url.replace(/\/$/, ''), serviceKey, publicKey };
}

function cleanText(value, max = 100) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function validNni(value) {
  return /^[A-Z][0-9]{5}$/i.test(value);
}

function validPin(value) {
  return /^[0-9]{6}$/.test(value);
}

function validManagerPassword(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 72;
}

function mobileEmail(nni) {
  return String(nni || '').trim().toLowerCase() + EMAIL_DOMAIN;
}

function slug(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
}

function managerAlias(profile) {
  const prenom = slug(profile.prenom);
  const initiale = slug(profile.nom).charAt(0);
  if (!prenom || !initiale) throw new Error('Nom ou prénom manager incomplet.');
  return `${prenom}.${initiale}`;
}

function managerEmail(profile) {
  return managerAlias(profile) + MANAGER_EMAIL_DOMAIN;
}

async function supabase(url, key, path, options = {}) {
  const response = await fetch(url + path, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const message = data && (data.msg || data.message || data.error_description || data.error)
      ? (data.msg || data.message || data.error_description || data.error)
      : 'Erreur Supabase.';
    throw new Error(String(message));
  }
  return data;
}

async function currentAdministrator(req, config) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const user = await supabase(config.url, config.publicKey, '/auth/v1/user', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const profiles = await supabase(
    config.url,
    config.serviceKey,
    `/rest/v1/profils?or=(id.eq.${encodeURIComponent(user.id)},manager_auth_id.eq.${encodeURIComponent(user.id)})&select=id,prenom,nom,role,actif,est_administrateur`
  );
  const profile = profiles[0];
  return profile && profile.actif && profile.est_administrateur ? { user, profile } : null;
}

async function administratorCount(config) {
  const data = await supabase(
    config.url,
    config.serviceKey,
    '/rest/v1/profils?actif=eq.true&est_administrateur=eq.true&select=id'
  );
  return data.length;
}

function normalizeAccount(raw) {
  const nom = cleanText(raw.nom).toUpperCase();
  const prenom = cleanText(raw.prenom);
  const nni = cleanText(raw.nni, 6).toUpperCase();
  const pin = cleanText(raw.pin, 6);
  const role = raw.role === 'manager' ? 'manager' : 'technicien';
  const managerPassword = typeof raw.managerPassword === 'string' ? raw.managerPassword : '';
  return { nom, prenom, nni, pin, role, managerPassword, est_administrateur: raw.est_administrateur === true };
}

async function createAuthUser(config, email, password, metadata = {}) {
  const authResult = await supabase(config.url, config.serviceKey, '/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      app_metadata: { source: 'bdsn-releve-km', ...metadata }
    })
  });
  const id = authResult && (authResult.id || (authResult.user && authResult.user.id));
  if (!id) throw new Error('Supabase n’a pas renvoyé l’identifiant du compte créé.');
  return id;
}

async function ensureManagerAuth(config, profile, password) {
  if (!validManagerPassword(password)) {
    throw new Error('Le mot de passe manager temporaire doit contenir au moins 8 caractères.');
  }
  const email = managerEmail(profile);
  if (profile.manager_auth_id) {
    await supabase(config.url, config.serviceKey, `/auth/v1/admin/users/${encodeURIComponent(profile.manager_auth_id)}`, {
      method: 'PUT',
      body: JSON.stringify({ email, password, email_confirm: true })
    });
    await supabase(config.url, config.serviceKey, `/rest/v1/profils?id=eq.${encodeURIComponent(profile.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ manager_mdp_a_changer: true })
    });
    return { id: profile.manager_auth_id, email };
  }
  const managerAuthId = await createAuthUser(config, email, password, { access: 'manager' });
  await supabase(config.url, config.serviceKey, `/rest/v1/profils?id=eq.${encodeURIComponent(profile.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ manager_auth_id: managerAuthId, manager_mdp_a_changer: true })
  });
  return { id: managerAuthId, email };
}

async function createAccount(config, raw) {
  const account = normalizeAccount(raw);
  if (!account.nom || !account.prenom || !validNni(account.nni) || !validPin(account.pin)) {
    throw new Error('Chaque compte exige un nom, un prénom, un NNI au format A12345 et un PIN à 6 chiffres.');
  }
  if (account.est_administrateur && account.role !== 'manager') {
    throw new Error('Un administrateur doit aussi être manager.');
  }

  const duplicate = await supabase(
    config.url,
    config.serviceKey,
    `/rest/v1/profils?or=(matricule.eq.${encodeURIComponent(account.nni)},jeton.eq.${encodeURIComponent(account.nni)})&select=id&limit=1`
  );
  if (duplicate.length) throw new Error(`${account.nni} est déjà attribué à un compte.`);

  if (account.role === 'manager' && !validManagerPassword(account.managerPassword)) {
    throw new Error('Un compte manager exige un mot de passe manager temporaire d’au moins 8 caractères.');
  }

  const authUserId = await createAuthUser(config, mobileEmail(account.nni), account.pin, { access: 'mobile' });

  let managerAuthId = null;
  try {
    if (account.role === 'manager') {
      managerAuthId = await createAuthUser(config, managerEmail(account.nni), account.managerPassword, { access: 'manager' });
    }
    await supabase(config.url, config.serviceKey, '/rest/v1/profils', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        id: authUserId,
        nom: account.nom,
        prenom: account.prenom,
        matricule: account.nni,
        jeton: account.nni,
        site: 'VLG',
        role: account.role,
        actif: true,
        pin_a_changer: true,
        est_administrateur: account.est_administrateur,
        manager_auth_id: managerAuthId,
        manager_mdp_a_changer: !!managerAuthId
      })
    });
  } catch (error) {
    await supabase(config.url, config.serviceKey, `/auth/v1/admin/users/${encodeURIComponent(authUserId)}`, { method: 'DELETE' }).catch(() => {});
    if (managerAuthId) {
      await supabase(config.url, config.serviceKey, `/auth/v1/admin/users/${encodeURIComponent(managerAuthId)}`, { method: 'DELETE' }).catch(() => {});
    }
    throw error;
  }
  return { id: authUserId, ...account, actif: true, pin_a_changer: true, manager_auth_id: managerAuthId };
}

async function updateAccount(config, caller, raw) {
  const id = cleanText(raw.id, 50);
  if (!id) throw new Error('Compte introuvable.');
  const current = await supabase(config.url, config.serviceKey, `/rest/v1/profils?id=eq.${encodeURIComponent(id)}&select=id,matricule,role,actif,est_administrateur,manager_auth_id`);
  if (!current.length) throw new Error('Compte introuvable.');
  const next = {
    role: raw.role === 'manager' ? 'manager' : 'technicien',
    actif: raw.actif !== false,
    est_administrateur: raw.est_administrateur === true
  };
  if (next.est_administrateur) next.role = 'manager';
  const removesLastAdmin = current[0].est_administrateur && (!next.est_administrateur || !next.actif);
  if (removesLastAdmin && await administratorCount(config) <= 1) {
    throw new Error('Impossible de retirer le dernier administrateur actif.');
  }
  if (id === caller.user.id && (!next.est_administrateur || !next.actif)) {
    throw new Error('Vous ne pouvez pas retirer votre propre accès administrateur.');
  }
  await supabase(config.url, config.serviceKey, `/rest/v1/profils?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(next)
  });
  return next;
}

async function resetPin(config, raw) {
  const id = cleanText(raw.id, 50);
  const pin = cleanText(raw.pin, 6);
  if (!id || !validPin(pin)) throw new Error('Le nouveau PIN doit contenir 6 chiffres.');
  await supabase(config.url, config.serviceKey, `/auth/v1/admin/users/${encodeURIComponent(id)}`, {
    method: 'PUT', body: JSON.stringify({ password: pin })
  });
  await supabase(config.url, config.serviceKey, `/rest/v1/profils?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify({ pin_a_changer: true })
  });
}

async function resetManagerPassword(config, raw) {
  const id = cleanText(raw.id, 50);
  const password = typeof raw.password === 'string' ? raw.password : '';
  if (!id) throw new Error('Compte introuvable.');
  if (!validManagerPassword(password)) {
    throw new Error('Le mot de passe manager temporaire doit contenir au moins 8 caractères.');
  }
  const profiles = await supabase(
    config.url,
    config.serviceKey,
    `/rest/v1/profils?id=eq.${encodeURIComponent(id)}&select=id,prenom,nom,matricule,role,actif,manager_auth_id`
  );
  const profile = profiles[0];
  if (!profile || profile.role !== 'manager' || !profile.actif) {
    throw new Error('Le mot de passe manager concerne uniquement un manager actif.');
  }
  return ensureManagerAuth(config, profile, password);
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'POST', 'PATCH'].includes(req.method)) return send(res, 405, { error: 'Méthode non autorisée.' });
  try {
    const config = configuration();
    const caller = await currentAdministrator(req, config);
    if (!caller) return send(res, 403, { error: 'Accès réservé aux administrateurs.' });

    if (req.method === 'GET') {
      const accounts = await supabase(config.url, config.serviceKey,
        '/rest/v1/profils?select=id,nom,prenom,matricule,site,role,actif,pin_a_changer,est_administrateur,manager_auth_id,manager_mdp_a_changer&order=nom.asc,prenom.asc');
      return send(res, 200, { accounts, currentUserId: caller.user.id });
    }

    const action = req.body && req.body.action;
    if (action === 'create') return send(res, 201, { account: await createAccount(config, req.body.account || {}) });
    if (action === 'create-bulk') {
      const accounts = Array.isArray(req.body.accounts) ? req.body.accounts : [];
      if (!accounts.length || accounts.length > MAX_BULK) throw new Error(`Importez entre 1 et ${MAX_BULK} comptes.`);
      const normalized = accounts.map(normalizeAccount);
      const nnis = new Set();
      normalized.forEach(account => {
        if (!account.nom || !account.prenom || !validNni(account.nni) || !validPin(account.pin)) {
          throw new Error('Chaque compte exige un nom, un prénom, un NNI au format A12345 et un PIN à 6 chiffres.');
        }
        if (nnis.has(account.nni)) throw new Error(`Le NNI ${account.nni} est présent plusieurs fois dans cet import.`);
        nnis.add(account.nni);
      });
      const existing = await supabase(config.url, config.serviceKey, '/rest/v1/profils?select=matricule,jeton');
      const known = new Set(existing.flatMap(profile => [profile.matricule, profile.jeton]).filter(Boolean).map(value => String(value).toUpperCase()));
      const duplicate = normalized.find(account => known.has(account.nni));
      if (duplicate) throw new Error(`${duplicate.nni} est déjà attribué à un compte.`);
      const created = [];
      for (const account of normalized) created.push(await createAccount(config, account));
      return send(res, 201, { accounts: created });
    }
    if (action === 'reset-pin') { await resetPin(config, req.body); return send(res, 200, { ok: true }); }
    if (action === 'reset-manager-password') return send(res, 200, { manager: await resetManagerPassword(config, req.body) });
    if (action === 'update') return send(res, 200, { account: await updateAccount(config, caller, req.body.account || {}) });
    return send(res, 400, { error: 'Action inconnue.' });
  } catch (error) {
    return send(res, 400, { error: error instanceof Error ? error.message : 'Opération impossible.' });
  }
};
