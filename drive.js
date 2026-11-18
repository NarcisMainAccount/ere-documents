// Google Drive storage: sign-in (Google Identity Services) and the few Drive calls the app needs.
// Uses the drive.file scope, so the app can only see files it created itself.
'use strict';

window.Drive = (() => {
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const ROOT_NAME = 'ERE Documents';
  const FOLDER = 'application/vnd.google-apps.folder';
  const LS_TOKEN = 'ere.driveToken', LS_IDS = 'ere.driveIds';

  const clientId = (window.ERE_CONFIG || {}).googleClientId || '';
  let tokenClient = null, waiting = null;

  const read = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };
  let tok = read(LS_TOKEN) || {};
  let ids = read(LS_IDS) || {};

  class AuthError extends Error {}

  const enabled = () => !!clientId;
  const hasToken = () => !!tok.access && Date.now() < tok.expires - 60000;
  const wasConnected = () => !!tok.granted;

  function ready() {
    if (tokenClient) return true;
    if (!enabled() || !window.google?.accounts?.oauth2) return false;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: r => {
        const w = waiting; waiting = null;
        if (r.error) return w?.reject(new Error(r.error_description || r.error));
        tok = { access: r.access_token, expires: Date.now() + r.expires_in * 1000, granted: true };
        write(LS_TOKEN, tok);
        w?.resolve(tok.access);
      },
      error_callback: e => {
        const w = waiting; waiting = null;
        w?.reject(new Error(e.type === 'popup_closed' ? 'Google sign-in was closed before finishing.' : `Google sign-in failed (${e.type}).`));
      }
    });
    return true;
  }

  // Call this straight from a tap/click: browsers block the Google popup otherwise.
  function signIn() {
    if (hasToken()) return Promise.resolve(tok.access);
    if (!ready()) return Promise.reject(new Error('Google sign-in is not available right now. Check your internet connection.'));
    return new Promise((resolve, reject) => {
      waiting = { resolve, reject };
      tokenClient.requestAccessToken({ prompt: tok.granted ? '' : 'consent' });
    });
  }

  function signOut() {
    if (tok.access && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(tok.access, () => {});
    tok = {}; ids = {};
    write(LS_TOKEN, tok); write(LS_IDS, ids);
  }

  async function call(url, opts = {}) {
    if (!hasToken()) throw new AuthError('Not signed in to Google Drive.');
    const res = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + tok.access, ...(opts.headers || {}) } });
    if (res.status === 401) { tok.access = null; write(LS_TOKEN, tok); throw new AuthError('Google sign-in has expired.'); }
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).error.message; } catch { /* keep status text */ }
      const err = new Error('Google Drive: ' + msg); err.status = res.status; throw err;
    }
    return res;
  }

  const quote = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  async function find(name, parent, mime) {
    const query = [`name='${quote(name)}'`, 'trashed=false', `'${parent || 'root'}' in parents`, mime && `mimeType='${mime}'`]
      .filter(Boolean).join(' and ');
    const r = await (await call(`${API}/files?q=${encodeURIComponent(query)}&fields=files(id)&orderBy=createdTime&pageSize=1`)).json();
    return r.files[0]?.id || null;
  }
  async function createFolder(name, parent) {
    const r = await call(`${API}/files?fields=id`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}) })
    });
    return (await r.json()).id;
  }
  async function folders() {
    if (ids.root && ids.Invoices && ids.Salaries) return ids;
    const root = await find(ROOT_NAME, null, FOLDER) || await createFolder(ROOT_NAME);
    const sub = async n => await find(n, root, FOLDER) || await createFolder(n, root);
    ids = { root, Invoices: await sub('Invoices'), Salaries: await sub('Salaries'), data: null };
    write(LS_IDS, ids);
    return ids;
  }
  // Cached folder/file ids go stale if something was deleted in Drive: forget them and retry once.
  async function withIds(fn) {
    try { return await fn(); } catch (e) {
      if (e.status !== 404) throw e;
      ids = {}; write(LS_IDS, ids);
      return fn();
    }
  }

  function multipart(meta, blob) {
    const b = 'ere' + Math.random().toString(36).slice(2);
    return {
      type: `multipart/related; boundary=${b}`,
      body: new Blob([
        `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
        `--${b}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`, blob, `\r\n--${b}--`
      ])
    };
  }

  async function dataFileId() {
    if (ids.data) return ids.data;
    const f = await folders();
    ids.data = await find('data.json', f.root);
    write(LS_IDS, ids);
    return ids.data;
  }

  // Version number of data.json in Drive (goes up on every change), or null if it doesn't exist yet.
  const getVersion = () => withIds(async () => {
    const id = await dataFileId(); if (!id) return null;
    return (await (await call(`${API}/files/${id}?fields=version`)).json()).version;
  });

  const readData = () => withIds(async () => {
    const id = await dataFileId(); if (!id) return null;
    const version = (await (await call(`${API}/files/${id}?fields=version`)).json()).version;
    const data = await (await call(`${API}/files/${id}?alt=media`)).json();
    return { data, version };
  });

  // Saves data.json and returns its new version.
  const writeData = json => withIds(async () => {
    const id = await dataFileId();
    const blob = new Blob([json], { type: 'application/json' });
    if (id) {
      const r = await call(`${UPLOAD}/files/${id}?uploadType=media&fields=version`, { method: 'PATCH', body: blob });
      return (await r.json()).version;
    }
    const m = multipart({ name: 'data.json', parents: [ids.root] }, blob);
    const r = await (await call(`${UPLOAD}/files?uploadType=multipart&fields=id,version`, { method: 'POST', headers: { 'Content-Type': m.type }, body: m.body })).json();
    ids.data = r.id; write(LS_IDS, ids);
    return r.version;
  });

  // Uploads a document into the Invoices or Salaries folder.
  const upload = (blob, name, folder) => withIds(async () => {
    const f = await folders();
    const m = multipart({ name, parents: [f[folder]] }, blob);
    const r = await call(`${UPLOAD}/files?uploadType=multipart&fields=id,webViewLink`, { method: 'POST', headers: { 'Content-Type': m.type }, body: m.body });
    return r.json();
  });

  const folderLink = () => ids.root ? `https://drive.google.com/drive/folders/${ids.root}` : null;

  return { enabled, hasToken, wasConnected, ready, signIn, signOut, getVersion, readData, writeData, upload, folderLink, AuthError };
})();
