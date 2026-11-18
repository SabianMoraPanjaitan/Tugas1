// MyPACS <-> backend. One small client shared by every page. Load it before the page's own script.
//
//   await MyApi.ready          -> true when the FastAPI backend answers (page served from it), false otherwise.
//                                 When false, pages keep using MockStore (demo data in the browser), so the
//                                 prototype still opens from a plain file server.
//   MyApi.live                 -> the same answer, once ready has settled.
//   MyApi.get(path)            -> JSON of GET /api/<path>.   Throws MyApi.Error on a non-2xx answer.
//   MyApi.post(path, body)     -> JSON of POST /api/<path>.  `body` is JSON, or a FormData for uploads.
//   MyApi.url(path)            -> the full URL of /api/<path>, for <img>, downloads, fetch of binary data.
//   MyApi.fetchRaw(path, init) -> the Response itself, with the login attached (for binary files).
//   MyApi.user()               -> Promise of the logged-in user ({username, role, full_name}) or null.
//   MyApi.login(u, p) / MyApi.logout()
//   MyApi.tabSession()         -> this tab gets its own login as the browser's cookie account (POST /api/auth/tab-session)
//
// Login: the backend sets an HttpOnly cookie on login and also returns a token. This tab keeps the token
// in sessionStorage under the same key the older pages use ('simrs_tab_token'), so a login on either the
// old pages or MyPACS works for both. A 401 on any call sends the page to login.html (MyPACS's own).
//
// Owned by the CEO. Workers: use this interface, don't rename or remove anything in it; ask for additions.
(function (root) {
  const TAB_KEY = 'simrs_tab_token';
  const base = location.protocol.startsWith('http') ? location.origin : '';
  class ApiError extends Error { constructor(status, detail) { super(detail || ('HTTP ' + status)); this.status = status; this.detail = detail; } }

  const token = () => { try { return sessionStorage.getItem(TAB_KEY) || ''; } catch (_) { return ''; } };
  const setToken = t => { try { t ? sessionStorage.setItem(TAB_KEY, t) : sessionStorage.removeItem(TAB_KEY); } catch (_) {} };
  const url = path => base + '/api/' + String(path).replace(/^\/+/, '').replace(/^api\//, '');
  const onLoginPage = () => /(^|\/)(login|signin|index)\.html$/i.test(location.pathname) || /\/mypacs\/?$/.test(location.pathname);
  const toLogin = () => { if (!onLoginPage()) location.replace('login.html?next=' + encodeURIComponent(location.pathname.split('/').pop() + location.search)); };

  async function fetchRaw(path, init) {
    init = Object.assign({ credentials: 'same-origin' }, init || {});
    const h = new Headers(init.headers || {}); const t = token(); if (t && !h.has('Authorization')) h.set('Authorization', 'Bearer ' + t);
    init.headers = h;
    const r = await fetch(url(path), init);
    if (r.status === 401) { setToken(''); toLogin(); }
    return r;
  }
  async function call(method, path, body) {
    const init = { method };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
    const r = await fetchRaw(path, init);
    let data = null; const text = await r.text(); try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    if (!r.ok) throw new ApiError(r.status, data && data.detail ? (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)) : r.statusText);
    return data;
  }

  const ready = !base ? Promise.resolve(false) : fetch(base + '/api/health', { credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : null).then(j => !!(j && j.status === 'ok')).catch(() => false);
  const api = {
    ready, live: false, Error: ApiError, url, fetchRaw,
    get: path => call('GET', path),
    post: (path, body) => call('POST', path, body),
    async user() { if (!(await ready)) return null; try { return await call('GET', 'auth/me'); } catch (_) { return null; } },
    async login(username, password) { const u = await call('POST', 'auth/login', { username, password }); setToken(u.token); return u; },
    async logout() { try { await call('POST', 'auth/logout'); } catch (_) {} setToken(''); },
    // a separate login for this tab, as the account the browser's cookie is signed in with
    async tabSession() { const u = await call('POST', 'auth/tab-session'); setToken(u.token); return u; },
  };
  ready.then(v => { api.live = v; });
  root.MyApi = api;
})(window);
