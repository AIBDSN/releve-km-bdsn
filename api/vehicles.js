/*
 * API d'administration du parc véhicules BDSN.
 * Les mutations passent par la clé service_role côté serveur uniquement.
 */

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

function cleanText(value, max = 120) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizePlate(value) {
  const raw = cleanText(value, 20).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^[A-Z]{2}[0-9]{3}[A-Z]{2}$/.test(raw)) {
    return `${raw.slice(0, 2)}-${raw.slice(2, 5)}-${raw.slice(5)}`;
  }
  return cleanText(value, 20).toUpperCase();
}

function validPlate(value) {
  return /^[A-Z]{2}-[0-9]{3}-[A-Z]{2}$/.test(value);
}

function modelLabel(marque, modeleCourt) {
  return [marque, modeleCourt].filter(Boolean).join(' ').trim();
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
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

async function currentManager(req, config) {
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
  return profile && profile.actif && profile.role === 'manager' ? { user, profile } : null;
}

function requireAdministrator(caller) {
  if (!caller || !caller.profile.est_administrateur) {
    throw new Error('Action réservée aux administrateurs.');
  }
}

async function listVehicles(config) {
  const vehicles = await supabase(
    config.url,
    config.serviceKey,
    '/rest/v1/vehicules?select=id,immatriculation,modele,marque,modele_court,site,actif,cree_le,affichette_imprimee_le,archive_le,motif_archivage&order=immatriculation.asc'
  );
  return vehicles;
}

async function createVehicle(config, caller, raw) {
  requireAdministrator(caller);
  const immatriculation = normalizePlate(raw.immatriculation);
  const marque = cleanText(raw.marque, 60).toUpperCase();
  const modeleCourt = cleanText(raw.modele_court || raw.modeleCourt, 80);
  const site = cleanText(raw.site, 20).toUpperCase() || 'VLG';
  const kmInitial = raw.kilometrage_initial === '' || raw.kilometrage_initial == null
    ? null
    : Number.parseInt(String(raw.kilometrage_initial).replace(/\D/g, ''), 10);

  if (!validPlate(immatriculation)) throw new Error('Immatriculation attendue au format AA-123-AA.');
  if (!marque || !modeleCourt) throw new Error('Indiquez au minimum la marque et le modèle.');
  if (kmInitial !== null && (!Number.isFinite(kmInitial) || kmInitial < 0)) {
    throw new Error('Le kilométrage initial doit être un nombre positif.');
  }

  const duplicate = await supabase(
    config.url,
    config.serviceKey,
    `/rest/v1/vehicules?immatriculation=eq.${encodeURIComponent(immatriculation)}&select=id&limit=1`
  );
  if (duplicate.length) throw new Error(`${immatriculation} existe déjà dans le parc.`);

  const inserted = await supabase(config.url, config.serviceKey, '/rest/v1/vehicules', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      immatriculation,
      marque,
      modele_court: modeleCourt,
      modele: modelLabel(marque, modeleCourt),
      site,
      actif: true
    })
  });

  const vehicle = inserted[0];
  if (vehicle && kmInitial !== null) {
    await supabase(config.url, config.serviceKey, '/rest/v1/releves_km', {
      method: 'POST',
      body: JSON.stringify({
        vehicule_id: vehicle.id,
        auteur_id: caller.profile.id,
        date_releve: todayIso(),
        kilometrage: kmInitial,
        alerte_confirmee: false
      })
    });
  }
  return vehicle;
}

async function updateVehicle(config, caller, raw) {
  requireAdministrator(caller);
  const id = cleanText(raw.id, 80);
  if (!id) throw new Error('Véhicule introuvable.');

  const patch = {};
  if ('marque' in raw) patch.marque = cleanText(raw.marque, 60).toUpperCase();
  if ('modele_court' in raw || 'modeleCourt' in raw) patch.modele_court = cleanText(raw.modele_court || raw.modeleCourt, 80);
  if ('site' in raw) patch.site = cleanText(raw.site, 20).toUpperCase() || 'VLG';
  if (patch.marque || patch.modele_court) {
    const current = await supabase(config.url, config.serviceKey, `/rest/v1/vehicules?id=eq.${encodeURIComponent(id)}&select=marque,modele_court`);
    const base = current[0] || {};
    patch.modele = modelLabel(patch.marque || base.marque, patch.modele_court || base.modele_court);
  }
  await supabase(config.url, config.serviceKey, `/rest/v1/vehicules?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  });
  return { id, ...patch };
}

async function archiveVehicle(config, caller, raw) {
  requireAdministrator(caller);
  const id = cleanText(raw.id, 80);
  const motif = cleanText(raw.motif || raw.motif_archivage || 'autre', 80) || 'autre';
  if (!id) throw new Error('Véhicule introuvable.');
  await supabase(config.url, config.serviceKey, `/rest/v1/vehicules?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      actif: false,
      archive_le: new Date().toISOString(),
      archive_par: caller.profile.id,
      motif_archivage: motif
    })
  });
  return { id };
}

async function reactivateVehicle(config, caller, raw) {
  requireAdministrator(caller);
  const id = cleanText(raw.id, 80);
  if (!id) throw new Error('Véhicule introuvable.');
  await supabase(config.url, config.serviceKey, `/rest/v1/vehicules?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ actif: true, archive_le: null, archive_par: null, motif_archivage: null })
  });
  return { id };
}

async function markPosters(config, caller, raw) {
  requireAdministrator(caller);
  const ids = Array.isArray(raw.ids) ? raw.ids.map(id => cleanText(id, 80)).filter(Boolean).slice(0, 120) : [];
  if (!ids.length) throw new Error('Aucun véhicule sélectionné.');
  const filter = ids.map(id => encodeURIComponent(id)).join(',');
  await supabase(config.url, config.serviceKey, `/rest/v1/vehicules?id=in.(${filter})`, {
    method: 'PATCH',
    body: JSON.stringify({ affichette_imprimee_le: new Date().toISOString() })
  });
  return { ids };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'POST', 'PATCH'].includes(req.method)) return send(res, 405, { error: 'Méthode non autorisée.' });
  try {
    const config = configuration();
    const caller = await currentManager(req, config);
    if (!caller) return send(res, 403, { error: 'Accès réservé aux managers.' });

    if (req.method === 'GET') {
      return send(res, 200, {
        vehicles: await listVehicles(config),
        administrator: !!caller.profile.est_administrateur
      });
    }

    const action = req.body && req.body.action;
    if (action === 'create') return send(res, 201, { vehicle: await createVehicle(config, caller, req.body.vehicle || {}) });
    if (action === 'update') return send(res, 200, { vehicle: await updateVehicle(config, caller, req.body.vehicle || {}) });
    if (action === 'archive') return send(res, 200, { vehicle: await archiveVehicle(config, caller, req.body) });
    if (action === 'reactivate') return send(res, 200, { vehicle: await reactivateVehicle(config, caller, req.body) });
    if (action === 'mark-posters') return send(res, 200, await markPosters(config, caller, req.body));
    return send(res, 400, { error: 'Action inconnue.' });
  } catch (error) {
    return send(res, 400, { error: error instanceof Error ? error.message : 'Opération impossible.' });
  }
};
