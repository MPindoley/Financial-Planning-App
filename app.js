/* ============================================================================
   Matthew Pindoley, SE-AWMA® — Financial Planning Workspace
   Self-contained, offline-capable. No build step, no dependencies.
   Save: localStorage (multiple client plans) + JSON export/import.
   ========================================================================== */
'use strict';

/* ----------------------------- tiny DOM utils ----------------------------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pow = Math.pow;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const uid = () => 'g' + Math.random().toString(36).slice(2, 9);
const escapeHtml = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const escapeAttr = s => String(s ?? '').replace(/"/g, '&quot;');
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ----------------------------- formatting --------------------------------- */
function fmt$(n) {
  if (n == null || isNaN(n)) return '—';
  const s = n < 0 ? '-' : '';
  return s + '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
}
function fmtK(n) {
  n = Number(n) || 0;
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `${s}$${Math.round(a / 1e3)}K`;
  return `${s}$${Math.round(a)}`;
}
const pct = (n, dp = 1) => `${(Number(n) || 0).toFixed(dp)}%`;
const money  = n => `<span class="amount">${fmt$(n)}</span>`;
const moneyK = n => `<span class="amount">${fmtK(n)}</span>`;
/* Fast money entry: accept "250k", "1.2m", "250,000", "$250000" → number. */
function parseMoney(v) {
  if (typeof v === 'number') return v;
  let s = String(v).trim().toLowerCase().replace(/[$,\s]/g, '');
  if (!s) return 0;
  let mult = 1;
  if (s.endsWith('k')) { mult = 1e3; s = s.slice(0, -1); }
  else if (s.endsWith('m')) { mult = 1e6; s = s.slice(0, -1); }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : Math.round(n * mult);
}
const moneyDisplay = n => { const x = Number(n); return isNaN(x) ? '' : x.toLocaleString('en-US'); };

/* ----------------------------- finance math ------------------------------- */
function fv(pv, r, n)        { return (pv || 0) * pow(1 + r, n); }
function fvAnnuity(pmt, r, n){ if (n <= 0) return 0; return Math.abs(r) < 1e-9 ? pmt * n : pmt * ((pow(1 + r, n) - 1) / r); }
function pvAnnuity(pmt, r, n){ if (n <= 0) return 0; return Math.abs(r) < 1e-9 ? pmt * n : pmt * (1 - pow(1 + r, -n)) / r; }
function pvGrowingAnnuity(pmt1, r, g, n) {
  if (n <= 0) return 0;
  if (Math.abs(r - g) < 1e-9) return pmt1 * n / (1 + r);
  return pmt1 / (r - g) * (1 - pow((1 + g) / (1 + r), n));
}
function pmtForFV(target, r, n) { if (n <= 0) return 0; return Math.abs(r) < 1e-9 ? target / n : target * r / (pow(1 + r, n) - 1); }
/* Level monthly payment that amortizes a loan: principal P, annual rate % over `years`. */
function loanPayment(P, ratePct, years) {
  const r = (+ratePct || 0) / 100 / 12, n = (+years || 0) * 12;
  if (n <= 0 || P <= 0) return 0;
  return Math.abs(r) < 1e-9 ? P / n : P * r / (1 - pow(1 + r, -n));
}
/* Immediate-annuity payout rate by purchase age (single-life, level) — used by the "buy income annuity" technique. */
const annuityRate = a => clamp(0.05 + Math.max(0, (+a || 0) - 60) * 0.0025, 0.045, 0.09);
/* Living expenses (annual) — from the itemized budget when in detailed mode, else the single figure. Excludes debt payments (added separately). */
function livingExpenses(E) {
  if (E && E.expenseMode === 'detailed') return Object.values(E.budget || {}).reduce((s, v) => s + (+v || 0), 0) * 12;
  return +(E && E.annualExpenses) || 0;
}
const CONTRIB_TYPES = ['cash', 'taxable', 'traditional', 'roth', 'other'];   // accounts that accept ongoing contributions
/* Year-1 per-account contributions + employer match for a plan state (accounts mode) — mirrors simulate()'s rules. */
function acctContribsFor(S) {
  const I = S.income || {}, spIncl = !!(S.household && S.household.spouse && S.household.spouse.included);
  const wc = +I.clientSalary || 0, ws = spIncl ? (+I.spouseSalary || 0) : 0;
  let employee = 0, pretax = 0, match = 0, anyAcctMatch = false;
  (S.assets || []).forEach(a => {
    if (!CONTRIB_TYPES.includes(a.type)) return;
    const owner = a.owner || (a.type === 'traditional' || a.type === 'roth' ? 'client' : 'household');
    const base = owner === 'spouse' ? ws : owner === 'household' ? wc + ws : wc;
    const c = a.contribMode === 'pct' ? base * (+a.contribPct || 0) / 100 : (+a.contribution || 0) * 12;
    employee += c; if (a.type === 'traditional') pretax += c;
    if (a.type === 'traditional' && (+a.matchPct || 0) > 0 && base > 0) {
      anyAcctMatch = true;
      match += base * Math.min(c / base, (+a.matchCapPct || 0) / 100) * ((+a.matchPct || 0) / 100);
    }
  });
  const SV = S.savings || {}, gross = wc + ws;
  if (!anyAcctMatch && (+SV.matchPct || 0) > 0 && gross > 0)
    match = gross * Math.min(pretax / gross, (+SV.matchLimitPct || 0) / 100) * ((+SV.matchPct || 0) / 100);
  return { employee, match };
}
/* Balance-weighted expected accumulation return — lets each account carry its own growth rate in "by account" savings mode. */
function blendedPreReturn(S) {
  const pre = (+(S.assumptions && S.assumptions.preReturn) || 0) / 100;
  if (!S.savings || S.savings.mode !== 'accounts') return pre;
  let num = 0, den = 0;
  (S.assets || []).forEach(a => { const bal = +a.balance || 0; if (bal > 0 && CONTRIB_TYPES.includes(a.type)) { num += bal * ((a.growth != null && a.growth !== '') ? +a.growth / 100 : pre); den += bal; } });
  return den > 0 ? num / den : pre;
}

/* ----------------------------- default state ------------------------------ */
function defaultState() {
  return {
    meta: { createdAt: Date.now() },
    household: {
      client: { name: '', age: 45, retireAge: 65, lifeExpectancy: 92 },
      spouse: { included: false, name: '', age: 45, retireAge: 65, lifeExpectancy: 92 },
      filing: 'married', state: ''
    },
    income: { clientSalary: 0, spouseSalary: 0, otherIncome: 0, salaryGrowth: 3,
              ssClient: 0, ssSpouse: 0, ssClaimClient: 67, ssClaimSpouse: 67, pension: 0, pensionCola: 0 },
    expenses: { annualExpenses: 0, retirementExpensePct: 80, expenseMode: 'simple', budget: { housing: 0, utilities: 0, food: 0, transportation: 0, healthcare: 0, insurance: 0, personal: 0, other: 0 } },
    savings:  { annualSavings: 0, employerMatch: 0, mode: 'accounts', savingsRatePct: 0, matchPct: 0, matchLimitPct: 0, targetRatePct: 15, surplusMode: 'invest' },
    savingsSplit: { pretax: 70, roth: 15, taxable: 15 },
    assets: [], liabilities: [],
    insurance: { lifeClient: 0, lifeSpouse: 0 },
    protection: { replacePct: 70, replaceYears: 15, finalExpenses: 20000, includeDebt: true, includeEducation: true },
    assumptions: { inflation: 2.7, preReturn: 6.5, postReturn: 4.8, eduInflation: 5, effectiveTaxRate: 22, ssCola: 2.3,
                   stateTaxRate: 0, dividendYield: 1.8, taxableBasisPct: 60, rmdStartAge: 73, volatilityPre: 12, volatilityPost: 9 },
    quickEducation: { childName: '', annualCost: 35000, yearsUntil: 10, duration: 4, funded: 0, monthly: 0 },
    goals: [{ id: uid(), name: 'Retirement', type: 'retirement', priority: 'High' }],
    events: [],
    rothStrategy: { on: false, mode: 'fill', toRate: 0.24, amount: 50000, startAge: 65, endAge: 72 },
    debtStrategy: { on: false, method: 'avalanche', extra: 0 },
    withdrawalStrategy: { mode: 'sequential', order: ['taxable', 'traditional', 'roth'] },
    pensionElection: { survivorPct: 0 },
    charitableStrategy: { on: false, qcd: 0 },
    advisorNotes: '',
    estate: { legacyTarget: 0, annualGifting: 0, charitableGoal: 0, hasWill: false, hasTrust: false, hasPOA: false, hasHealthDirective: false, beneficiariesConfirmed: false, estateNote: '' },
    portfolios: {
      settings: { mode: 'plan', trials: 800, years: 30, start: 0, annual: 0, wdType: 'pct', wdPct: 4, wdAmount: 0, inflateWd: true, retBasis: 'forward' },
      current:  { name: 'Current portfolio',  entryMode: 'pct', holdings: [{ id: uid(), ticker: 'SPY', weight: 60 }, { id: uid(), ticker: 'AGG', weight: 40 }] },
      proposed: { name: 'Proposed portfolio', entryMode: 'pct', holdings: [{ id: uid(), ticker: 'VTI', weight: 40 }, { id: uid(), ticker: 'VXUS', weight: 15 }, { id: uid(), ticker: 'BND', weight: 35 }, { id: uid(), ticker: 'SCHD', weight: 10 }] }
    },
    ui: { collapsed: false }
  };
}

/* A realistic sample so the workspace looks alive on first open. */
function sampleState() {
  const s = defaultState();
  s.household.client = { name: 'James Harrington', age: 52, retireAge: 65, lifeExpectancy: 92 };
  s.household.spouse = { included: true, name: 'Sarah Harrington', age: 50, retireAge: 65, lifeExpectancy: 94 };
  s.household.filing = 'married'; s.household.state = 'NC';
  s.income = { clientSalary: 110000, spouseSalary: 65000, otherIncome: 0, salaryGrowth: 3, ssClient: 30000, ssSpouse: 20000, ssClaimClient: 67, ssClaimSpouse: 67, pension: 0 };
  s.expenses = { annualExpenses: 95000, retirementExpensePct: 90 };
  s.savings = { annualSavings: 14000, employerMatch: 5000, mode: 'accounts', targetRatePct: 15, surplusMode: 'invest' };
  s.savingsSplit = { pretax: 75, roth: 10, taxable: 15 };
  s.assumptions = { inflation: 2.7, preReturn: 6.5, postReturn: 4.8, eduInflation: 5, effectiveTaxRate: 22, ssCola: 2.3, stateTaxRate: 4.5, dividendYield: 1.8, taxableBasisPct: 60, rmdStartAge: 73 };
  s.events = [
    { id: uid(), type: 'college', label: 'Emma — College', startAge: 60, years: 4, amount: 35000 },
    { id: uid(), type: 'windfall', label: 'Inheritance', atAge: 70, amount: 100000 }
  ];
  s.assets = [
    { id: uid(), name: 'Cash Reserve',        type: 'cash',        balance: 35000 },
    { id: uid(), name: 'Joint Brokerage',     type: 'taxable',     balance: 90000,  contribution: 150 },
    { id: uid(), name: 'James 401(k)',        type: 'traditional', balance: 240000, contribMode: 'pct', contribPct: 6, matchPct: 100, matchCapPct: 4 },
    { id: uid(), name: 'Sarah 403(b)',        type: 'traditional', balance: 150000, contribMode: 'pct', contribPct: 6, owner: 'spouse' },
    { id: uid(), name: 'Roth IRAs',           type: 'roth',        balance: 60000,  contribution: 250 },
    { id: uid(), name: '529 College Savings', type: 'education',   balance: 40000 },
    { id: uid(), name: 'Primary Residence',   type: 'realestate',  balance: 520000 }
  ];
  s.liabilities = [
    { id: uid(), name: 'Mortgage',  type: 'mortgage', balance: 280000, rate: 4.2, payment: 1850 },
    { id: uid(), name: 'Auto Loan', type: 'auto',     balance: 18000,  rate: 6.1, payment: 540 }
  ];
  s.insurance = { lifeClient: 300000, lifeSpouse: 150000 };
  s.protection = { replacePct: 70, replaceYears: 15, finalExpenses: 20000, includeDebt: true, includeEducation: true };
  s.quickEducation = { childName: 'Emma', annualCost: 35000, yearsUntil: 8, duration: 4, funded: 40000, monthly: 300 };
  s.quickRetire = { age: 52, retireAge: 65, lifeExpectancy: 92, currentSavings: 575000, monthlySavings: 1580, desiredAnnualIncome: 85500, socialSecurity: 50000 };
  s.quickProtect = { income: 110000, replacePct: 70, replaceYears: 15, debts: 298000, finalExpenses: 20000, existingCoverage: 300000 };
  s.goals = [
    { id: uid(), name: 'Retirement',       type: 'retirement', priority: 'High' },
    { id: uid(), name: 'Emma — College',   type: 'education',  priority: 'High',   amount: 35000,  years: 8,  duration: 4, funded: 40000, monthly: 300 },
    { id: uid(), name: 'Kitchen Remodel',  type: 'purchase',   priority: 'Medium', amount: 60000,  years: 3,  funded: 12000, monthly: 600 },
    { id: uid(), name: 'Legacy & Gifting', type: 'custom',     priority: 'Low',    amount: 150000, years: 20, funded: 0,     monthly: 250 }
  ];
  s.advisorNotes = 'PRIVATE — James anxious about market volatility; Sarah focused on retiring by 65. Savings rate is light at ~11%; nudge toward 15%. Emergency fund ~4 months — build to 6. Review term life (protection gap) and Emma’s 529 funding. Revisit Roth conversion window. Confirm beneficiary designations next meeting.';
  return s;
}

/* ----------------------------- path helpers ------------------------------- */
function getPath(o, p) { return p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o); }
function setPath(o, p, v) {
  const ks = p.split('.'); let x = o;
  for (let i = 0; i < ks.length - 1; i++) { if (x[ks[i]] == null) x[ks[i]] = {}; x = x[ks[i]]; }
  x[ks[ks.length - 1]] = v;
}

/* ----------------------------- storage ------------------------------------ */
const LS_KEY = 'mp_fp_plans_v1';
function loadStore() { try { return JSON.parse(localStorage.getItem(LS_KEY)) || { plans: {}, current: null }; } catch { return { plans: {}, current: null }; } }
function saveStore(s) { try { localStorage.setItem(LS_KEY, JSON.stringify(s)); return true; } catch { return false; } }
function planLabel(st) { return (st.household?.client?.name || '').trim() || 'New Client'; }

/* ----------------------------- cloud sync (zero-knowledge, end-to-end) -------
   One master password unlocks everything. From it (+ your email) the app derives
   TWO independent keys: an auth secret that logs you into Supabase, and a
   separate AES-GCM key that encrypts your plans ON THIS DEVICE before upload.
   The server only ever stores ciphertext and only ever sees the derived auth
   secret — never your real password, never the encryption key. localStorage
   stays the working copy, so the app is unchanged offline. */
const CLOUD_CFG_KEY = 'mp_fp_cloud_cfg_v1';      // {url, anon}  — not secret (anon key is public by design)
const CLOUD_SESS_KEY = 'mp_fp_cloud_sess_v1';    // {email, access_token, refresh_token, exp, uid}
const CLOUD_BACKUP_KEY = 'mp_fp_backup_presync_v1';
const CLOUD_PEPPER = 'mp-fp-e2e-v1';             // fixed app component mixed into every derivation
const CLOUD_PBKDF2_ITERS = 210000;
const Cloud = { key: null, email: null, sess: null, status: 'off', lastSync: 0, busy: false, lastError: '' };

const _b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const _b64d = str => Uint8Array.from(atob(str), c => c.charCodeAt(0));
const _te = new TextEncoder(), _td = new TextDecoder();
/* Pre-configured Supabase project, so the app arrives ready on any device — the
   publishable key is meant to live in client-side code; it only grants the
   encrypted, per-user access the row-level-security policy allows. A value saved
   in this browser (via the setup screen) always overrides it. */
const CLOUD_DEFAULT = { url: 'https://pdixkagltpqxxdlgamzp.supabase.co', anon: 'sb_publishable_V_nStOYmd2yMISEzZzUhag_KBuf24mg' };
function cloudCfg() {
  try { const s = JSON.parse(localStorage.getItem(CLOUD_CFG_KEY)); if (s && s.url && s.anon) return s; } catch {}
  return (CLOUD_DEFAULT.url && CLOUD_DEFAULT.anon) ? CLOUD_DEFAULT : null;   // fall back to the baked-in project
}
function setCloudCfg(url, anon) { localStorage.setItem(CLOUD_CFG_KEY, JSON.stringify({ url: String(url || '').trim().replace(/\/+$/, ''), anon: String(anon || '').trim() })); }
function loadCloudSess() { try { return JSON.parse(localStorage.getItem(CLOUD_SESS_KEY)) || null; } catch { return null; } }
function saveCloudSess() { if (Cloud.sess) localStorage.setItem(CLOUD_SESS_KEY, JSON.stringify(Cloud.sess)); }
function clearCloudSess() { localStorage.removeItem(CLOUD_SESS_KEY); Cloud.sess = null; Cloud.key = null; Cloud.email = null; }

async function _pbkdf2(pass, saltStr, bytes) {
  const base = await crypto.subtle.importKey('raw', _te.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: _te.encode(saltStr), iterations: CLOUD_PBKDF2_ITERS }, base, bytes * 8);
  return new Uint8Array(bits);
}
async function deriveAuthPassword(masterPass, email) {                 // what Supabase receives as the "password"
  return _b64(await _pbkdf2(masterPass, 'mp-auth|' + String(email).toLowerCase() + '|' + CLOUD_PEPPER, 32));
}
async function deriveEncKey(masterPass, email) {                        // never leaves the device
  const raw = await _pbkdf2(masterPass, 'mp-enc|' + String(email).toLowerCase() + '|' + CLOUD_PEPPER, 32);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function encryptBlob(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, _te.encode(JSON.stringify(obj)));
  return 'v1:' + _b64(iv) + ':' + _b64(ct);
}
async function decryptBlob(key, blob) {
  const parts = String(blob).split(':');
  if (parts[0] !== 'v1' || parts.length !== 3) throw new Error('Unrecognized data format');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: _b64d(parts[1]) }, key, _b64d(parts[2]));
  return JSON.parse(_td.decode(pt));
}

async function cloudApi(path, opts = {}) {
  const cfg = cloudCfg(); if (!cfg || !cfg.url || !cfg.anon) throw new Error('Cloud is not set up yet');
  const headers = Object.assign({ apikey: cfg.anon, 'Content-Type': 'application/json' }, opts.headers || {});
  return fetch(cfg.url + path, Object.assign({}, opts, { headers }));
}
const _authHeader = () => ({ Authorization: 'Bearer ' + (Cloud.sess && Cloud.sess.access_token) });
async function ensureToken() {
  if (!Cloud.sess) throw new Error('Not signed in');
  if (Date.now() < Cloud.sess.exp - 60000) return;
  const res = await cloudApi('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: Cloud.sess.refresh_token }) });
  const j = await res.json(); if (!res.ok) throw new Error('Session expired — please sign in again');
  Cloud.sess.access_token = j.access_token; Cloud.sess.refresh_token = j.refresh_token || Cloud.sess.refresh_token;
  Cloud.sess.exp = Date.now() + (j.expires_in || 3600) * 1000; saveCloudSess();
}
async function cloudSignup(email, masterPass) {
  const password = await deriveAuthPassword(masterPass, email);
  const res = await cloudApi('/auth/v1/signup', { method: 'POST', body: JSON.stringify({ email, password }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.msg || j.error_description || j.error || 'Sign-up failed');
  return j.access_token ? await cloudLogin(email, masterPass) : { needsConfirm: true };
}
async function cloudLogin(email, masterPass) {
  const password = await deriveAuthPassword(masterPass, email);
  const res = await cloudApi('/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email, password }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const m = j.error_description || j.msg || j.error || '';
    if (/confirm/i.test(m)) throw new Error('Email not confirmed yet — click the link Supabase emailed you, then log in.');
    throw new Error(/invalid|grant|credential/i.test(m) ? 'Wrong email or password.' : (m || 'Login failed'));
  }
  Cloud.email = email;
  Cloud.key = await deriveEncKey(masterPass, email);
  Cloud.sess = { email, access_token: j.access_token, refresh_token: j.refresh_token, exp: Date.now() + (j.expires_in || 3600) * 1000, uid: j.user && j.user.id };
  Cloud.status = 'ready'; saveCloudSess();
  return { ok: true };
}
async function cloudUnlock(masterPass) {                                // re-derive the key for an existing session (e.g. after reload)
  if (!Cloud.sess) throw new Error('Not signed in');
  const check = await deriveAuthPassword(masterPass, Cloud.sess.email);
  // verify the passphrase by attempting a real login (also refreshes tokens)
  const r = await cloudLogin(Cloud.sess.email, masterPass);
  return r;
}
async function cloudPull() {
  await ensureToken();
  const res = await cloudApi('/rest/v1/vault?select=data,updated_at&user_id=eq.' + encodeURIComponent(Cloud.sess.uid), { headers: _authHeader() });
  if (!res.ok) throw new Error('Could not read from the cloud (HTTP ' + res.status + ')' + (res.status === 401 ? ' — the table grant may be missing' : '') + ': ' + (await res.text().catch(() => '')).slice(0, 180));
  const rows = await res.json();
  if (!rows.length) return null;
  const obj = await decryptBlob(Cloud.key, rows[0].data);               // { store, updatedAt }
  return { store: obj.store, updatedAt: +obj.updatedAt || Date.parse(rows[0].updated_at) || 0 };
}
async function cloudPush() {
  await ensureToken();
  const store = loadStore(), updatedAt = Date.now();
  const blob = await encryptBlob(Cloud.key, { store, updatedAt });
  const body = [{ user_id: Cloud.sess.uid, data: blob, updated_at: new Date(updatedAt).toISOString() }];
  const res = await cloudApi('/rest/v1/vault', { method: 'POST', headers: Object.assign(_authHeader(), { Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(body) });
  if (!res.ok) throw new Error('Could not save to the cloud (HTTP ' + res.status + '): ' + (await res.text().catch(() => '')).slice(0, 180));
  Cloud.lastSync = updatedAt; return updatedAt;
}
/* Is this plan record the untouched demo client? (Never sync the demo between devices.) */
function isFreshSample(rec) {
  try {
    const sig = st => {                                                 // fingerprint that ignores volatile ids/timestamps
      const c = JSON.parse(JSON.stringify(st || {}));
      delete c.meta; delete c.ui; delete c.presentation; delete c.baseline;
      (function strip(o) { if (Array.isArray(o)) o.forEach(strip); else if (o && typeof o === 'object') { delete o.id; for (const k in o) strip(o[k]); } })(c);
      return JSON.stringify(c);
    };
    return !!(rec && rec.state) && sig(rec.state) === sig(ensureDefaults(sampleState()));
  } catch { return false; }
}
/* Union two stores by client id — the newer save wins, nothing is ever dropped, the demo is left out. */
function mergeStores(base, overlay) {
  const plans = {};
  for (const id in (base.plans || {})) plans[id] = base.plans[id];
  for (const id in (overlay.plans || {})) {
    const op = overlay.plans[id];
    if (!plans[id] || (+op.updatedAt || 0) > (+plans[id].updatedAt || 0)) plans[id] = op;
  }
  const ids = Object.keys(plans);
  if (ids.length > 1) for (const id of ids) if (isFreshSample(plans[id])) delete plans[id];   // drop the demo unless it's the only thing
  const current = (base.current && plans[base.current]) ? base.current
    : (overlay.current && plans[overlay.current]) ? overlay.current : Object.keys(plans)[0] || null;
  return { plans, current, syncedAt: Date.now() };
}
/* The one sync step: pull the cloud, merge with local, save, push the union back so every device converges. */
async function cloudReconcile() {
  const remote = await cloudPull();                                    // { store, updatedAt } | null
  const local = loadStore();
  localStorage.setItem(CLOUD_BACKUP_KEY, JSON.stringify(local));       // safety copy before we change anything
  const next = remote ? mergeStores(remote.store, local) : mergeStores(local, { plans: {} });
  saveStore(next);
  await cloudPush();
  return { hadRemote: !!remote, plans: Object.keys(next.plans).length };
}
async function cloudSyncNow() {
  if (Cloud.status !== 'ready') throw new Error('Unlock cloud sync first');
  return cloudReconcile();
}
const cloudMaybePush = debounce(() => {
  if (Cloud.status !== 'ready' || Cloud.busy || !navigator.onLine) return;
  Cloud.busy = true;
  cloudReconcile().then(() => { Cloud.lastError = ''; }).catch(e => { Cloud.lastError = e.message; })
    .finally(() => { Cloud.busy = false; renderCloudStatus(); });
}, 2500);
function initCloudSession() {                                          // on load: restore session (locked until passphrase re-entered)
  const cfg = cloudCfg(); if (!cfg) { Cloud.status = 'off'; return; }
  const s = loadCloudSess();
  if (s && s.access_token) { Cloud.sess = s; Cloud.email = s.email; Cloud.status = 'locked'; }
  else Cloud.status = 'signedout';
}

/* ----------------------------- tax engine --------------------------------- */
/* 2026 federal parameters (IRS Rev. Proc. 2025-32), inflated forward each year. */
const TAX = {
  baseYear: 2026,
  std: { married: 32200, single: 16100, hoh: 24150 },
  extraStd65: { married: 1650, single: 2050, hoh: 2050 },   /* additional standard deduction per 65+ filer (2026 est.) */
  brackets: {
    married: [[0, .10], [24800, .12], [100800, .22], [211100, .24], [402500, .32], [511300, .35], [767000, .37]],
    single:  [[0, .10], [12400, .12], [50400, .22], [105700, .24], [201775, .32], [256225, .35], [640600, .37]],
    hoh:     [[0, .10], [17700, .12], [67450, .22], [105700, .24], [201775, .32], [256200, .35], [640600, .37]]
  },
  ltcg: {
    married: [[0, 0], [98900, .15], [613700, .20]],
    single:  [[0, 0], [49450, .15], [545500, .20]],
    hoh:     [[0, 0], [66200, .15], [579650, .20]]
  },
  ssBase: { married: [32000, 44000], single: [25000, 34000], hoh: [25000, 34000] },
  ficaWageBase: 184500, ficaSS: 0.062, ficaMed: 0.0145
};
const RMD_TABLE = { 72: 27.4, 73: 26.5, 74: 25.5, 75: 24.6, 76: 23.7, 77: 22.9, 78: 22.0, 79: 21.1, 80: 20.2, 81: 19.4, 82: 18.5, 83: 17.7, 84: 16.8, 85: 16.0, 86: 15.2, 87: 14.4, 88: 13.7, 89: 12.9, 90: 12.2, 91: 11.5, 92: 10.8, 93: 10.1, 94: 9.5, 95: 8.9, 96: 8.4, 97: 7.8, 98: 7.3, 99: 6.8, 100: 6.4, 101: 6.0, 102: 5.6, 103: 5.2, 104: 4.9, 105: 4.6 };
const rmdDivisor = age => (age < 72 ? 0 : (RMD_TABLE[Math.min(105, Math.round(age))] || 4.6));
const filingOf = f => (f === 'married' ? 'married' : f === 'hoh' ? 'hoh' : 'single');

function bracketTax(taxable, brackets) {
  if (taxable <= 0) return 0; let tax = 0;
  for (let i = 0; i < brackets.length; i++) {
    const lo = brackets[i][0], rate = brackets[i][1], hi = i + 1 < brackets.length ? brackets[i + 1][0] : Infinity;
    if (taxable > lo) tax += (Math.min(taxable, hi) - lo) * rate; else break;
  }
  return tax;
}
function marginalRate(taxable, brackets) { let r = brackets[0][1]; for (const [lo, rate] of brackets) if (taxable > lo) r = rate; return r; }
function bracketTopFor(targetRate, brackets) {
  for (let i = 0; i < brackets.length; i++) if (Math.abs(brackets[i][1] - targetRate) < 1e-9) return i + 1 < brackets.length ? brackets[i + 1][0] : Infinity;
  return Infinity;
}
/* Taxable portion of Social Security via provisional income (thresholds are not inflation-indexed). */
function ssTaxablePortion(ss, otherIncome, filing) {
  if (ss <= 0) return 0;
  const [t1, t2] = TAX.ssBase[filing] || TAX.ssBase.single;
  const prov = otherIncome + 0.5 * ss;
  if (prov <= t1) return 0;
  if (prov <= t2) return Math.min(0.5 * ss, 0.5 * (prov - t1));
  const tier1 = Math.min(0.5 * ss, 0.5 * (t2 - t1));
  return Math.min(0.85 * ss, 0.85 * (prov - t2) + tier1);
}
/* Long-term cap gains / qualified dividends stacked on top of ordinary taxable income. */
function ltcgTax(gain, ordinaryTaxable, br) {
  if (gain <= 0) return 0;
  let tax = 0; const start = Math.max(0, ordinaryTaxable), end = start + gain;
  for (let i = 0; i < br.length; i++) {
    const lo = br[i][0], rate = br[i][1], hi = i + 1 < br.length ? br[i + 1][0] : Infinity;
    const a = Math.max(lo, start), b = Math.min(hi, end);
    if (b > a) tax += (b - a) * rate;
  }
  return tax;
}
/* Full single-year tax estimate. All amounts nominal for the given year. */
function computeTax(o) {
  const filing = filingOf(o.filing);
  const f = o.inflFac || 1;
  const brackets = TAX.brackets[filing].map(([lo, r]) => [lo * f, r]);
  const ltcgBr = TAX.ltcg[filing].map(([lo, r]) => [lo * f, r]);
  const std = (TAX.std[filing] + (+o.seniors || 0) * (TAX.extraStd65[filing] || 0)) * f;   // 65+ filers get the extra standard deduction
  const wages = +o.wages || 0, pretax = +o.pretax || 0;
  const ordinaryGross = Math.max(0, wages - pretax) + (+o.pension || 0) + (+o.taxableInterest || 0) + (+o.otherIncome || 0) +
    (+o.deferredWithdrawal || 0) + (+o.rothConversion || 0);
  const ss = +o.ss || 0, gains = (+o.qualDiv || 0) + (+o.ltcgRealized || 0);
  const ssTaxable = ssTaxablePortion(ss, ordinaryGross + gains, filing);
  const agi = ordinaryGross + gains + ssTaxable;
  const ordIncome = ordinaryGross + ssTaxable;
  const ordinaryTaxable = Math.max(0, ordIncome - std);
  const usedStd = Math.min(std, ordIncome);
  const gainsTaxable = Math.max(0, gains - (std - usedStd));
  const fed = bracketTax(ordinaryTaxable, brackets) + ltcgTax(gainsTaxable, ordinaryTaxable, ltcgBr);
  const stateRate = (+o.stateRate || 0) / 100;
  const state = Math.max(0, agi - std) * stateRate;
  let fica = 0;
  if (o.isWorking && wages > 0) {
    const fw = (o.ficaWages && o.ficaWages.length) ? o.ficaWages : [wages];   // per-earner: each worker has their own SS wage-base cap
    fw.forEach(w => { if (w > 0) fica += Math.min(w, TAX.ficaWageBase * f) * TAX.ficaSS + w * TAX.ficaMed; });
  }
  return {
    fed, state, fica, total: fed + state + fica, agi, ssTaxable, gains,
    taxableIncome: ordinaryTaxable + gainsTaxable, ordinaryTaxable,
    marginal: marginalRate(ordinaryTaxable, brackets), brackets, std
  };
}

/* ----------------------------- life events -------------------------------- */
/* Recurring/one-time cash effects of scenario events for a given year. */
function applyEventsYear(events, age, t, infl) {
  let cashIn = 0, cashOut = 0; const g = pow(1 + infl, t);
  (events || []).forEach(ev => {
    const amt = +ev.amount || 0;
    const startAge = +ev.startAge || 0, years = +ev.years || 1, atAge = +ev.atAge || startAge;
    switch (ev.type) {
      case 'child': case 'college': case 'ltc': case 'expenseRecurring':
        if (age >= startAge && age < startAge + years) cashOut += amt * g; break;
      case 'income':
        if (age >= startAge && age < startAge + years) cashIn += amt * g; break;
      case 'expense':
        if (age === atAge) cashOut += amt * g; break;
      case 'windfall':
        if (age === atAge) cashIn += amt * g; break;
    }
  });
  return { in: cashIn, out: cashOut };
}
/* Recurring/period outflows from goals the user has flagged onto the plan timeline (off unless onPlan). */
function goalSpendYear(goals, age, infl, curAge, eduI) {
  let out = 0;
  (goals || []).forEach(go => {
    if (!go.onPlan) return;
    if (go.type === 'education') {
      const start = curAge + (+go.years || 0), dur = Math.max(1, +go.duration || 1);
      if (age >= start && age < start + dur) out += (+go.amount || 0) * pow(1 + eduI, age - curAge);
    } else if (go.type === 'ltc') {
      const start = +go.startAge || 0, dur = Math.max(1, +go.duration || 1), cov = (+go.coverage || 0) / 100;
      if (start > 0 && age >= start && age < start + dur) out += (+go.amount || 0) * (1 - cov) * pow(1 + infl, age - curAge);
    } else if (['custom', 'travel', 'gifting', 'charitable'].includes(go.type)) {
      const sA = +go.startAge || 0, eA = Math.max(sA, +go.endAge || sA), freq = go.frequency || 'once', gi = (go.inflation != null && go.inflation !== '' ? +go.inflation : infl * 100) / 100;
      if (sA > 0) {
        if (freq === 'once') { if (age === sA) out += (+go.amount || 0) * pow(1 + gi, age - curAge); }
        else if (age >= sA && age <= eA) out += (+go.amount || 0) * (freq === 'monthly' ? 12 : 1) * pow(1 + gi, age - curAge);
      }
    }
  });
  return out;
}
function rothConversionYear(S, ctx) {
  const rs = S.rothStrategy; if (!rs || !rs.on) return 0;
  const { age, bDef, filing, inflFac, pension, ss, rmd } = ctx;
  if (age < (+rs.startAge || 0) || age > (+rs.endAge || 200) || bDef <= 0) return 0;
  if (rs.mode === 'amount') return Math.min(+rs.amount || 0, bDef);
  const brackets = TAX.brackets[filingOf(filing)].map(([lo, r]) => [lo * inflFac, r]);
  const std = TAX.std[filingOf(filing)] * inflFac;
  const top = bracketTopFor(parseFloat(rs.toRate || 0.24), brackets);
  const ssTax = ssTaxablePortion(ss, pension + rmd, filing);
  const curOrd = Math.max(0, pension + rmd + ssTax - std);
  return Math.min(Math.max(0, top - curOrd), bDef);
}
function sequenceWithdrawals(W, bTax, bDef, bRoth, basis, order, mode) {
  let rem = Math.max(0, W);
  const w = { taxable: 0, traditional: 0, roth: 0 }, bal = { taxable: bTax, traditional: bDef, roth: bRoth };
  if (mode === 'proportional') {                                       // pro-rata across all buckets by balance
    const tot = bTax + bDef + bRoth;
    if (tot > 0) { const draw = Math.min(rem, tot); w.taxable = draw * bTax / tot; w.traditional = draw * bDef / tot; w.roth = draw * bRoth / tot; rem -= draw; }
  } else {                                                             // sequential: deplete one bucket, then the next, in the chosen order
    const seq = (order && order.length === 3) ? order : ['taxable', 'traditional', 'roth'];
    for (const k of seq) { const take = Math.min(bal[k] || 0, rem); w[k] = take; rem -= take; }
  }
  const gainFrac = bTax > 0 ? Math.max(0, bTax - basis) / bTax : 0;
  return { wTax: w.taxable, wDef: w.traditional, wRoth: w.roth, gain: w.taxable * gainFrac, shortfall: rem };
}

/* ----------------------------- projection simulation ---------------------- */
function simulate(S, opts = {}) {
  const A = S.assumptions, H = S.household, I = S.income, E = S.expenses, SV = S.savings;
  const infl = A.inflation / 100, pre = blendedPreReturn(S), post = A.postReturn / 100,
        salg = (+I.salaryGrowth || 0) / 100, cola = (+A.ssCola || 0) / 100, eduI = (A.eduInflation != null ? +A.eduInflation : 5) / 100;
  const stateRate = +A.stateTaxRate || 0, divYield = (A.dividendYield != null ? +A.dividendYield : 1.8) / 100;
  const filing = H.filing || 'married';
  const c = H.client, sp = H.spouse, spOn = !!sp.included;
  const curAge = +c.age || 0, clientRet = +c.retireAge || 65, life = +c.lifeExpectancy || 92;
  const spAge0 = +sp.age || curAge, spRet = +sp.retireAge || 65, spLife = +sp.lifeExpectancy || life;
  const endAge = Math.max(life, spOn ? spLife : life);
  const rmdAge = +A.rmdStartAge || 73;
  const ssClaimC = clamp(+I.ssClaimClient || clientRet, 62, 70), ssClaimS = clamp(+I.ssClaimSpouse || spRet, 62, 70);
  /* Future claim: entered benefit = FRA-67 estimate, scaled for the chosen claim age (~70% at 62 … 124% at 70).
     Already claiming (at/past the claim age today): the entered amount IS the actual check — use it as-is. */
  const ssFacC = curAge >= ssClaimC ? 1 : ssFactor(ssClaimC), ssFacS = spAge0 >= ssClaimS ? 1 : ssFactor(ssClaimS);
  const pensCola = (+I.pensionCola || 0) / 100;                     // most pensions are level — no silent CPI indexing
  const curYear = new Date().getFullYear();

  const by = {}; (S.assets || []).forEach(a => by[a.type] = (by[a.type] || 0) + (+a.balance || 0));
  let bTax = (by.cash || 0) + (by.taxable || 0) + (by.other || 0);
  let bDef = (by.traditional || 0), bRoth = (by.roth || 0);
  let basis = ((A.taxableBasisPct != null ? +A.taxableBasisPct : 60) / 100) * bTax;
  let reStatic = by.realestate || 0; let eduBal = by.education || 0;   // education savings grow and are drawn for tuition
  const homeBuys = (S.goals || []).filter(gg => gg.type === 'home' && +gg.buyAge > 0);   // future home purchases modeled in the projection

  const split = S.savingsSplit || { pretax: 70, roth: 15, taxable: 15 };
  const totSplit = (+split.pretax || 0) + (+split.roth || 0) + (+split.taxable || 0) || 1;
  let debts = (S.liabilities || []).map(l => ({ type: l.type, bal: +l.balance || 0, rate: (+l.rate || 0) / 100, pay: (+l.payment || 0) * 12 }));
  const baseExp = livingExpenses(E), retPct = (+E.retirementExpensePct || 100) / 100;
  const events = S.events || [];
  const ds = S.debtStrategy || {};                                   // debt-payoff accelerator (off by default)
  const INS = S.insurance || {};
  const survivor = (S.survivor && S.survivor.on) ? S.survivor : null; // death-of-spouse what-if (Decision Center only)
  const survExpFactor = survivor ? (survivor.expenseFactor != null ? +survivor.expenseFactor : 0.75) : 1;
  const disability = (S.disability && S.disability.on) ? S.disability : null;   // disability what-if (Decision Center only)
  const disPct = disability ? (disability.benefitPct != null ? +disability.benefitPct : 60) / 100 : 0;
  const pe = S.pensionElection || {};                                // pension survivor-benefit election (joint-and-survivor)
  const pensSurvPct = (+pe.survivorPct || 0) / 100, pensReduction = 1 - 0.15 * pensSurvPct;
  const cs = S.charitableStrategy || {};                             // charitable QCD strategy (off by default)
  const sweepSurplus = (SV.surplusMode || 'invest') !== 'discretionary';   // invest leftover income, or treat it as discretionary spending
  const wStrat = S.withdrawalStrategy || {};                         // configurable drawdown order / proportional
  const wOrder = (wStrat.order && wStrat.order.length === 3) ? wStrat.order : ['taxable', 'traditional', 'roth'];
  const wMode = wStrat.mode === 'proportional' ? 'proportional' : 'sequential';

  const rows = []; let depletionAge = null, lifetimeTax = 0, lifetimeFedTax = 0, lifetimeStateTax = 0;

  for (let age = curAge; age <= endAge; age++) {
    const t = age - curAge, year = curYear + t;
    const inflFac = pow(1 + infl, Math.max(0, year - TAX.baseYear)), g = pow(1 + infl, t);
    const spNow = spAge0 + t;
    let deadClient = false, deadSpouse = false, deathBenefit = 0, filingY = filing, expFac = 1;
    if (survivor) {
      const isClient = survivor.who === 'client', dA = +survivor.atAge || 0;
      const gone = isClient ? (age >= dA) : (spOn && spNow >= dA);
      if (gone) {
        if (isClient) deadClient = true; else deadSpouse = true;
        filingY = 'single'; expFac = survExpFactor;
        if ((isClient && age === dA) || (!isClient && spNow === dA)) deathBenefit = isClient ? (+INS.lifeClient || 0) : (+INS.lifeSpouse || 0);
      }
    }
    let disClient = false, disSpouse = false;
    if (disability) {
      const isC = disability.who === 'client', dA2 = +disability.atAge || 0;
      if (isC) disClient = age >= dA2 && age < clientRet && !deadClient;
      else disSpouse = spOn && spNow >= dA2 && spNow < spRet && !deadSpouse;
    }
    const clientWorking = age < clientRet && !deadClient && !disClient, spouseWorking = spOn && spNow < spRet && !deadSpouse && !disSpouse, anyWorking = clientWorking || spouseWorking;
    const retired = age >= clientRet;
    const seniors = ((age >= 65 && !deadClient) ? 1 : 0) + ((spOn && spNow >= 65 && !deadSpouse) ? 1 : 0);   // 65+ filers → extra standard deduction
    const growRate = opts.sampleReturn ? opts.sampleReturn(retired) : (retired ? post : pre);

    /* one-time balance/debt events */
    events.forEach(ev => {
      if (ev.type === 'downturn' && age === (+ev.atAge || 0)) { const k = 1 - (+ev.amount || 0) / 100; bTax *= k; bDef *= k; bRoth *= k; basis *= k; }
      if (ev.type === 'mortgagePayoff' && age === (+ev.atAge || 0)) { debts.forEach(d => { if (d.type === 'mortgage' && d.bal > 0) { let p = d.bal; const tT = Math.min(bTax, p); bTax -= tT; p -= tT; const tD = Math.min(bDef, p); bDef -= tD; p -= tD; bRoth -= Math.min(bRoth, p); if (basis > bTax) basis = bTax; d.bal = 0; } }); }   // pay off from taxable → deferred → Roth (never drive a bucket negative)
      if (ev.type === 'sellAsset' && age === (+ev.atAge || 0)) { const pr = (+ev.amount || 0) * g; bTax += pr; basis += pr; }   // proceeds into taxable
      if (ev.type === 'annuity' && age === (+ev.atAge || 0)) { let prem = (+ev.amount || 0) * g; const tT = Math.min(bTax, prem); bTax -= tT; prem -= tT; const tD = Math.min(bDef, prem); bDef -= tD; prem -= tD; bRoth -= Math.min(bRoth, prem); if (basis > bTax) basis = bTax; }   // premium out of portfolio
    });
    if (deathBenefit > 0) { bTax += deathBenefit; basis += deathBenefit; }   // life-insurance payout to the survivor
    homeBuys.forEach(h => {                                            // buy a home: spend the down payment, take on a mortgage
      if (age === Math.round(+h.buyAge || 0)) {
        const price = (+h.price || 0) * g, down = price * ((h.downPct != null ? +h.downPct : 20) / 100);
        let d = down; const t1 = Math.min(bTax, d); bTax -= t1; d -= t1; const t2 = Math.min(bDef, d); bDef -= t2; d -= t2; bRoth -= Math.min(bRoth, d);
        if (basis > bTax) basis = bTax;
        reStatic += price;                                            // the home enters net worth
        const loan = Math.max(0, price - down);
        if (loan > 0) debts.push({ type: 'mortgage', bal: loan, rate: (+h.rate || 6) / 100, pay: loanPayment(loan, +h.rate || 6, +h.term || 30) * 12 });
      }
    });
    (S.goals || []).forEach(go => {                                   // major purchase (cash or financed) flagged onto the timeline
      if (!go.onPlan || go.type !== 'purchase' || age !== Math.round(+go.buyAge || (curAge + (+go.years || 0)))) return;
      const amt = (+go.amount || 0) * g, financed = (+go.term || 0) > 0, spend = financed ? amt * ((go.downPct != null ? +go.downPct : 20) / 100) : amt;
      let d = spend; const t1 = Math.min(bTax, d); bTax -= t1; d -= t1; const t2 = Math.min(bDef, d); bDef -= t2; d -= t2; bRoth -= Math.min(bRoth, d);
      if (basis > bTax) basis = bTax;
      if (financed) { const loan = amt - spend; if (loan > 0) debts.push({ type: 'other', bal: loan, rate: (+go.rate || 6) / 100, pay: loanPayment(loan, +go.rate || 6, +go.term || 5) * 12 }); }
    });

    /* income */
    let wages = 0, wagesC = 0, wagesS = 0;
    if (clientWorking) { wagesC = (+I.clientSalary || 0) * pow(1 + salg, t); wages += wagesC; }
    if (spouseWorking) { wagesS = (+I.spouseSalary || 0) * pow(1 + salg, t); wages += wagesS; }
    const otherInc = anyWorking ? (+I.otherIncome || 0) * g : 0;
    let ss = 0;
    const ssC = (age >= ssClaimC) ? (+I.ssClient || 0) * ssFacC * pow(1 + cola, t) : 0;
    const ssS = (spOn && spNow >= ssClaimS) ? (+I.ssSpouse || 0) * ssFacS * pow(1 + cola, t) : 0;
    ss = (deadClient || deadSpouse) ? Math.max(ssC, ssS) : ssC + ssS;   // survivor keeps the larger benefit
    let rowSsC = ssC, rowSsS = ssS;                                     // split that actually sums to ss (for the breakdown drill-down)
    if (deadClient || deadSpouse) { if (ssC >= ssS) { rowSsC = ss; rowSsS = 0; } else { rowSsC = 0; rowSsS = ss; } }
    let pension = retired ? (+I.pension || 0) * pow(1 + pensCola, t) * pensReduction : 0;   // level unless a COLA is set; election reduces the benefit
    if (pension > 0 && (deadClient || deadSpouse)) pension *= pensSurvPct; // survivor continuation per the election
    let disabilityInc = 0;                                              // disability income replacement (% of salary, pre-retirement)
    if (disClient) disabilityInc += (+I.clientSalary || 0) * pow(1 + salg, t) * disPct;
    if (disSpouse) disabilityInc += (+I.spouseSalary || 0) * pow(1 + salg, t) * disPct;
    const qualDiv = bTax * divYield;

    /* contributions */
    let cPretax = 0, cRoth = 0, cTaxable = 0, match = 0;
    if (anyWorking) {
      if (SV.mode === 'accounts') {                                      // per-account contributions, classified by account type
        let anyAcctMatch = false;
        (S.assets || []).forEach(a => {
          if (!CONTRIB_TYPES.includes(a.type)) return;
          const owner = a.owner || (a.type === 'traditional' || a.type === 'roth' ? 'client' : 'household');
          const ownerWorking = owner === 'spouse' ? spouseWorking : owner === 'household' ? anyWorking : clientWorking;
          if (!ownerWorking) return;                                     // contributions stop when that person's paychecks do
          const ownerWages = owner === 'spouse' ? wagesS : owner === 'household' ? wages : wagesC;
          const c = a.contribMode === 'pct'
            ? ownerWages * (+a.contribPct || 0) / 100                     // % of that person's salary — scales as pay grows
            : (+a.contribution || 0) * 12 * pow(1 + salg, t);
          if (a.type === 'roth') cRoth += c; else if (a.type === 'traditional') cPretax += c; else cTaxable += c;
          if (a.type === 'traditional' && (+a.matchPct || 0) > 0 && ownerWages > 0) {   // employer match lives on the account
            anyAcctMatch = true;
            const rate = Math.min(c / ownerWages, (+a.matchCapPct || 0) / 100);
            match += ownerWages * rate * ((+a.matchPct || 0) / 100);
          }
        });
        if (!anyAcctMatch && (+SV.matchPct || 0) > 0 && wages > 0) {     // legacy global match (older plans)
          const rate = Math.min(cPretax / wages, (+SV.matchLimitPct || 0) / 100);
          match = wages * rate * ((+SV.matchPct || 0) / 100);
        }
      } else {
        let sav;
        if (SV.mode === 'percent') {                                     // % of income — scales with salary growth automatically
          sav = (+SV.savingsRatePct || 0) / 100 * wages;
          const mr = Math.min((+SV.savingsRatePct || 0) / 100, (+SV.matchLimitPct || 0) / 100);
          match = wages * mr * ((+SV.matchPct || 0) / 100);              // employer matches matchPct of pay up to matchLimitPct
        } else {
          sav = (+SV.annualSavings || 0) * pow(1 + salg, t);
          match = (+SV.employerMatch || 0) * pow(1 + salg, t);
        }
        cPretax = sav * ((+split.pretax || 0) / totSplit);
        cRoth = sav * ((+split.roth || 0) / totSplit);
        cTaxable = sav * ((+split.taxable || 0) / totSplit);
      }
    }

    /* spending need */
    const ev = applyEventsYear(events, age, t, infl);
    const expenses = baseExp * (retired ? retPct : 1) * g * expFac;
    let debtPay = 0;
    debts.forEach(d => { if (d.bal > 0.01) { const interest = d.bal * d.rate; const pay = Math.min(Math.max(d.pay, interest), d.bal + interest); d.bal = Math.max(0, d.bal - (pay - interest)); debtPay += pay; } });
    if (ds.on && (+ds.extra || 0) > 0) {                              // accelerator: extra payment, snowball/avalanche order
      let extra = (+ds.extra || 0) * 12 * g;
      const active = debts.filter(d => d.bal > 0.01).sort((x, y) => ds.method === 'snowball' ? x.bal - y.bal : y.rate - x.rate);
      for (const d of active) { if (extra <= 0.01) break; const ap = Math.min(extra, d.bal); d.bal -= ap; debtPay += ap; extra -= ap; }
    }
    let annuityInc = 0, expenseCut = 0;                               // annuity income stream + downsize expense reduction
    events.forEach(e => {
      const a0 = +e.atAge || 0;
      if (e.type === 'annuity' && age >= a0) annuityInc += (+e.amount || 0) * pow(1 + infl, Math.max(0, a0 - curAge)) * annuityRate(a0);
      if (e.type === 'sellAsset' && age >= a0) expenseCut += (+e.cut || 0) * g;
    });
    const gOutAll = goalSpendYear(S.goals, age, infl, curAge, eduI);  // education / LTC / recurring goal spend on the timeline
    const gOutEdu = goalSpendYear((S.goals || []).filter(gg => gg.type === 'education'), age, infl, curAge, eduI);
    const evCollege = applyEventsYear(events.filter(e2 => e2.type === 'college'), age, t, infl).out;
    const eduGross = gOutEdu + evCollege, eduDraw = Math.min(eduBal, eduGross);   // tuition is paid from 529/education savings first
    eduBal -= eduDraw;
    const eduK = eduGross > 0 ? (eduGross - eduDraw) / eduGross : 1;  // only the uncovered share hits household cash flow
    const gOut = gOutAll - gOutEdu + gOutEdu * eduK, evOutNet = ev.out - evCollege + evCollege * eduK;
    const need = Math.max(0, expenses - expenseCut) + debtPay + evOutNet + gOut;

    let rmd = (age >= rmdAge && bDef > 0) ? bDef / rmdDivisor(age) : 0;
    const qcdAmt = (cs.on && retired && age >= rmdAge && bDef > 0) ? Math.min((+cs.qcd || 0) * g, rmd, bDef) : 0;   // QCD satisfies RMD tax-free
    const rmdHH = rmd - qcdAmt;                                          // household portion of the RMD (after charitable QCD)
    let conversion = rothConversionYear(S, { age, bDef, filing: filingY, inflFac, pension, ss, rmd: rmdHH });

    const row = { age, t, year, phase: anyWorking ? 'work' : 'retire', wages, ss, pension, rmd, conversion, expenses, need };
    let taxes, wT = 0, wD = 0, wR = 0, gain = 0, leftover = 0;

    if (anyWorking) {
      bDef += cPretax + match; bRoth += cRoth; bTax += cTaxable + qualDiv; basis += cTaxable + qualDiv;
      bDef -= rmd;                                                     // RMDs are mandatory even while a (younger) spouse still works
      if (conversion > 0) { const cv = Math.min(conversion, bDef); bDef -= cv; bRoth += cv; conversion = cv; }
      const baseTax = { wages, pretax: cPretax, pension, otherIncome: otherInc, taxableInterest: 0, qualDiv, ss, filing: filingY, stateRate, inflFac, isWorking: true, ficaWages: [wagesC, wagesS], seniors };
      taxes = computeTax({ ...baseTax, deferredWithdrawal: rmdHH + conversion });
      const cashIn = wages + otherInc + ss + pension + ev.in + annuityInc + disabilityInc + rmdHH;
      const netCash = cashIn - taxes.total - need - cPretax - cRoth - cTaxable;
      if (netCash >= 0) { leftover = netCash; if (sweepSurplus) { bTax += netCash; basis += netCash; } }   // leftover: invest it, or leave it discretionary
      else {                                                           // shortfall funded from savings — tax the deferred draw like any other withdrawal
        const hadPortfolio = (bTax + bDef + bRoth) > 1;
        let W = -netCash, seq = sequenceWithdrawals(W, bTax, bDef, bRoth, basis, wOrder, wMode);
        for (let i = 0; i < 8; i++) {
          const tx = computeTax({ ...baseTax, deferredWithdrawal: rmdHH + conversion + seq.wDef, ltcgRealized: seq.gain });
          const newW = Math.max(0, need + cPretax + cRoth + cTaxable + tx.total - cashIn);
          seq = sequenceWithdrawals(newW, bTax, bDef, bRoth, basis, wOrder, wMode);
          if (Math.abs(newW - W) < 25) { W = newW; break; } W = newW;
        }
        taxes = computeTax({ ...baseTax, deferredWithdrawal: rmdHH + conversion + seq.wDef, ltcgRealized: seq.gain });
        const before = bTax; bTax -= seq.wTax; if (before > 0) basis *= bTax / before; bDef -= seq.wDef; bRoth -= seq.wRoth;
        wT = seq.wTax; wD = seq.wDef; wR = seq.wRoth; gain = seq.gain;
        if (seq.shortfall > 1 && hadPortfolio && depletionAge === null) depletionAge = age;
      }
      bTax *= 1 + growRate; bDef *= 1 + growRate; bRoth *= 1 + growRate;
    } else {
      bDef -= rmd;
      if (conversion > 0) { const cv = Math.min(conversion, bDef); bDef -= cv; bRoth += cv; conversion = cv; }
      const guaranteed = ss + pension + ev.in + annuityInc + disabilityInc;
      let W = Math.max(0, need - guaranteed - rmdHH), seq = sequenceWithdrawals(W, bTax, bDef, bRoth, basis, wOrder, wMode);
      for (let i = 0; i < 8; i++) {
        const tx = computeTax({ pension, qualDiv, deferredWithdrawal: seq.wDef + rmdHH + conversion, ss, ltcgRealized: seq.gain, filing: filingY, stateRate, inflFac, isWorking: false, seniors });
        const newW = Math.max(0, need - guaranteed - rmdHH + tx.total);
        seq = sequenceWithdrawals(newW, bTax, bDef, bRoth, basis, wOrder, wMode);
        if (Math.abs(newW - W) < 25) { W = newW; break; } W = newW;
      }
      taxes = computeTax({ pension, qualDiv, deferredWithdrawal: seq.wDef + rmdHH + conversion, ss, ltcgRealized: seq.gain, filing: filingY, stateRate, inflFac, isWorking: false, seniors });
      const before = bTax; bTax -= seq.wTax; if (before > 0) basis *= bTax / before; bDef -= seq.wDef; bRoth -= seq.wRoth;
      wT = seq.wTax + 0; wD = seq.wDef + rmdHH; wR = seq.wRoth; gain = seq.gain;
      bTax += qualDiv; basis += qualDiv;
      const surplus = guaranteed + rmdHH - need - taxes.total;
      if (surplus > 0) { leftover = surplus; if (sweepSurplus) { bTax += surplus; basis += surplus; } }   // guaranteed income beyond the need
      if (seq.shortfall > 1 && depletionAge === null) depletionAge = age;
      bTax *= 1 + growRate; bDef *= 1 + growRate; bRoth *= 1 + growRate;
    }
    eduBal *= 1 + growRate;                                            // 529/education savings grow with the market
    if (bTax < 0) bTax = 0; if (bDef < 0) bDef = 0; if (bRoth < 0) bRoth = 0; if (eduBal < 0) eduBal = 0;
    if (basis < 0) basis = 0; if (basis > bTax) basis = bTax;
    const portfolio = bTax + bDef + bRoth, totalDebt = debts.reduce((s, d) => s + d.bal, 0);
    if (portfolio <= 1 && retired && depletionAge === null) depletionAge = age;
    lifetimeTax += taxes.total; lifetimeFedTax += taxes.fed; lifetimeStateTax += taxes.state;
    Object.assign(row, {
      taxes: taxes.total, fed: taxes.fed, state: taxes.state, fica: taxes.fica, agi: taxes.agi,
      taxableIncome: taxes.taxableIncome, ordinaryTaxable: taxes.ordinaryTaxable, marginal: taxes.marginal, ssTaxable: taxes.ssTaxable,
      contribution: cPretax + cRoth + cTaxable + match, withdrawal: wT + wD + wR,
      wTax: wT, wDef: wD, wRoth: wR, bTax, bDef, bRoth, end: portfolio, debt: totalDebt,
      reStatic, eduStatic: eduBal, netWorth: portfolio + reStatic + eduBal - totalDebt, income: wages + otherInc + ss + pension + annuityInc + disabilityInc + ev.in + (anyWorking ? rmdHH : 0), annuity: annuityInc, disabilityInc, otherInc, evIn: ev.in, qcd: qcdAmt, rmdW: anyWorking ? rmdHH : 0,
      cPretax, cRoth, cTaxable, match, debtPay, evOut: evOutNet, goalOut: gOut, eduDraw,
      savedToAccounts: cPretax + cRoth + cTaxable, leftover, surplusInvested: sweepSurplus, wagesC, wagesS, ssC: rowSsC, ssS: rowSsS, cumTax: lifetimeTax
    });
    rows.push(row);
  }
  return { rows, endingBalance: rows.length ? rows[rows.length - 1].end : 0, depletionAge, lifetimeTax, lifetimeFedTax, lifetimeStateTax };
}

/* ----------------------------- Monte Carlo -------------------------------- */
function randNormal(mean, sd) {
  let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function monteCarlo(S, trials, ov) {
  trials = trials || 600;
  const A = S.assumptions;
  const pre = ov && ov.mean != null ? ov.mean : blendedPreReturn(S);
  const post = ov && ov.mean != null ? ov.mean : A.postReturn / 100;   // a portfolio override holds one allocation through retirement
  const volPre = ov && ov.vol != null ? ov.vol : (A.volatilityPre != null ? +A.volatilityPre : 12) / 100;
  const volPost = ov && ov.vol != null ? ov.vol : (A.volatilityPost != null ? +A.volatilityPost : 9) / 100;
  const sampler = retired => Math.max(-0.6, randNormal(retired ? post : pre, retired ? volPost : volPre));
  const base = simulate(S);
  const ages = base.rows.map(r => r.age);
  const lastAge = ages[ages.length - 1];
  const paths = []; let successes = 0; const deplAges = [];
  for (let i = 0; i < trials; i++) {
    const sim = simulate(S, { sampleReturn: sampler });
    if (sim.depletionAge == null) successes++;
    deplAges.push(sim.depletionAge == null ? lastAge + 1 : sim.depletionAge);
    paths.push(sim.rows.map(r => r.end));
  }
  const n = ages.length;
  const bandAt = pPct => {
    const idx = Math.min(trials - 1, Math.floor(trials * pPct));
    const out = [];
    for (let y = 0; y < n; y++) {
      const col = paths.map(p => p[y]).sort((a, b) => a - b);
      out.push(col[idx]);
    }
    return out;
  };
  const endings = paths.map(p => p[n - 1]).sort((a, b) => a - b);
  const q = pPct => endings[Math.floor(trials * pPct)] || 0;
  deplAges.sort((a, b) => a - b);
  const deplP10 = deplAges[Math.floor(trials * 0.10)];               // in the worst decile of markets, money lasts to this age
  return { trials, success: successes / trials, ages, lastAge,
    p10: bandAt(0.10), p50: bandAt(0.50), p90: bandAt(0.90),
    endP10: q(0.10), endP50: q(0.50), endP90: q(0.90), deplP10 };
}
function mcSignature(S) {
  return JSON.stringify([S.assumptions, S.household, S.income, S.expenses, S.savings, S.savingsSplit, S.assets, S.liabilities, S.events, S.goals, S.rothStrategy, S.debtStrategy, S.withdrawalStrategy, S.survivor, S.disability, S.pensionElection, S.charitableStrategy]);
}
const MC_MULTI = new Map();
function mcFor(S, trials) {
  const sig = mcSignature(S), hit = MC_MULTI.get(sig);
  if (hit) return hit;
  const r = monteCarlo(S, trials || 600);
  MC_MULTI.set(sig, r);
  if (MC_MULTI.size > 8) MC_MULTI.delete(MC_MULTI.keys().next().value);
  return r;
}
const getMonteCarlo = () => mcFor(STATE, 600);
/* Return cached MC immediately, or null and compute off-thread then call onReady to re-render. */
function mcAsync(onReady) {
  const sig = mcSignature(STATE), hit = MC_MULTI.get(sig);
  if (hit) return hit;
  setTimeout(() => { mcFor(STATE, 600); if (onReady) onReady(); }, 0);
  return null;
}

/* ============================ PORTFOLIO LAB ================================
   Ticker-level portfolios → expected return / volatility via asset-class
   capital-market assumptions and a correlation matrix — then Monte Carlo,
   standalone or driven through the client's full financial plan.
   These are long-run PLANNING assumptions (editable), not live market data. */
const ASSET_CLASSES = {
  usL:   { label: 'US Large Cap',        ret: 7.2, vol: 15.5 },
  usS:   { label: 'US Small / Mid',      ret: 7.7, vol: 19.5 },
  intl:  { label: 'Intl Developed',      ret: 7.5, vol: 16.5 },
  em:    { label: 'Emerging Markets',    ret: 7.8, vol: 21.0 },
  bond:  { label: 'Core Bonds',          ret: 4.6, vol: 5.5 },
  tsy:   { label: 'Treasuries / TIPS',   ret: 4.2, vol: 6.0 },
  hy:    { label: 'High Yield / Credit', ret: 6.3, vol: 9.0 },
  reit:  { label: 'Real Estate (REIT)',  ret: 6.8, vol: 18.5 },
  gold:  { label: 'Gold / Metals',       ret: 4.5, vol: 15.5 },
  cmd:   { label: 'Commodities',         ret: 4.8, vol: 16.0 },
  cash:  { label: 'Cash / T-Bills',      ret: 3.0, vol: 0.8 },
  bal:   { label: 'Balanced Fund',       ret: 6.2, vol: 10.0 },
  crypto:{ label: 'Crypto',              ret: 9.0, vol: 65.0 },
  custom:{ label: 'Custom / Other',      ret: 6.0, vol: 12.0 }
};
const CLS_CORR = {   // upper triangle; symmetric lookup below (planning-grade correlations)
  usL:  { usS: .92, intl: .85, em: .75, bond: .10, tsy: -.10, hy: .60, reit: .70, gold: .05, cmd: .30, cash: 0,   bal: .95, crypto: .40, custom: .60 },
  usS:  { intl: .80, em: .72, bond: .05, tsy: -.15, hy: .62, reit: .72, gold: .02, cmd: .30, cash: 0,   bal: .85, crypto: .40, custom: .60 },
  intl: { em: .85, bond: .10, tsy: -.05, hy: .55, reit: .60, gold: .10, cmd: .30, cash: 0,   bal: .80, crypto: .35, custom: .55 },
  em:   { bond: .05, tsy: -.05, hy: .55, reit: .55, gold: .15, cmd: .35, cash: 0,   bal: .70, crypto: .40, custom: .50 },
  bond: { tsy: .85, hy: .45, reit: .30, gold: .25, cmd: .05, cash: .20, bal: .50, crypto: .05, custom: .30 },
  tsy:  { hy: .20, reit: .20, gold: .30, cmd: 0,   cash: .25, bal: .30, crypto: 0,   custom: .20 },
  hy:   { reit: .55, gold: .10, cmd: .20, cash: .05, bal: .60, crypto: .25, custom: .45 },
  reit: { gold: .10, cmd: .20, cash: 0,   bal: .65, crypto: .30, custom: .50 },
  gold: { cmd: .45, cash: .05, bal: .10, crypto: .25, custom: .15 },
  cmd:  { cash: .05, bal: .30, crypto: .20, custom: .25 },
  cash: { bal: .05, crypto: 0, custom: .05 },
  bal:  { crypto: .30, custom: .60 },
  crypto: { custom: .30 }
};
const clsCorr = (a, b) => a === b ? 1 : (CLS_CORR[a] && CLS_CORR[a][b] != null ? CLS_CORR[a][b] : (CLS_CORR[b] && CLS_CORR[b][a] != null ? CLS_CORR[b][a] : .3));
/* Ticker → [class, name, volOverride?, retOverride?] — ~1075 symbols across major ETF families,
   Vanguard/Fidelity/Schwab/American/T. Rowe/PIMCO/DoubleLine mutual funds, S&P 500 large caps,
   popular growth names, and ADRs. Long-run planning assumptions, all editable per holding.
   Singles keep the class expected return — idiosyncratic risk is not rewarded, which is the meeting point. */
const TICKERS = {
  SPY: ['usL', 'SPDR S&P 500'],
  IVV: ['usL', 'iShares Core S&P 500'],
  VOO: ['usL', 'Vanguard S&P 500'],
  SPLG: ['usL', 'SPDR Portfolio S&P 500'],
  VTI: ['usL', 'Vanguard Total Market'],
  ITOT: ['usL', 'iShares Total Market'],
  SCHB: ['usL', 'Schwab Broad Market'],
  SPTM: ['usL', 'SPDR Total Market'],
  VV: ['usL', 'Vanguard Large-Cap'],
  SCHX: ['usL', 'Schwab Large-Cap'],
  MGC: ['usL', 'Vanguard Mega-Cap'],
  OEF: ['usL', 'iShares S&P 100'],
  QQQ: ['usL', 'Invesco Nasdaq-100', 20],
  QQQM: ['usL', 'Invesco Nasdaq-100', 20],
  ONEQ: ['usL', 'Fidelity Nasdaq Composite', 18],
  DIA: ['usL', 'SPDR Dow Jones', 14],
  RSP: ['usL', 'Invesco Equal-Weight S&P', 16],
  IWB: ['usL', 'iShares Russell 1000'],
  IWV: ['usL', 'iShares Russell 3000'],
  VONE: ['usL', 'Vanguard Russell 1000'],
  SPYG: ['usL', 'SPDR S&P 500 Growth', 17.5],
  SPYV: ['usL', 'SPDR S&P 500 Value', 14],
  VUG: ['usL', 'Vanguard Growth', 17.5],
  SCHG: ['usL', 'Schwab Growth', 17.5],
  IWF: ['usL', 'iShares Russell 1000 Growth', 17.5],
  MGK: ['usL', 'Vanguard Mega-Cap Growth', 18.5],
  VOOG: ['usL', 'Vanguard S&P 500 Growth', 17.5],
  VONG: ['usL', 'Vanguard Russell 1000 Growth', 17.5],
  VTV: ['usL', 'Vanguard Value', 14],
  SCHV: ['usL', 'Schwab Value', 14],
  IWD: ['usL', 'iShares Russell 1000 Value', 14],
  MGV: ['usL', 'Vanguard Mega-Cap Value', 13.5],
  VOOV: ['usL', 'Vanguard S&P 500 Value', 14],
  VONV: ['usL', 'Vanguard Russell 1000 Value', 14],
  RPG: ['usL', 'Invesco S&P 500 Pure Growth', 19],
  RPV: ['usL', 'Invesco S&P 500 Pure Value', 18],
  QUAL: ['usL', 'iShares Quality', 15],
  MTUM: ['usL', 'iShares Momentum', 17],
  VLUE: ['usL', 'iShares Value Factor', 16],
  SIZE: ['usL', 'iShares Size Factor', 16],
  USMV: ['usL', 'iShares Min Volatility', 12],
  SPLV: ['usL', 'Invesco Low Volatility', 12],
  SPHQ: ['usL', 'Invesco Quality', 15],
  MOAT: ['usL', 'VanEck Wide Moat', 16],
  COWZ: ['usL', 'Pacer US Cash Cows', 16],
  CALF: ['usL', 'Pacer US Small Cash Cows', 20],
  FNDX: ['usL', 'Schwab Fundamental Large', 15],
  PRF: ['usL', 'Invesco FTSE RAFI 1000', 15],
  IUSG: ['usL', 'iShares Core Growth', 17],
  IUSV: ['usL', 'iShares Core Value', 14],
  DFUS: ['usL', 'Dimensional US Equity'],
  DFAC: ['usL', 'Dimensional US Core'],
  AVUS: ['usL', 'Avantis US Equity'],
  QQEW: ['usL', 'First Trust Nasdaq-100 Equal', 18],
  FTEC: ['usL', 'Fidelity MSCI Tech', 21],
  IYY: ['usL', 'iShares Dow Jones US'],
  IWM: ['usS', 'iShares Russell 2000'],
  VB: ['usS', 'Vanguard Small-Cap'],
  SCHA: ['usS', 'Schwab Small-Cap'],
  VTWO: ['usS', 'Vanguard Russell 2000'],
  IJR: ['usS', 'iShares Core S&P Small'],
  VIOO: ['usS', 'Vanguard S&P Small-600'],
  SPSM: ['usS', 'SPDR Portfolio Small'],
  AVUV: ['usS', 'Avantis Small Value', 20],
  VBR: ['usS', 'Vanguard Small Value', 18.5],
  VBK: ['usS', 'Vanguard Small Growth', 21],
  IWN: ['usS', 'iShares Russell 2000 Value', 19],
  IWO: ['usS', 'iShares Russell 2000 Growth', 22],
  MDY: ['usS', 'SPDR Mid-Cap 400', 17.5],
  IJH: ['usS', 'iShares Core Mid-Cap', 17.5],
  VO: ['usS', 'Vanguard Mid-Cap', 17],
  SCHM: ['usS', 'Schwab Mid-Cap', 17],
  IWR: ['usS', 'iShares Russell Mid-Cap', 17],
  VOT: ['usS', 'Vanguard Mid Growth', 19],
  VOE: ['usS', 'Vanguard Mid Value', 16],
  XMHQ: ['usS', 'Invesco Mid Quality', 17],
  VXF: ['usS', 'Vanguard Extended Market', 19],
  DFAS: ['usS', 'Dimensional US Small'],
  SCHD: ['usL', 'Schwab US Dividend', 13.5],
  VYM: ['usL', 'Vanguard High Dividend', 13.5],
  VIG: ['usL', 'Vanguard Dividend Growth', 13.5],
  DVY: ['usL', 'iShares Select Dividend', 14],
  SDY: ['usL', 'SPDR Dividend Aristocrats', 14],
  NOBL: ['usL', 'ProShares Aristocrats', 14],
  HDV: ['usL', 'iShares Core High Dividend', 13.5],
  DGRO: ['usL', 'iShares Dividend Growth', 13.5],
  DGRW: ['usL', 'WisdomTree Quality Dividend', 14],
  FDVV: ['usL', 'Fidelity High Dividend', 14],
  SPYD: ['usL', 'SPDR Portfolio High Div', 14.5],
  SPHD: ['usL', 'Invesco High Div Low Vol', 13],
  DHS: ['usL', 'WisdomTree High Dividend', 13.5],
  FVD: ['usL', 'First Trust Value Line Div', 13.5],
  VXUS: ['intl', 'Vanguard Total Intl'],
  VEU: ['intl', 'Vanguard All-World ex-US'],
  IXUS: ['intl', 'iShares Total Intl'],
  VEA: ['intl', 'Vanguard Developed'],
  IEFA: ['intl', 'iShares Core EAFE'],
  EFA: ['intl', 'iShares MSCI EAFE'],
  SCHF: ['intl', 'Schwab Intl'],
  SPDW: ['intl', 'SPDR Developed'],
  IDEV: ['intl', 'iShares Core Intl Dev'],
  VGK: ['intl', 'Vanguard Europe'],
  IEUR: ['intl', 'iShares Core Europe'],
  EZU: ['intl', 'iShares Eurozone', 18],
  EWJ: ['intl', 'iShares Japan', 17],
  BBJP: ['intl', 'JPMorgan Japan', 17],
  DXJ: ['intl', 'WisdomTree Japan Hedged', 17],
  HEFA: ['intl', 'iShares Hedged EAFE', 13],
  EWU: ['intl', 'iShares UK', 17],
  EWG: ['intl', 'iShares Germany', 19],
  EWQ: ['intl', 'iShares France', 18],
  EWL: ['intl', 'iShares Switzerland', 16],
  EWC: ['intl', 'iShares Canada', 17],
  EWA: ['intl', 'iShares Australia', 19],
  EWY: ['intl', 'iShares South Korea', 24, 7.8],
  EWT: ['intl', 'iShares Taiwan', 22, 7.8],
  EWH: ['intl', 'iShares Hong Kong', 20],
  EWS: ['intl', 'iShares Singapore', 18],
  EFV: ['intl', 'iShares EAFE Value', 15.5],
  EFG: ['intl', 'iShares EAFE Growth', 17],
  SCZ: ['intl', 'iShares EAFE Small', 19],
  VSS: ['intl', 'Vanguard Intl Small', 19],
  GWX: ['intl', 'SPDR Intl Small', 19],
  DLS: ['intl', 'WisdomTree Intl Small Div', 18],
  IDV: ['intl', 'iShares Intl Select Div', 15.5],
  VYMI: ['intl', 'Vanguard Intl High Div', 15],
  VIGI: ['intl', 'Vanguard Intl Div Growth', 15.5],
  ACWI: ['intl', 'iShares MSCI ACWI', 15],
  VT: ['intl', 'Vanguard Total World', 15],
  ACWX: ['intl', 'iShares ACWI ex-US'],
  VWO: ['em', 'Vanguard Emerging Mkts'],
  IEMG: ['em', 'iShares Core EM'],
  EEM: ['em', 'iShares MSCI EM'],
  SCHE: ['em', 'Schwab EM'],
  SPEM: ['em', 'SPDR EM'],
  EMXC: ['em', 'iShares EM ex-China', 19],
  FRDM: ['em', 'Freedom 100 EM', 19],
  DEM: ['em', 'WisdomTree EM High Div', 19],
  MCHI: ['em', 'iShares China', 26],
  FXI: ['em', 'iShares China Large-Cap', 27],
  KWEB: ['em', 'KraneShares China Internet', 35],
  INDA: ['em', 'iShares India', 20],
  EPI: ['em', 'WisdomTree India', 21],
  SMIN: ['em', 'iShares India Small', 24],
  EWZ: ['em', 'iShares Brazil', 30],
  EWW: ['em', 'iShares Mexico', 25],
  ILF: ['em', 'iShares Latin America', 26],
  EZA: ['em', 'iShares South Africa', 27],
  TUR: ['em', 'iShares Turkey', 35],
  VNM: ['em', 'VanEck Vietnam', 27],
  EIDO: ['em', 'iShares Indonesia', 24],
  THD: ['em', 'iShares Thailand', 22],
  AGG: ['bond', 'iShares Core US Bond'],
  BND: ['bond', 'Vanguard Total Bond'],
  SCHZ: ['bond', 'Schwab US Bond'],
  SPAB: ['bond', 'SPDR Aggregate'],
  FBND: ['bond', 'Fidelity Total Bond', 5.5],
  BSV: ['bond', 'Vanguard Short-Term Bond', 3],
  BIV: ['bond', 'Vanguard Interm Bond', 6],
  BLV: ['bond', 'Vanguard Long Bond', 11],
  IUSB: ['bond', 'iShares Total USD Bond', 5.5],
  MBB: ['bond', 'iShares MBS', 4.5],
  VMBS: ['bond', 'Vanguard MBS', 4.5],
  GNMA: ['bond', 'iShares GNMA', 4.5],
  LQD: ['bond', 'iShares IG Corporate', 8],
  VCIT: ['bond', 'Vanguard Interm Corp', 6.5],
  VCSH: ['bond', 'Vanguard Short Corp', 3],
  VCLT: ['bond', 'Vanguard Long Corp', 11],
  IGSB: ['bond', 'iShares 1-5yr IG Corp', 3],
  IGIB: ['bond', 'iShares 5-10yr IG Corp', 6.5],
  USIG: ['bond', 'iShares Broad IG Corp', 7],
  SPIB: ['bond', 'SPDR Interm Corp', 5],
  FLOT: ['bond', 'iShares Floating Rate', 1.5, 4.6],
  FLRN: ['bond', 'SPDR Floating Rate', 1.5, 4.6],
  MUB: ['bond', 'iShares National Muni', 4.5, 3.9],
  VTEB: ['bond', 'Vanguard Tax-Exempt', 4.5, 3.9],
  TFI: ['bond', 'SPDR Muni', 4.5, 3.9],
  SUB: ['bond', 'iShares Short Muni', 2, 3.4],
  SHM: ['bond', 'SPDR Short Muni', 2, 3.4],
  HYD: ['bond', 'VanEck High-Yield Muni', 7, 4.6],
  BAB: ['bond', 'Invesco Build America', 7],
  BNDX: ['bond', 'Vanguard Intl Bond', 4.5],
  IAGG: ['bond', 'iShares Intl Aggregate', 4.5],
  BNDW: ['bond', 'Vanguard Total World Bond', 5],
  EMB: ['bond', 'iShares EM USD Bond', 9, 5.8],
  VWOB: ['bond', 'Vanguard EM Gov Bond', 9, 5.8],
  PCY: ['bond', 'Invesco EM Sovereign', 9.5, 5.8],
  EBND: ['bond', 'SPDR EM Local Bond', 11, 5.6],
  TLT: ['tsy', 'iShares 20+yr Treasury', 13],
  VGLT: ['tsy', 'Vanguard Long Treasury', 12],
  EDV: ['tsy', 'Vanguard Ext Duration', 20],
  ZROZ: ['tsy', 'PIMCO 25+yr Zero', 22],
  IEF: ['tsy', 'iShares 7-10yr Treasury', 7],
  VGIT: ['tsy', 'Vanguard Interm Treasury', 5],
  IEI: ['tsy', 'iShares 3-7yr Treasury', 4],
  SHY: ['tsy', 'iShares 1-3yr Treasury', 2],
  VGSH: ['tsy', 'Vanguard Short Treasury', 2],
  SCHO: ['tsy', 'Schwab Short Treasury', 2],
  SCHR: ['tsy', 'Schwab Interm Treasury', 5],
  GOVT: ['tsy', 'iShares US Treasury', 5],
  SHV: ['tsy', 'iShares Short Treasury', 0.8, 3.2],
  TLH: ['tsy', 'iShares 10-20yr Treasury', 10],
  SPTL: ['tsy', 'SPDR Long Treasury', 12],
  TIP: ['tsy', 'iShares TIPS', 6, 4.3],
  SCHP: ['tsy', 'Schwab TIPS', 6, 4.3],
  VTIP: ['tsy', 'Vanguard Short TIPS', 2.5, 4.1],
  STIP: ['tsy', 'iShares 0-5yr TIPS', 2.5, 4.1],
  LTPZ: ['tsy', 'PIMCO Long TIPS', 13, 4.5],
  HYG: ['hy', 'iShares High Yield'],
  JNK: ['hy', 'SPDR High Yield'],
  SHYG: ['hy', 'iShares 0-5yr HY', 6],
  SJNK: ['hy', 'SPDR Short HY', 6],
  USHY: ['hy', 'iShares Broad HY', 9],
  ANGL: ['hy', 'VanEck Fallen Angel', 9.5],
  FALN: ['hy', 'iShares Fallen Angels', 9.5],
  BKLN: ['hy', 'Invesco Senior Loan', 6, 5.6],
  SRLN: ['hy', 'SPDR Blackstone Loan', 6, 5.6],
  HYLB: ['hy', 'Xtrackers High Yield', 9],
  BIL: ['cash', 'SPDR 1-3mo T-Bill'],
  SGOV: ['cash', 'iShares 0-3mo Treasury'],
  USFR: ['cash', 'WisdomTree Floating Treasury'],
  TFLO: ['cash', 'iShares Treasury Floating'],
  CLIP: ['cash', 'Global X 1-3mo T-Bill'],
  VMFXX: ['cash', 'Vanguard Federal MMF'],
  VUSXX: ['cash', 'Vanguard Treasury MMF'],
  SPAXX: ['cash', 'Fidelity Government MMF'],
  SPRXX: ['cash', 'Fidelity Money Market'],
  FDRXX: ['cash', 'Fidelity Gov Cash Reserves'],
  SWVXX: ['cash', 'Schwab Value Advantage MMF'],
  SNVXX: ['cash', 'Schwab Government MMF'],
  XLK: ['usL', 'Tech Select SPDR', 21],
  VGT: ['usL', 'Vanguard Info Tech', 21],
  IYW: ['usL', 'iShares US Tech', 21],
  XLF: ['usL', 'Financials SPDR', 19],
  VFH: ['usL', 'Vanguard Financials', 19],
  KRE: ['usL', 'SPDR Regional Banks', 28],
  KBE: ['usL', 'SPDR Banks', 26],
  KBWB: ['usL', 'Invesco Bank', 26],
  IAI: ['usL', 'iShares Broker-Dealers', 24],
  XLV: ['usL', 'Health Care SPDR', 14],
  VHT: ['usL', 'Vanguard Health Care', 14],
  IYH: ['usL', 'iShares US Healthcare', 14],
  IBB: ['usL', 'iShares Biotech', 24],
  XBI: ['usL', 'SPDR Biotech', 30],
  IHI: ['usL', 'iShares Medical Devices', 17],
  IHE: ['usL', 'iShares Pharma', 16],
  XLE: ['usL', 'Energy SPDR', 22],
  VDE: ['usL', 'Vanguard Energy', 23],
  XOP: ['usL', 'SPDR Oil & Gas E&P', 32],
  OIH: ['usL', 'VanEck Oil Services', 33],
  AMLP: ['usL', 'Alerian MLP', 20, 7.5],
  MLPX: ['usL', 'Global X MLP Infra', 19, 7.3],
  XLI: ['usL', 'Industrials SPDR', 16],
  VIS: ['usL', 'Vanguard Industrials', 16],
  ITA: ['usL', 'iShares Aerospace & Defense', 18],
  PPA: ['usL', 'Invesco Aerospace', 17],
  XAR: ['usL', 'SPDR Aerospace', 20],
  IYT: ['usL', 'iShares Transportation', 20],
  JETS: ['usL', 'US Global Jets', 30],
  XLY: ['usL', 'Cons Discretionary SPDR', 18],
  VCR: ['usL', 'Vanguard Cons Disc', 18],
  XRT: ['usL', 'SPDR Retail', 24],
  IBUY: ['usL', 'Amplify Online Retail', 28],
  XLP: ['usL', 'Cons Staples SPDR', 12],
  VDC: ['usL', 'Vanguard Cons Staples', 12],
  IYK: ['usL', 'iShares Cons Staples', 12],
  XLU: ['usL', 'Utilities SPDR', 13],
  VPU: ['usL', 'Vanguard Utilities', 13],
  IDU: ['usL', 'iShares US Utilities', 13],
  XLB: ['usL', 'Materials SPDR', 17],
  VAW: ['usL', 'Vanguard Materials', 17],
  IYM: ['usL', 'iShares Basic Materials', 18],
  XLC: ['usL', 'Comm Services SPDR', 18],
  VOX: ['usL', 'Vanguard Comm Services', 18],
  SMH: ['usL', 'VanEck Semiconductor', 28],
  SOXX: ['usL', 'iShares Semiconductor', 28],
  XSD: ['usL', 'SPDR Semiconductor', 30],
  PSI: ['usL', 'Invesco Semiconductors', 29],
  IGV: ['usL', 'iShares Software', 26],
  WCLD: ['usL', 'WisdomTree Cloud', 32],
  SKYY: ['usL', 'First Trust Cloud', 28],
  CLOU: ['usL', 'Global X Cloud', 30],
  HACK: ['usL', 'Amplify Cybersecurity', 24],
  CIBR: ['usL', 'First Trust Cybersecurity', 24],
  BUG: ['usL', 'Global X Cybersecurity', 26],
  ARKK: ['usL', 'ARK Innovation', 38],
  ARKW: ['usL', 'ARK Next Gen Internet', 38],
  ARKG: ['usL', 'ARK Genomic', 38],
  ARKQ: ['usL', 'ARK Autonomous Tech', 32],
  ARKF: ['usL', 'ARK Fintech', 34],
  BOTZ: ['usL', 'Global X Robotics & AI', 26],
  ROBO: ['usL', 'ROBO Global Robotics', 24],
  IRBO: ['usL', 'iShares Robotics & AI', 26],
  AIQ: ['usL', 'Global X AI & Tech', 25],
  TAN: ['usL', 'Invesco Solar', 38],
  ICLN: ['usL', 'iShares Clean Energy', 30],
  PBW: ['usL', 'Invesco WilderHill Clean', 36],
  QCLN: ['usL', 'First Trust Clean Energy', 34],
  FAN: ['usL', 'First Trust Wind', 24],
  LIT: ['usL', 'Global X Lithium & Battery', 30],
  REMX: ['usL', 'VanEck Rare Earth', 34],
  URA: ['usL', 'Global X Uranium', 34],
  URNM: ['usL', 'Sprott Uranium Miners', 40],
  ESPO: ['usL', 'VanEck Video Gaming', 24],
  BETZ: ['usL', 'Roundhill Sports Betting', 30],
  MSOS: ['usL', 'AdvisorShares US Cannabis', 45],
  MJ: ['usL', 'Amplify Cannabis', 40],
  GRID: ['usL', 'First Trust Smart Grid', 22],
  PAVE: ['usL', 'Global X Infrastructure', 19],
  IFRA: ['usL', 'iShares US Infrastructure', 18],
  IGF: ['usL', 'iShares Global Infra', 15],
  MAGS: ['usL', 'Roundhill Magnificent Seven', 28],
  FFTY: ['usL', 'Innovator IBD 50', 28],
  SPMO: ['usL', 'Invesco S&P 500 Momentum', 18],
  VNQ: ['reit', 'Vanguard Real Estate'],
  SCHH: ['reit', 'Schwab US REIT'],
  IYR: ['reit', 'iShares US Real Estate'],
  XLRE: ['reit', 'Real Estate SPDR'],
  RWR: ['reit', 'SPDR DJ REIT'],
  USRT: ['reit', 'iShares Core US REIT'],
  FREL: ['reit', 'Fidelity Real Estate'],
  REZ: ['reit', 'iShares Residential', 19],
  VNQI: ['reit', 'Vanguard Global ex-US RE', 17],
  REET: ['reit', 'iShares Global REIT', 17],
  REM: ['reit', 'iShares Mortgage REIT', 24, 7.5],
  MORT: ['reit', 'VanEck Mortgage REIT', 24, 7.5],
  SRVR: ['reit', 'Pacer Data Center REIT', 20],
  GLD: ['gold', 'SPDR Gold'],
  IAU: ['gold', 'iShares Gold'],
  GLDM: ['gold', 'SPDR Gold MiniShares'],
  SGOL: ['gold', 'abrdn Gold'],
  SLV: ['gold', 'iShares Silver', 26],
  SIVR: ['gold', 'abrdn Silver', 26],
  PPLT: ['gold', 'abrdn Platinum', 24],
  PALL: ['gold', 'abrdn Palladium', 32],
  GDX: ['gold', 'VanEck Gold Miners', 32],
  GDXJ: ['gold', 'VanEck Junior Gold Miners', 38],
  SIL: ['gold', 'Global X Silver Miners', 36],
  RING: ['gold', 'iShares Gold Miners', 33],
  SILJ: ['gold', 'Amplify Junior Silver', 42],
  DBC: ['cmd', 'Invesco Commodity'],
  PDBC: ['cmd', 'Invesco Optimum Commodity'],
  GSG: ['cmd', 'iShares GSCI Commodity'],
  DJP: ['cmd', 'iPath Commodity', 15],
  USO: ['cmd', 'US Oil Fund', 32],
  BNO: ['cmd', 'US Brent Oil', 30],
  UNG: ['cmd', 'US Natural Gas', 52],
  DBA: ['cmd', 'Invesco Agriculture', 14],
  CORN: ['cmd', 'Teucrium Corn', 22],
  WEAT: ['cmd', 'Teucrium Wheat', 26],
  SOYB: ['cmd', 'Teucrium Soybean', 18],
  CANE: ['cmd', 'Teucrium Sugar', 24],
  MOO: ['cmd', 'VanEck Agribusiness', 18],
  COPX: ['cmd', 'Global X Copper Miners', 32],
  XME: ['cmd', 'SPDR Metals & Mining', 30],
  IBIT: ['crypto', 'iShares Bitcoin'],
  FBTC: ['crypto', 'Fidelity Bitcoin'],
  GBTC: ['crypto', 'Grayscale Bitcoin'],
  ARKB: ['crypto', 'ARK 21Shares Bitcoin'],
  BITB: ['crypto', 'Bitwise Bitcoin'],
  HODL: ['crypto', 'VanEck Bitcoin'],
  BRRR: ['crypto', 'Valkyrie Bitcoin'],
  BTCO: ['crypto', 'Invesco Bitcoin'],
  EZBC: ['crypto', 'Franklin Bitcoin'],
  BITO: ['crypto', 'ProShares Bitcoin Strategy'],
  ETHA: ['crypto', 'iShares Ethereum', 70],
  ETHE: ['crypto', 'Grayscale Ethereum', 70],
  ETHW: ['crypto', 'Bitwise Ethereum', 70],
  BITQ: ['crypto', 'Bitwise Crypto Industry', 55],
  JEPI: ['usL', 'JPMorgan Equity Premium', 11, 6.3],
  JEPQ: ['usL', 'JPMorgan Nasdaq Premium', 14, 6.6],
  DIVO: ['usL', 'Amplify CWP Dividend', 12, 6.5],
  QYLD: ['usL', 'Global X Nasdaq Covered Call', 13, 5.8],
  XYLD: ['usL', 'Global X S&P Covered Call', 12, 5.6],
  RYLD: ['usL', 'Global X Russell Covered Call', 13, 5.6],
  SVOL: ['usL', 'Simplify Volatility Premium', 15, 6],
  BUFR: ['usL', 'FT Vest Buffer', 9, 5.4],
  PUTW: ['usL', 'WisdomTree PutWrite', 11, 5.8],
  JAAA: ['hy', 'Janus AAA CLO', 2, 5.2],
  JBBB: ['hy', 'Janus BBB CLO', 5, 5.8],
  CLOZ: ['hy', 'Panagram BB CLO', 6, 6.3],
  TQQQ: ['usL', 'ProShares UltraPro QQQ 3x', 62, 9],
  QLD: ['usL', 'ProShares Ultra QQQ 2x', 42, 8.5],
  SSO: ['usL', 'ProShares Ultra S&P 2x', 32, 8.2],
  UPRO: ['usL', 'ProShares UltraPro S&P 3x', 48, 8.6],
  SPXL: ['usL', 'Direxion S&P 3x Bull', 48, 8.6],
  UDOW: ['usL', 'ProShares UltraPro Dow 3x', 42, 8.2],
  SOXL: ['usL', 'Direxion Semis 3x Bull', 85, 9],
  TECL: ['usL', 'Direxion Tech 3x Bull', 65, 9],
  TNA: ['usL', 'Direxion Small 3x Bull', 70, 8.5],
  FAS: ['usL', 'Direxion Financial 3x Bull', 58, 8],
  NVDL: ['usL', 'GraniteShares 2x NVDA', 90, 9],
  TSLL: ['usL', 'Direxion 2x TSLA', 95, 9],
  SH: ['usL', 'ProShares Short S&P', 15.5, -6],
  PSQ: ['usL', 'ProShares Short QQQ', 20, -6.5],
  SQQQ: ['usL', 'ProShares UltraPro Short QQQ', 60, -18],
  SDS: ['usL', 'ProShares UltraShort S&P', 31, -13],
  SPXU: ['usL', 'ProShares UltraPro Short S&P', 47, -19],
  SOXS: ['usL', 'Direxion Semis 3x Bear', 85, -25],
  TZA: ['usL', 'Direxion Small 3x Bear', 70, -22],
  UVXY: ['usL', 'ProShares Ultra VIX', 95, -35],
  VXX: ['usL', 'iPath VIX Short-Term', 60, -25],
  VFIAX: ['usL', 'Vanguard 500 Index Adm'],
  VFINX: ['usL', 'Vanguard 500 Index Inv'],
  VTSAX: ['usL', 'Vanguard Total Stock Adm'],
  VTSMX: ['usL', 'Vanguard Total Stock Inv'],
  VIGAX: ['usL', 'Vanguard Growth Index Adm', 17.5],
  VVIAX: ['usL', 'Vanguard Value Index Adm', 14],
  VLCAX: ['usL', 'Vanguard Large-Cap Adm'],
  VDIGX: ['usL', 'Vanguard Dividend Growth', 13.5],
  VDADX: ['usL', 'Vanguard Div Appreciation Adm', 13.5],
  VEIPX: ['usL', 'Vanguard Equity-Income', 13.5],
  VEIRX: ['usL', 'Vanguard Equity-Income Adm', 13.5],
  VHYAX: ['usL', 'Vanguard High Div Index Adm', 13.5],
  VQNPX: ['usL', 'Vanguard Growth & Income'],
  VGIAX: ['usL', 'Vanguard Growth & Income Adm'],
  VPMAX: ['usL', 'Vanguard PRIMECAP Adm', 17],
  VPMCX: ['usL', 'Vanguard PRIMECAP', 17],
  VPCCX: ['usL', 'Vanguard PRIMECAP Core', 16.5],
  VHCAX: ['usL', 'Vanguard Capital Opportunity Adm', 18],
  VWUSX: ['usL', 'Vanguard US Growth', 18.5],
  VWNDX: ['usL', 'Vanguard Windsor', 15.5],
  VWNEX: ['usL', 'Vanguard Windsor Adm', 15.5],
  VWNFX: ['usL', 'Vanguard Windsor II', 14.5],
  VWNAX: ['usL', 'Vanguard Windsor II Adm', 14.5],
  VGHCX: ['usL', 'Vanguard Health Care', 14.5],
  VGHAX: ['usL', 'Vanguard Health Care Adm', 14.5],
  VGENX: ['usL', 'Vanguard Energy', 23],
  VGELX: ['usL', 'Vanguard Energy Adm', 23],
  VGPMX: ['usL', 'Vanguard Global Capital Cycles', 24],
  VSEQX: ['usL', 'Vanguard Strategic Equity', 18],
  VTCLX: ['usL', 'Vanguard Tax-Managed Cap App'],
  VTMFX: ['usL', 'Vanguard Tax-Managed Balanced', 8.5, 5.8],
  VSMAX: ['usS', 'Vanguard Small-Cap Adm'],
  VSGAX: ['usS', 'Vanguard Small Growth Adm', 21],
  VSIAX: ['usS', 'Vanguard Small Value Adm', 18.5],
  VIMAX: ['usS', 'Vanguard Mid-Cap Adm', 17],
  VMGMX: ['usS', 'Vanguard Mid Growth Adm', 19],
  VMVAX: ['usS', 'Vanguard Mid Value Adm', 16],
  VEXAX: ['usS', 'Vanguard Extended Mkt Adm', 19],
  VSTCX: ['usS', 'Vanguard Strategic Small', 19],
  VEVFX: ['usS', 'Vanguard Explorer Value', 19],
  VEXPX: ['usS', 'Vanguard Explorer', 20],
  VTIAX: ['intl', 'Vanguard Total Intl Adm'],
  VGTSX: ['intl', 'Vanguard Total Intl Inv'],
  VTMGX: ['intl', 'Vanguard Developed Adm'],
  VFWAX: ['intl', 'Vanguard FTSE All-World ex-US Adm'],
  VTWAX: ['intl', 'Vanguard Total World Adm', 15],
  VHGEX: ['intl', 'Vanguard Global Equity', 15.5],
  VINEX: ['intl', 'Vanguard Intl Explorer', 19],
  VWIGX: ['intl', 'Vanguard Intl Growth', 19],
  VWILX: ['intl', 'Vanguard Intl Growth Adm', 19],
  VTRIX: ['intl', 'Vanguard Intl Value', 16],
  VEMAX: ['em', 'Vanguard EM Index Adm'],
  VEIEX: ['em', 'Vanguard EM Index Inv'],
  VBTLX: ['bond', 'Vanguard Total Bond Adm'],
  VBMFX: ['bond', 'Vanguard Total Bond Inv'],
  VBILX: ['bond', 'Vanguard Interm Bond Adm', 6],
  VBIRX: ['bond', 'Vanguard Short Bond Adm', 3],
  VBLAX: ['bond', 'Vanguard Long Bond Adm', 11],
  VFIDX: ['bond', 'Vanguard Interm IG Adm', 6],
  VFSUX: ['bond', 'Vanguard Short IG Adm', 3],
  VWITX: ['bond', 'Vanguard Interm Muni', 4.5, 3.9],
  VWIUX: ['bond', 'Vanguard Interm Muni Adm', 4.5, 3.9],
  VWLUX: ['bond', 'Vanguard Long Muni Adm', 6, 4.1],
  VMLUX: ['bond', 'Vanguard Ltd Muni Adm', 2, 3.4],
  VWALX: ['bond', 'Vanguard High-Yield Muni Adm', 7, 4.6],
  VWAHX: ['bond', 'Vanguard High-Yield Muni', 7, 4.6],
  VTABX: ['bond', 'Vanguard Total Intl Bond Adm', 4.5],
  VTAPX: ['bond', 'Vanguard Short TIPS Adm', 2.5, 4.1],
  VIPSX: ['bond', 'Vanguard Inflation-Protected', 6, 4.3],
  VAIPX: ['bond', 'Vanguard Inflation-Prot Adm', 6, 4.3],
  VWEHX: ['hy', 'Vanguard High-Yield Corp', 8],
  VWEAX: ['hy', 'Vanguard High-Yield Corp Adm', 8],
  VWELX: ['bal', 'Vanguard Wellington'],
  VWENX: ['bal', 'Vanguard Wellington Adm'],
  VWINX: ['bal', 'Vanguard Wellesley', 7],
  VWIAX: ['bal', 'Vanguard Wellesley Adm', 7],
  VGSTX: ['bal', 'Vanguard STAR'],
  VBIAX: ['bal', 'Vanguard Balanced Index', 9.5],
  VASGX: ['bal', 'Vanguard LifeStrategy Growth', 12.5, 6.7],
  VSMGX: ['bal', 'Vanguard LifeStrategy Moderate', 10, 6.2],
  VSCGX: ['bal', 'Vanguard LifeStrategy Conservative', 7.5, 5.6],
  VASIX: ['bal', 'Vanguard LifeStrategy Income', 5.5, 5.1],
  VTINX: ['bal', 'Vanguard Target Retirement Income', 6.5, 5.4],
  VTWNX: ['bal', 'Vanguard Target 2020', 8, 5.8],
  VTTVX: ['bal', 'Vanguard Target 2025', 9, 6],
  VTHRX: ['bal', 'Vanguard Target 2030', 10.5, 6.3],
  VTTHX: ['bal', 'Vanguard Target 2035', 11.5, 6.5],
  VFORX: ['bal', 'Vanguard Target 2040', 12.5, 6.7],
  VTIVX: ['bal', 'Vanguard Target 2045', 13.5, 6.9],
  VFIFX: ['bal', 'Vanguard Target 2050', 14, 7],
  VFFVX: ['bal', 'Vanguard Target 2055', 14, 7],
  VTTSX: ['bal', 'Vanguard Target 2060', 14, 7],
  VLXVX: ['bal', 'Vanguard Target 2065', 14, 7],
  VSVNX: ['bal', 'Vanguard Target 2070', 14, 7],
  VGSLX: ['reit', 'Vanguard REIT Index Adm'],
  VGSIX: ['reit', 'Vanguard REIT Index Inv'],
  FXAIX: ['usL', 'Fidelity 500 Index'],
  FNILX: ['usL', 'Fidelity ZERO Large Cap'],
  FZROX: ['usL', 'Fidelity ZERO Total Market'],
  FSKAX: ['usL', 'Fidelity Total Market'],
  FCNTX: ['usL', 'Fidelity Contrafund', 17],
  FCNKX: ['usL', 'Fidelity Contrafund K', 17],
  FMAGX: ['usL', 'Fidelity Magellan', 17],
  FDGRX: ['usL', 'Fidelity Growth Company', 20],
  FBGRX: ['usL', 'Fidelity Blue Chip Growth', 19],
  FOCPX: ['usL', 'Fidelity OTC', 20],
  FTRNX: ['usL', 'Fidelity Trend', 18],
  FDCAX: ['usL', 'Fidelity Capital Appreciation', 17],
  FGRIX: ['usL', 'Fidelity Growth & Income', 14.5],
  FEQIX: ['usL', 'Fidelity Equity-Income', 14],
  FDVLX: ['usL', 'Fidelity Value', 16],
  FLPSX: ['usL', 'Fidelity Low-Priced Stock', 15.5],
  FDEQX: ['usL', 'Fidelity Disciplined Equity', 15.5],
  FLCSX: ['usL', 'Fidelity Large Cap Stock', 15.5],
  FSPGX: ['usL', 'Fidelity Large Growth Index', 17.5],
  FLCOX: ['usL', 'Fidelity Large Value Index', 14],
  FSCSX: ['usL', 'Fidelity Software', 26],
  FSELX: ['usL', 'Fidelity Semiconductors', 30],
  FSPTX: ['usL', 'Fidelity Technology', 24],
  FSPHX: ['usL', 'Fidelity Health Care', 18],
  FSMEX: ['usL', 'Fidelity Medical Tech', 19],
  FSRPX: ['usL', 'Fidelity Retailing', 20],
  FSUTX: ['usL', 'Fidelity Utilities', 13],
  FSENX: ['usL', 'Fidelity Energy', 24],
  FSAGX: ['usL', 'Fidelity Gold', 32],
  FSDAX: ['usL', 'Fidelity Defense', 18],
  FSSNX: ['usS', 'Fidelity Small Cap Index'],
  FSMDX: ['usS', 'Fidelity Mid Cap Index', 17],
  FSMAX: ['usS', 'Fidelity Extended Market', 19],
  FCPGX: ['usS', 'Fidelity Small Cap Growth', 21],
  FSLCX: ['usS', 'Fidelity Small Cap Stock', 19],
  FZILX: ['intl', 'Fidelity ZERO Intl'],
  FTIHX: ['intl', 'Fidelity Total Intl'],
  FSPSX: ['intl', 'Fidelity Intl Index'],
  FIGFX: ['intl', 'Fidelity Intl Growth', 17],
  FDIVX: ['intl', 'Fidelity Diversified Intl', 17],
  FOSFX: ['intl', 'Fidelity Overseas', 17],
  FPADX: ['em', 'Fidelity EM Index'],
  FEMKX: ['em', 'Fidelity Emerging Markets', 21],
  FXNAX: ['bond', 'Fidelity US Bond Index'],
  FTBFX: ['bond', 'Fidelity Total Bond'],
  FBNDX: ['bond', 'Fidelity Investment Grade'],
  FUAMX: ['bond', 'Fidelity Interm Treasury Index', 5],
  FUMBX: ['bond', 'Fidelity Short Treasury Index', 2],
  FNBGX: ['bond', 'Fidelity Long Treasury Index', 12],
  FIPDX: ['bond', 'Fidelity TIPS Index', 6, 4.3],
  FGMNX: ['bond', 'Fidelity GNMA', 4.5],
  FTABX: ['bond', 'Fidelity Tax-Free Bond', 5, 4],
  SPHIX: ['hy', 'Fidelity High Income', 8.5],
  FAGIX: ['hy', 'Fidelity Capital & Income', 9.5],
  FFRHX: ['hy', 'Fidelity Floating Rate', 5, 5.4],
  FBALX: ['bal', 'Fidelity Balanced', 10.5],
  FPURX: ['bal', 'Fidelity Puritan', 10.5],
  FDEWX: ['bal', 'Fidelity Freedom Index 2055', 14, 7],
  FIPFX: ['bal', 'Fidelity Freedom Index 2050', 14, 7],
  SWPPX: ['usL', 'Schwab S&P 500'],
  SWTSX: ['usL', 'Schwab Total Market'],
  SWLGX: ['usL', 'Schwab US Large Growth', 17.5],
  SNXFX: ['usL', 'Schwab 1000'],
  SWSSX: ['usS', 'Schwab Small-Cap'],
  SWISX: ['intl', 'Schwab Intl Index'],
  SWAGX: ['bond', 'Schwab US Aggregate'],
  AGTHX: ['usL', 'American Growth Fund', 17],
  AMCPX: ['usL', 'American AMCAP', 16.5],
  ANCFX: ['usL', 'American Fundamental Inv', 15.5],
  AWSHX: ['usL', 'American Washington Mutual', 14.5],
  AIVSX: ['usL', 'American Inv Co of America', 15],
  AMRMX: ['usL', 'American Mutual', 13.5],
  ANEFX: ['usL', 'American New Economy', 17.5],
  AEPGX: ['intl', 'American EuroPacific Growth', 17],
  ANWPX: ['intl', 'American New Perspective', 16],
  SMCWX: ['intl', 'American SMALLCAP World', 19],
  NEWFX: ['intl', 'American New World', 18],
  CWGIX: ['intl', 'American Capital World G&I', 15.5],
  ABALX: ['bal', 'American Balanced'],
  AMECX: ['bal', 'American Income Fund', 9],
  CAIBX: ['bal', 'American Capital Income Builder', 9.5],
  ABNDX: ['bond', 'American Bond Fund', 5.5],
  AIBAX: ['bond', 'American Interm Bond', 3.5],
  AHITX: ['hy', 'American High-Income Trust', 9],
  PRGFX: ['usL', 'T Rowe Growth Stock', 18],
  TRBCX: ['usL', 'T Rowe Blue Chip', 18],
  PRDGX: ['usL', 'T Rowe Dividend Growth', 13.5],
  PRFDX: ['usL', 'T Rowe Equity Income', 14],
  PRNHX: ['usL', 'T Rowe New Horizons', 21],
  PRMTX: ['usL', 'T Rowe Comm & Tech', 22],
  PRHSX: ['usL', 'T Rowe Health Sciences', 19],
  TRMCX: ['usL', 'T Rowe Mid Value', 16],
  RPMGX: ['usL', 'T Rowe Mid Growth', 18],
  PRWCX: ['bal', 'T Rowe Capital Appreciation', 10.5],
  RPBAX: ['bal', 'T Rowe Balanced', 10],
  PTTRX: ['bond', 'PIMCO Total Return Instl', 6],
  PTTAX: ['bond', 'PIMCO Total Return A', 6],
  PFORX: ['bond', 'PIMCO Foreign Bond Hedged', 5],
  DBLTX: ['bond', 'DoubleLine Total Return', 5],
  DLTNX: ['bond', 'DoubleLine Total Return N', 5],
  MWTRX: ['bond', 'Met West Total Return M', 5.5],
  MWTIX: ['bond', 'Met West Total Return I', 5.5],
  DODIX: ['bond', 'Dodge & Cox Income', 5.5],
  BAGIX: ['bond', 'Baird Aggregate', 5.5],
  BCOIX: ['bond', 'Baird Core Plus', 5.5],
  LSBDX: ['bond', 'Loomis Sayles Bond', 7.5],
  PONAX: ['bond', 'PIMCO Income A', 7],
  PIMIX: ['bond', 'PIMCO Income Instl', 7],
  DODGX: ['usL', 'Dodge & Cox Stock', 16],
  OAKMX: ['usL', 'Oakmark Fund', 16],
  NYVTX: ['usL', 'Davis NY Venture', 16],
  SEQUX: ['usL', 'Sequoia Fund', 16],
  FAIRX: ['usL', 'Fairholme Fund', 22],
  PRBLX: ['usL', 'Parnassus Core Equity', 14],
  ARGFX: ['usL', 'Ariel Fund', 18],
  BGRFX: ['usL', 'Baron Growth', 18],
  BPTRX: ['usL', 'Baron Partners', 30],
  HACAX: ['usL', 'Harbor Capital Appreciation', 19],
  POGRX: ['usL', 'PRIMECAP Odyssey Growth', 18],
  POSKX: ['usL', 'PRIMECAP Odyssey Stock', 16],
  POAGX: ['usL', 'PRIMECAP Odyssey Aggressive', 20],
  FPACX: ['usL', 'FPA Crescent', 11],
  DODFX: ['intl', 'Dodge & Cox Intl', 17],
  OAKIX: ['intl', 'Oakmark Intl', 18],
  DODWX: ['intl', 'Dodge & Cox Global', 16],
  DODBX: ['bal', 'Dodge & Cox Balanced', 10.5],
  OAKBX: ['bal', 'Oakmark Equity & Income', 10],
  MALOX: ['bal', 'BlackRock Global Allocation', 10],
  MDLOX: ['bal', 'BlackRock Global Alloc A', 10],
  JABAX: ['bal', 'Janus Balanced', 10],
  FKINX: ['bal', 'Franklin Income A', 8, 5.6],
  TPINX: ['bond', 'Templeton Global Bond', 7, 4.8],
  AAPL: ['usL', 'Apple', 28],
  MSFT: ['usL', 'Microsoft', 26],
  NVDA: ['usL', 'NVIDIA', 45],
  GOOGL: ['usL', 'Alphabet A', 28],
  GOOG: ['usL', 'Alphabet C', 28],
  AMZN: ['usL', 'Amazon', 30],
  META: ['usL', 'Meta Platforms', 35],
  TSLA: ['usL', 'Tesla', 55],
  AVGO: ['usL', 'Broadcom', 38],
  ORCL: ['usL', 'Oracle', 28],
  CRM: ['usL', 'Salesforce', 32],
  ADBE: ['usL', 'Adobe', 30],
  NFLX: ['usL', 'Netflix', 35],
  AMD: ['usL', 'AMD', 48],
  INTC: ['usL', 'Intel', 38],
  QCOM: ['usL', 'Qualcomm', 32],
  TXN: ['usL', 'Texas Instruments', 26],
  MU: ['usL', 'Micron', 42],
  AMAT: ['usL', 'Applied Materials', 34],
  LRCX: ['usL', 'Lam Research', 35],
  KLAC: ['usL', 'KLA Corp', 33],
  ADI: ['usL', 'Analog Devices', 28],
  NXPI: ['usL', 'NXP Semi', 32],
  MRVL: ['usL', 'Marvell', 42],
  ON: ['usL', 'ON Semi', 40],
  MCHP: ['usL', 'Microchip', 34],
  TSM: ['usL', 'Taiwan Semiconductor', 32],
  ASML: ['usL', 'ASML Holding', 34],
  ARM: ['usL', 'Arm Holdings', 48],
  SMCI: ['usL', 'Super Micro', 65],
  DELL: ['usL', 'Dell Technologies', 35],
  HPQ: ['usL', 'HP Inc', 26],
  HPE: ['usL', 'HP Enterprise', 28],
  IBM: ['usL', 'IBM', 20],
  ACN: ['usL', 'Accenture', 22],
  CSCO: ['usL', 'Cisco', 20],
  ANET: ['usL', 'Arista Networks', 35],
  PANW: ['usL', 'Palo Alto Networks', 32],
  CRWD: ['usL', 'CrowdStrike', 40],
  ZS: ['usL', 'Zscaler', 42],
  FTNT: ['usL', 'Fortinet', 32],
  OKTA: ['usL', 'Okta', 40],
  NET: ['usL', 'Cloudflare', 45],
  DDOG: ['usL', 'Datadog', 40],
  SNOW: ['usL', 'Snowflake', 45],
  MDB: ['usL', 'MongoDB', 45],
  PLTR: ['usL', 'Palantir', 50],
  NOW: ['usL', 'ServiceNow', 30],
  WDAY: ['usL', 'Workday', 30],
  TEAM: ['usL', 'Atlassian', 40],
  SHOP: ['usL', 'Shopify', 45],
  SQ: ['usL', 'Block', 45],
  PYPL: ['usL', 'PayPal', 32],
  INTU: ['usL', 'Intuit', 26],
  ADSK: ['usL', 'Autodesk', 28],
  SNPS: ['usL', 'Synopsys', 28],
  CDNS: ['usL', 'Cadence Design', 28],
  ROP: ['usL', 'Roper', 20],
  UBER: ['usL', 'Uber', 34],
  LYFT: ['usL', 'Lyft', 48],
  ABNB: ['usL', 'Airbnb', 34],
  DASH: ['usL', 'DoorDash', 38],
  SPOT: ['usL', 'Spotify', 35],
  RBLX: ['usL', 'Roblox', 45],
  PINS: ['usL', 'Pinterest', 38],
  SNAP: ['usL', 'Snap', 50],
  ROKU: ['usL', 'Roku', 50],
  TTD: ['usL', 'Trade Desk', 40],
  APP: ['usL', 'AppLovin', 50],
  U: ['usL', 'Unity Software', 50],
  SOFI: ['usL', 'SoFi', 50],
  HOOD: ['usL', 'Robinhood', 50],
  COIN: ['usL', 'Coinbase', 60],
  MSTR: ['usL', 'MicroStrategy', 75],
  GME: ['usL', 'GameStop', 70],
  AMC: ['usL', 'AMC Entertainment', 75],
  T: ['usL', 'AT&T', 20],
  VZ: ['usL', 'Verizon', 18],
  TMUS: ['usL', 'T-Mobile', 20],
  CMCSA: ['usL', 'Comcast', 22],
  DIS: ['usL', 'Disney', 26],
  WBD: ['usL', 'Warner Bros Discovery', 38],
  PARA: ['usL', 'Paramount', 40],
  EA: ['usL', 'Electronic Arts', 24],
  TTWO: ['usL', 'Take-Two', 28],
  LYV: ['usL', 'Live Nation', 28],
  'BRK.B': ['usL', 'Berkshire Hathaway', 20],
  JPM: ['usL', 'JPMorgan', 24],
  BAC: ['usL', 'Bank of America', 26],
  WFC: ['usL', 'Wells Fargo', 26],
  C: ['usL', 'Citigroup', 28],
  GS: ['usL', 'Goldman Sachs', 27],
  MS: ['usL', 'Morgan Stanley', 27],
  SCHW: ['usL', 'Charles Schwab', 28],
  USB: ['usL', 'US Bancorp', 25],
  PNC: ['usL', 'PNC Financial', 25],
  TFC: ['usL', 'Truist', 26],
  COF: ['usL', 'Capital One', 30],
  AXP: ['usL', 'American Express', 25],
  V: ['usL', 'Visa', 22],
  MA: ['usL', 'Mastercard', 22],
  BLK: ['usL', 'BlackRock', 24],
  BX: ['usL', 'Blackstone', 32],
  KKR: ['usL', 'KKR', 32],
  APO: ['usL', 'Apollo Global', 32],
  ARES: ['usL', 'Ares Management', 30],
  SPGI: ['usL', 'S&P Global', 22],
  MCO: ['usL', 'Moodys', 24],
  MSCI: ['usL', 'MSCI Inc', 26],
  ICE: ['usL', 'Intercontinental Exch', 20],
  CME: ['usL', 'CME Group', 20],
  NDAQ: ['usL', 'Nasdaq Inc', 22],
  CBOE: ['usL', 'Cboe Global', 20],
  AIG: ['usL', 'AIG', 24],
  MET: ['usL', 'MetLife', 24],
  PRU: ['usL', 'Prudential', 24],
  AFL: ['usL', 'Aflac', 20],
  ALL: ['usL', 'Allstate', 20],
  TRV: ['usL', 'Travelers', 18],
  PGR: ['usL', 'Progressive', 20],
  CB: ['usL', 'Chubb', 18],
  MMC: ['usL', 'Marsh McLennan', 17],
  AON: ['usL', 'Aon', 18],
  AJG: ['usL', 'Arthur J Gallagher', 18],
  BRO: ['usL', 'Brown & Brown', 18],
  HIG: ['usL', 'Hartford', 20],
  FI: ['usL', 'Fiserv', 22],
  FIS: ['usL', 'Fidelity National Info', 26],
  GPN: ['usL', 'Global Payments', 30],
  SYF: ['usL', 'Synchrony', 30],
  DFS: ['usL', 'Discover', 30],
  ALLY: ['usL', 'Ally Financial', 32],
  UNH: ['usL', 'UnitedHealth', 26],
  JNJ: ['usL', 'Johnson & Johnson', 17],
  LLY: ['usL', 'Eli Lilly', 30],
  PFE: ['usL', 'Pfizer', 24],
  MRK: ['usL', 'Merck', 22],
  ABBV: ['usL', 'AbbVie', 24],
  BMY: ['usL', 'Bristol-Myers', 22],
  AMGN: ['usL', 'Amgen', 22],
  GILD: ['usL', 'Gilead', 22],
  BIIB: ['usL', 'Biogen', 30],
  REGN: ['usL', 'Regeneron', 28],
  VRTX: ['usL', 'Vertex Pharma', 28],
  MRNA: ['usL', 'Moderna', 48],
  BNTX: ['usL', 'BioNTech', 45],
  TMO: ['usL', 'Thermo Fisher', 22],
  DHR: ['usL', 'Danaher', 22],
  ABT: ['usL', 'Abbott Labs', 18],
  MDT: ['usL', 'Medtronic', 18],
  SYK: ['usL', 'Stryker', 20],
  BSX: ['usL', 'Boston Scientific', 20],
  EW: ['usL', 'Edwards Lifesciences', 26],
  ISRG: ['usL', 'Intuitive Surgical', 28],
  DXCM: ['usL', 'Dexcom', 38],
  ZBH: ['usL', 'Zimmer Biomet', 22],
  BDX: ['usL', 'Becton Dickinson', 17],
  CI: ['usL', 'Cigna', 22],
  ELV: ['usL', 'Elevance', 22],
  HUM: ['usL', 'Humana', 26],
  CVS: ['usL', 'CVS Health', 24],
  MCK: ['usL', 'McKesson', 20],
  CAH: ['usL', 'Cardinal Health', 20],
  COR: ['usL', 'Cencora', 18],
  HCA: ['usL', 'HCA Healthcare', 24],
  ZTS: ['usL', 'Zoetis', 22],
  IQV: ['usL', 'IQVIA', 24],
  A: ['usL', 'Agilent', 24],
  RMD: ['usL', 'ResMed', 26],
  IDXX: ['usL', 'IDEXX Labs', 28],
  WST: ['usL', 'West Pharma', 26],
  ALGN: ['usL', 'Align Tech', 38],
  WMT: ['usL', 'Walmart', 18],
  COST: ['usL', 'Costco', 20],
  TGT: ['usL', 'Target', 26],
  HD: ['usL', 'Home Depot', 22],
  LOW: ['usL', 'Lowes', 24],
  PG: ['usL', 'Procter & Gamble', 16],
  KO: ['usL', 'Coca-Cola', 16],
  PEP: ['usL', 'PepsiCo', 16],
  PM: ['usL', 'Philip Morris', 20],
  MO: ['usL', 'Altria', 20],
  CL: ['usL', 'Colgate', 15],
  KMB: ['usL', 'Kimberly-Clark', 15],
  GIS: ['usL', 'General Mills', 15],
  K: ['usL', 'Kellanova', 15],
  HSY: ['usL', 'Hershey', 18],
  KHC: ['usL', 'Kraft Heinz', 18],
  MDLZ: ['usL', 'Mondelez', 16],
  STZ: ['usL', 'Constellation Brands', 20],
  'BF.B': ['usL', 'Brown-Forman', 20],
  TAP: ['usL', 'Molson Coors', 22],
  KR: ['usL', 'Kroger', 20],
  SYY: ['usL', 'Sysco', 18],
  ADM: ['usL', 'Archer-Daniels', 20],
  TSN: ['usL', 'Tyson Foods', 22],
  CAG: ['usL', 'Conagra', 16],
  CPB: ['usL', 'Campbells', 16],
  CHD: ['usL', 'Church & Dwight', 15],
  CLX: ['usL', 'Clorox', 17],
  EL: ['usL', 'Estee Lauder', 30],
  MCD: ['usL', 'McDonalds', 18],
  SBUX: ['usL', 'Starbucks', 24],
  CMG: ['usL', 'Chipotle', 28],
  YUM: ['usL', 'Yum Brands', 18],
  QSR: ['usL', 'Restaurant Brands', 20],
  DPZ: ['usL', 'Dominos', 24],
  DRI: ['usL', 'Darden', 20],
  WING: ['usL', 'Wingstop', 35],
  CAVA: ['usL', 'CAVA Group', 45],
  NKE: ['usL', 'Nike', 26],
  LULU: ['usL', 'Lululemon', 32],
  DECK: ['usL', 'Deckers', 32],
  ONON: ['usL', 'On Holding', 40],
  SKX: ['usL', 'Skechers', 28],
  VFC: ['usL', 'VF Corp', 35],
  RL: ['usL', 'Ralph Lauren', 26],
  TPR: ['usL', 'Tapestry', 30],
  TJX: ['usL', 'TJX Companies', 18],
  ROST: ['usL', 'Ross Stores', 20],
  BURL: ['usL', 'Burlington', 30],
  DG: ['usL', 'Dollar General', 28],
  DLTR: ['usL', 'Dollar Tree', 30],
  FIVE: ['usL', 'Five Below', 35],
  ULTA: ['usL', 'Ulta Beauty', 28],
  BBY: ['usL', 'Best Buy', 28],
  DKS: ['usL', 'Dicks Sporting', 28],
  W: ['usL', 'Wayfair', 50],
  ETSY: ['usL', 'Etsy', 45],
  EBAY: ['usL', 'eBay', 26],
  CHWY: ['usL', 'Chewy', 40],
  CVNA: ['usL', 'Carvana', 65],
  KMX: ['usL', 'CarMax', 32],
  AN: ['usL', 'AutoNation', 28],
  ORLY: ['usL', 'OReilly Auto', 20],
  AZO: ['usL', 'AutoZone', 20],
  AAP: ['usL', 'Advance Auto', 32],
  GPC: ['usL', 'Genuine Parts', 18],
  F: ['usL', 'Ford', 32],
  GM: ['usL', 'General Motors', 30],
  RIVN: ['usL', 'Rivian', 60],
  LCID: ['usL', 'Lucid', 65],
  NKLA: ['usL', 'Nikola', 80],
  MAR: ['usL', 'Marriott', 24],
  HLT: ['usL', 'Hilton', 24],
  H: ['usL', 'Hyatt', 26],
  RCL: ['usL', 'Royal Caribbean', 40],
  CCL: ['usL', 'Carnival', 45],
  NCLH: ['usL', 'Norwegian Cruise', 45],
  LVS: ['usL', 'Las Vegas Sands', 30],
  WYNN: ['usL', 'Wynn Resorts', 32],
  MGM: ['usL', 'MGM Resorts', 30],
  CZR: ['usL', 'Caesars', 40],
  DKNG: ['usL', 'DraftKings', 45],
  PENN: ['usL', 'PENN Entertainment', 45],
  DAL: ['usL', 'Delta Air Lines', 35],
  UAL: ['usL', 'United Airlines', 38],
  AAL: ['usL', 'American Airlines', 42],
  LUV: ['usL', 'Southwest', 30],
  ALK: ['usL', 'Alaska Air', 35],
  BKNG: ['usL', 'Booking Holdings', 26],
  EXPE: ['usL', 'Expedia', 32],
  TRIP: ['usL', 'TripAdvisor', 38],
  CAT: ['usL', 'Caterpillar', 24],
  DE: ['usL', 'Deere', 24],
  HON: ['usL', 'Honeywell', 18],
  GE: ['usL', 'GE Aerospace', 24],
  MMM: ['usL', '3M', 20],
  EMR: ['usL', 'Emerson', 20],
  ETN: ['usL', 'Eaton', 24],
  PH: ['usL', 'Parker Hannifin', 24],
  ITW: ['usL', 'Illinois Tool Works', 18],
  CMI: ['usL', 'Cummins', 24],
  PCAR: ['usL', 'PACCAR', 24],
  LMT: ['usL', 'Lockheed Martin', 18],
  RTX: ['usL', 'RTX Corp', 20],
  NOC: ['usL', 'Northrop Grumman', 18],
  GD: ['usL', 'General Dynamics', 17],
  BA: ['usL', 'Boeing', 35],
  LHX: ['usL', 'L3Harris', 18],
  HII: ['usL', 'Huntington Ingalls', 20],
  TDG: ['usL', 'TransDigm', 24],
  HWM: ['usL', 'Howmet', 26],
  AXON: ['usL', 'Axon', 38],
  UPS: ['usL', 'UPS', 22],
  FDX: ['usL', 'FedEx', 26],
  UNP: ['usL', 'Union Pacific', 20],
  CSX: ['usL', 'CSX', 20],
  NSC: ['usL', 'Norfolk Southern', 22],
  ODFL: ['usL', 'Old Dominion', 26],
  JBHT: ['usL', 'JB Hunt', 24],
  CHRW: ['usL', 'CH Robinson', 24],
  WM: ['usL', 'Waste Management', 15],
  RSG: ['usL', 'Republic Services', 15],
  URI: ['usL', 'United Rentals', 30],
  FAST: ['usL', 'Fastenal', 20],
  GWW: ['usL', 'Grainger', 20],
  PWR: ['usL', 'Quanta Services', 26],
  J: ['usL', 'Jacobs', 20],
  EME: ['usL', 'EMCOR', 26],
  XOM: ['usL', 'Exxon Mobil', 26],
  CVX: ['usL', 'Chevron', 25],
  COP: ['usL', 'ConocoPhillips', 28],
  EOG: ['usL', 'EOG Resources', 30],
  SLB: ['usL', 'Schlumberger', 32],
  HAL: ['usL', 'Halliburton', 34],
  BKR: ['usL', 'Baker Hughes', 30],
  OXY: ['usL', 'Occidental', 34],
  PSX: ['usL', 'Phillips 66', 28],
  VLO: ['usL', 'Valero', 30],
  MPC: ['usL', 'Marathon Petroleum', 30],
  PXD: ['usL', 'Pioneer Natural', 30],
  DVN: ['usL', 'Devon Energy', 34],
  FANG: ['usL', 'Diamondback', 32],
  HES: ['usL', 'Hess', 30],
  KMI: ['usL', 'Kinder Morgan', 20, 7.4],
  WMB: ['usL', 'Williams Companies', 20, 7.4],
  OKE: ['usL', 'ONEOK', 22, 7.4],
  ET: ['usL', 'Energy Transfer', 22, 7.6],
  EPD: ['usL', 'Enterprise Products', 18, 7.5],
  LNG: ['usL', 'Cheniere', 28],
  TRGP: ['usL', 'Targa Resources', 28],
  FSLR: ['usL', 'First Solar', 40],
  ENPH: ['usL', 'Enphase', 50],
  SEDG: ['usL', 'SolarEdge', 55],
  RUN: ['usL', 'Sunrun', 55],
  PLUG: ['usL', 'Plug Power', 65],
  BE: ['usL', 'Bloom Energy', 50],
  LIN: ['usL', 'Linde', 17],
  APD: ['usL', 'Air Products', 18],
  SHW: ['usL', 'Sherwin-Williams', 20],
  ECL: ['usL', 'Ecolab', 18],
  DD: ['usL', 'DuPont', 22],
  DOW: ['usL', 'Dow Inc', 24],
  LYB: ['usL', 'LyondellBasell', 24],
  PPG: ['usL', 'PPG Industries', 20],
  FCX: ['usL', 'Freeport-McMoRan', 36],
  NEM: ['usL', 'Newmont', 30],
  NUE: ['usL', 'Nucor', 30],
  STLD: ['usL', 'Steel Dynamics', 30],
  CLF: ['usL', 'Cleveland-Cliffs', 42],
  X: ['usL', 'US Steel', 40],
  AA: ['usL', 'Alcoa', 42],
  MP: ['usL', 'MP Materials', 45],
  ALB: ['usL', 'Albemarle', 42],
  NEE: ['usL', 'NextEra', 20],
  SO: ['usL', 'Southern Co', 15],
  DUK: ['usL', 'Duke Energy', 15],
  D: ['usL', 'Dominion', 17],
  AEP: ['usL', 'American Electric', 15],
  EXC: ['usL', 'Exelon', 16],
  XEL: ['usL', 'Xcel', 16],
  SRE: ['usL', 'Sempra', 17],
  ED: ['usL', 'Con Edison', 14],
  WEC: ['usL', 'WEC Energy', 15],
  ES: ['usL', 'Eversource', 17],
  PEG: ['usL', 'PSEG', 16],
  PCG: ['usL', 'PG&E', 24],
  EIX: ['usL', 'Edison Intl', 20],
  FE: ['usL', 'FirstEnergy', 16],
  PPL: ['usL', 'PPL Corp', 16],
  CEG: ['usL', 'Constellation Energy', 30],
  VST: ['usL', 'Vistra', 35],
  NRG: ['usL', 'NRG Energy', 30],
  AES: ['usL', 'AES Corp', 26],
  O: ['reit', 'Realty Income', 22],
  PLD: ['reit', 'Prologis', 24],
  AMT: ['reit', 'American Tower', 24],
  CCI: ['reit', 'Crown Castle', 24],
  EQIX: ['reit', 'Equinix', 24],
  DLR: ['reit', 'Digital Realty', 26],
  SPG: ['reit', 'Simon Property', 26],
  PSA: ['reit', 'Public Storage', 20],
  EXR: ['reit', 'Extra Space', 22],
  AVB: ['reit', 'AvalonBay', 20],
  EQR: ['reit', 'Equity Residential', 20],
  MAA: ['reit', 'Mid-America Apt', 20],
  INVH: ['reit', 'Invitation Homes', 20],
  VICI: ['reit', 'VICI Properties', 20],
  WELL: ['reit', 'Welltower', 20],
  VTR: ['reit', 'Ventas', 22],
  ARE: ['reit', 'Alexandria RE', 24],
  BXP: ['reit', 'BXP Inc', 26],
  IRM: ['reit', 'Iron Mountain', 22],
  WPC: ['reit', 'WP Carey', 20],
  NNN: ['reit', 'NNN REIT', 20],
  STAG: ['reit', 'STAG Industrial', 22],
  AGNC: ['reit', 'AGNC Investment', 24, 7.5],
  NLY: ['reit', 'Annaly Capital', 24, 7.5],
  GEV: ['usL', 'GE Vernova', 35],
  CARR: ['usL', 'Carrier', 24],
  OTIS: ['usL', 'Otis', 18],
  JCI: ['usL', 'Johnson Controls', 22],
  TT: ['usL', 'Trane', 22],
  LEN: ['usL', 'Lennar', 30],
  DHI: ['usL', 'DR Horton', 30],
  PHM: ['usL', 'PulteGroup', 30],
  NVR: ['usL', 'NVR Inc', 26],
  TOL: ['usL', 'Toll Brothers', 32],
  BLDR: ['usL', 'Builders FirstSource', 35],
  POOL: ['usL', 'Pool Corp', 26],
  BABA: ['intl', 'Alibaba', 38],
  JD: ['intl', 'JD.com', 40],
  PDD: ['intl', 'PDD Holdings', 45],
  BIDU: ['intl', 'Baidu', 38],
  TCEHY: ['intl', 'Tencent', 32],
  NTES: ['intl', 'NetEase', 32],
  NIO: ['intl', 'NIO', 55],
  XPEV: ['intl', 'XPeng', 55],
  LI: ['intl', 'Li Auto', 48],
  BYDDY: ['intl', 'BYD Company', 35],
  GRAB: ['intl', 'Grab Holdings', 40],
  SE: ['intl', 'Sea Limited', 45],
  TM: ['intl', 'Toyota', 20],
  HMC: ['intl', 'Honda', 22],
  SONY: ['intl', 'Sony', 24],
  MUFG: ['intl', 'Mitsubishi UFJ', 24],
  SMFG: ['intl', 'Sumitomo Mitsui', 24],
  NVO: ['intl', 'Novo Nordisk', 26],
  AZN: ['intl', 'AstraZeneca', 20],
  NVS: ['intl', 'Novartis', 17],
  GSK: ['intl', 'GSK', 18],
  SNY: ['intl', 'Sanofi', 18],
  SAP: ['intl', 'SAP', 24],
  SHEL: ['intl', 'Shell', 22],
  BP: ['intl', 'BP', 24],
  TTE: ['intl', 'TotalEnergies', 22],
  E: ['intl', 'Eni', 22],
  EQNR: ['intl', 'Equinor', 26],
  RIO: ['intl', 'Rio Tinto', 26],
  BHP: ['intl', 'BHP Group', 26],
  VALE: ['intl', 'Vale', 32],
  SCCO: ['intl', 'Southern Copper', 32],
  PBR: ['intl', 'Petrobras', 38],
  UL: ['intl', 'Unilever', 15],
  DEO: ['intl', 'Diageo', 18],
  BUD: ['intl', 'AB InBev', 20],
  NSRGY: ['intl', 'Nestle', 14],
  HSBC: ['intl', 'HSBC', 22],
  UBS: ['intl', 'UBS Group', 24],
  DB: ['intl', 'Deutsche Bank', 30],
  BCS: ['intl', 'Barclays', 28],
  SAN: ['intl', 'Banco Santander', 26],
  ING: ['intl', 'ING Group', 26],
  MELI: ['intl', 'MercadoLibre', 38],
  QUS: ['usL', 'SPDR MSCI USA StrategicFactors', 14.5],
  QEFA: ['intl', 'SPDR MSCI EAFE StrategicFactors', 15],
  QEMM: ['em', 'SPDR MSCI EM StrategicFactors', 19],
  QWLD: ['usL', 'SPDR MSCI World StrategicFactors', 14.5],
  VFMF: ['usL', 'Vanguard US Multifactor', 16],
  VFMO: ['usL', 'Vanguard US Momentum', 18],
  VFVA: ['usL', 'Vanguard US Value Factor', 16],
  VFQY: ['usL', 'Vanguard US Quality', 15.5],
  AVEM: ['em', 'Avantis Emerging Markets'],
  AVDE: ['intl', 'Avantis Intl Equity'],
  AVDV: ['intl', 'Avantis Intl Small Value', 18.5],
  AVES: ['em', 'Avantis EM Value', 20],
  AVLV: ['usL', 'Avantis US Large Value', 14.5],
  AVSC: ['usS', 'Avantis US Small Cap'],
  AVIG: ['bond', 'Avantis Core Fixed Income', 5.5],
  AVGE: ['usL', 'Avantis All Equity Markets', 15],
  DFAT: ['usS', 'Dimensional US Targeted Value', 19],
  DFSV: ['usS', 'Dimensional US Small Value', 19.5],
  DFAI: ['intl', 'Dimensional Intl Core'],
  DFAX: ['intl', 'Dimensional World ex-US'],
  DFAE: ['em', 'Dimensional EM Core'],
  DFIV: ['intl', 'Dimensional Intl Value', 15.5],
  DFUV: ['usL', 'Dimensional US Marketwide Value', 14.5],
  DEUS: ['usL', 'Xtrackers Russell US Multifactor', 15.5],
  DEEF: ['intl', 'Xtrackers Developed ex-US Multifactor', 15.5],
  DBEF: ['intl', 'Xtrackers Hedged MSCI EAFE', 12.5],
  DBEU: ['intl', 'Xtrackers Hedged Europe', 13.5],
  GSLC: ['usL', 'Goldman ActiveBeta US Large', 14.5],
  GSIE: ['intl', 'Goldman ActiveBeta Intl', 15],
  JQUA: ['usL', 'JPMorgan US Quality Factor', 14.5],
  JVAL: ['usL', 'JPMorgan US Value Factor', 15.5],
  JMOM: ['usL', 'JPMorgan US Momentum Factor', 17],
  JPUS: ['usL', 'JPMorgan Diversified US', 14.5],
  JPIN: ['intl', 'JPMorgan Diversified Intl', 15],
  LRGF: ['usL', 'iShares US Multifactor', 15.5],
  INTF: ['intl', 'iShares Intl Multifactor', 15.5],
  SMLF: ['usS', 'iShares Small Multifactor', 18.5],
  IQLT: ['intl', 'iShares Intl Quality', 15],
  IMTM: ['intl', 'iShares Intl Momentum', 16],
  IVLU: ['intl', 'iShares Intl Value', 15.5],
  ACWV: ['usL', 'iShares Global Min Vol', 11.5],
  EFAV: ['intl', 'iShares EAFE Min Vol', 12.5],
  EEMV: ['em', 'iShares EM Min Vol', 15.5],
  OMFL: ['usL', 'Invesco Russell Dynamic Multifactor', 15.5],
  XLG: ['usL', 'Invesco S&P 500 Top 50', 16],
  FNDB: ['usL', 'Schwab Fundamental US Broad', 15],
  FNDA: ['usS', 'Schwab Fundamental Small', 18.5],
  FNDF: ['intl', 'Schwab Fundamental Intl', 15.5],
  FNDE: ['em', 'Schwab Fundamental EM', 19],
  SCHK: ['usL', 'Schwab 1000 ETF'],
  ESGU: ['usL', 'iShares ESG Aware USA'],
  ESGV: ['usL', 'Vanguard ESG US Stock'],
  VSGX: ['intl', 'Vanguard ESG Intl Stock'],
  SPHB: ['usL', 'Invesco S&P 500 High Beta', 24],
  SPTS: ['tsy', 'SPDR Short Treasury', 2],
  SPTI: ['tsy', 'SPDR Interm Treasury', 5],
  SPBO: ['bond', 'SPDR Corporate Bond', 7],
  SPSB: ['bond', 'SPDR Short Corporate', 3],
  SPMB: ['bond', 'SPDR Mortgage-Backed', 4.5],
  JCPB: ['bond', 'JPMorgan Core Plus Bond', 6],
  FIXD: ['bond', 'First Trust TCW Core', 6],
  BINC: ['bond', 'BlackRock Flexible Income', 5.5],
  EAGG: ['bond', 'iShares ESG Aggregate', 5.5]
};
const SINGLE_STOCK_VOL = 15.6;   // holdings with a vol override above this behave as concentrated positions in the correlation math
/* ----------------------------- Real historical returns (baked, offline) ----
   Pulled once from dividend-adjusted monthly total-return history (1106 symbols).
   Per ticker: [ trailing-20yr return %, trailing-20yr vol %, since-inception
   return %, since-inception vol %, years in the 20yr window, years since
   inception ]. Younger funds carry fewer years (surfaced in the UI). This is
   past performance, kept for a real-history benchmark — refreshed on request. */
const HIST_ASOF = 'July 2026';
const HIST = {
  A:[10.3,28.8,4.1,38.3,20,27], AA:[-1.1,54.7,5.6,43.3,20,42], AAL:[-4.6,63.6,-1.9,63.4,20,21], AAP:[3.8,35.8,5.6,35,20,25], AAPL:[27.2,35.4,22,45.1,20,42], ABALX:[8.4,10.7,8.5,10.1,20,40], ABBV:[19.8,24.9,19.8,24.9,13,13], ABNB:[1.3,43.9,1.3,43.9,6,6],
  ABNDX:[2.5,5,4.8,4.9,20,40], ABT:[9.6,17.7,13.2,20.6,20,42], ACN:[10,23.9,11,26.3,20,25], ACWI:[8.1,16.6,8.1,16.6,18,18], ACWV:[8.7,9.9,8.7,9.9,15,15], ACWX:[4.4,17.9,4.4,17.9,18,18], ADBE:[9.3,29.1,17.6,55.1,20,40], ADI:[15.9,24.2,13.3,43.1,20,42],
  ADM:[7,25.6,10.6,27.1,20,42], ADSK:[8.5,34.7,15.2,40.5,20,41], AEP:[10.1,16.9,10.2,18.1,20,42], AEPGX:[6.2,18.7,8.4,17.7,20,40], AES:[0.5,32.4,5.2,45,20,35], AFL:[11.6,35.3,16.3,32.5,20,42], AGG:[3.1,4.6,3.1,4.4,20,23], AGNC:[13,26,13,26,18,18],
  AGTHX:[11.3,18.1,11.2,18.5,20,41], AHITX:[5.7,9.5,7.3,9.3,20,38], AIBAX:[2.2,3.3,4.1,3.4,20,38], AIG:[-11.5,45.9,2,36.3,20,42], AIQ:[19,24.3,19,24.3,8,8], AIVSX:[10.2,15.7,9.9,14.5,20,40], ALB:[9.4,40.2,10.9,36.8,20,32], ALGN:[18.4,50.8,13.3,61.5,20,25],
  ALK:[8.6,36.9,6.1,35.5,20,42], ALL:[10,25.3,11.2,25.5,20,33], ALLY:[7.1,33,7.1,33,12,12], AMAT:[20.8,35,21.5,49,20,42], AMC:[-29.2,175.5,-29.2,175.5,13,13], AMCPX:[10.2,17.2,9.1,16.6,20,40], AMD:[17.3,73.9,8.6,73.1,20,42], AMECX:[7.2,11.1,8.5,10,20,40],
  AMGN:[10.7,24.3,22.5,35.9,20,42], AMLP:[5.4,25.3,5.4,25.3,16,16], AMRMX:[9.1,12.9,8.8,12,20,40], AMT:[9.9,20.9,9,49.7,20,28], AMZN:[29.2,33.9,32.1,55.9,20,29], AN:[12.5,36.8,10,63.8,20,36], ANCFX:[11,17,11.3,16.2,20,41], ANEFX:[11.9,19.7,10,19.7,20,40],
  ANET:[36,40.9,36,40.9,12,12], ANGL:[6.9,8.5,6.9,8.5,14,14], ANWPX:[9.8,17.4,10.3,16.7,20,41], AON:[13.5,17.1,12.3,23.6,20,42], APD:[10.6,23.3,12.5,25.7,20,42], APO:[20.6,35.3,20.6,35.3,15,15], APP:[46.4,79.5,46.4,79.5,5,5], ARE:[-0.1,30.8,6.7,27.6,20,29],
  ARES:[16.8,32.3,16.8,32.3,12,12], ARGFX:[8.5,23.5,9.7,20.7,20,40], ARKB:[16.8,45.6,16.8,45.6,3,3], ARKF:[10.7,38.9,10.7,38.9,7,7], ARKG:[6.8,36.3,6.8,36.3,12,12], ARKK:[13.2,35.8,13.2,35.8,12,12], ARKQ:[17.1,27.4,17.1,27.4,12,12], ARKW:[20.6,33.7,20.6,33.7,12,12],
  ARM:[68.5,81.8,68.5,81.8,3,3], ASML:[24.9,33,23.9,47.1,20,31], AVB:[6.1,23.4,11.1,21.4,20,32], AVDE:[12,19.3,12,19.3,7,7], AVDV:[15,21.4,15,21.4,7,7], AVEM:[12,19.7,12,19.7,7,7], AVES:[8.8,16.3,8.8,16.3,5,5], AVGE:[21.9,14.4,21.9,14.4,4,4],
  AVGO:[40.9,32.4,40.9,32.4,17,17], AVIG:[-0.1,5.8,-0.1,5.8,6,6], AVLV:[14.6,16.4,14.6,16.4,5,5], AVSC:[10.1,21.2,10.1,21.2,5,5], AVUS:[16.4,19.8,16.4,19.8,7,7], AVUV:[16.2,27.9,16.2,27.9,7,7], AWSHX:[9.8,14.6,10.7,14,20,41], AXON:[23.7,49.2,32,66.3,20,25],
  AXP:[11.2,36.4,12.6,31.5,20,42], AZN:[8.9,21.6,12.8,22.8,20,33], AZO:[19.1,22.7,18.5,28,20,35], BA:[6.4,33.7,9.8,31.5,20,42], BAB:[4.8,7.4,4.8,7.4,17,17], BABA:[2.1,42.5,2.1,42.5,12,12], BAC:[2.8,36.9,9.3,33.4,20,42], BAGIX:[3.6,4.4,3.5,4.3,20,26],
  BBJP:[8.1,18.2,8.1,18.2,8,8], BBY:[6,40.7,18.3,63.5,20,41], BCOIX:[4.1,4.5,3.9,4.5,20,26], BCS:[0.2,71.2,8.6,52.3,20,40], BDX:[7.3,15.4,10.2,20.7,20,53], BE:[33,98,33,98,8,8], BETZ:[3.9,28.8,3.9,28.8,6,6], BGRFX:[7.5,18,9.8,18.1,20,31],
  BHP:[9.3,31.7,10.9,31.3,20,46], BIDU:[14.3,47.6,14.7,47.7,20,21], BIIB:[7.7,32.2,12.7,50.7,20,35], BIL:[1.3,0.6,1.3,0.6,19,19], BINC:[7.1,3.1,7.1,3.1,3,3], BITB:[16.7,45.6,16.7,45.6,3,3], BITO:[-3.8,52.1,-3.8,52.1,5,5], BITQ:[1.1,66.1,1.1,66.1,5,5],
  BIV:[3.8,5.7,3.8,5.7,19,19], BKLN:[3.7,4.7,3.7,4.7,15,15], BKNG:[28,35.5,5.9,61.4,20,27], BKR:[2.2,41.8,5.2,37.6,20,39], BLDR:[9.3,60.8,7.4,59.7,20,21], BLK:[14,28.3,19.6,29.7,20,27], BLV:[4.1,11,4.1,11,19,19], BMY:[8.4,23.7,9.2,23.3,20,42],
  BND:[3,4.5,3,4.5,19,19], BNDW:[1.8,4.9,1.8,4.9,8,8], BNDX:[2.5,4.1,2.5,4.1,13,13], BNO:[3.6,35.1,3.6,35.1,16,16], BNTX:[32.2,64.6,32.2,64.6,7,7], BOTZ:[9.7,24.5,9.7,24.5,10,10], BP:[2.8,29.3,8.1,24.9,20,42], BPTRX:[15.7,27.4,15.6,27.2,20,34],
  BRO:[9.2,19.7,17.2,25.9,20,42], BRRR:[16.6,45.6,16.6,45.6,3,3], BSV:[2.5,2.4,2.5,2.4,19,19], BSX:[4.7,28.6,7,34.7,20,34], BTCO:[16.8,45.6,16.8,45.6,3,3], BUD:[6.3,26.3,6.3,26.3,17,17], BUFR:[10.7,9.9,10.7,9.9,6,6], BUG:[15.8,30.2,15.8,30.2,7,7],
  BURL:[21.6,37.3,21.6,37.3,13,13], BX:[15.1,37.2,15.1,37.2,19,19], BXP:[2.3,27.9,8.1,25.5,20,29], BYDDY:[10.1,53.2,10.1,53.2,17,17], C:[-5,42.4,6.7,37.9,20,42], CAG:[1.8,22.1,7.5,24.4,20,42], CAH:[10.8,22,14.8,26.4,20,42], CAIBX:[6.4,11.3,8.9,10.1,20,39],
  CALF:[9.9,25.7,9.9,25.7,9,9], CANE:[-6.2,21.6,-6.2,21.6,15,15], CARR:[31.9,35.5,31.9,35.5,6,6], CAT:[17.4,34.7,16.5,31.8,20,42], CAVA:[23.6,59.4,23.6,59.4,3,3], CB:[11.9,19.2,13.5,23.9,20,33], CBOE:[17.3,24.1,17.3,24.1,16,16], CCI:[6.9,25.5,9.9,43.8,20,28],
  CCL:[-1.1,42.6,6.9,38.8,20,39], CDNS:[16.4,30.4,14.4,39.1,20,39], CEG:[48.5,48.5,48.5,48.5,4,4], CHD:[13.3,18.2,14.3,23.1,20,42], CHRW:[10,24.6,15.5,27.4,20,29], CHWY:[-6.7,58.5,-6.7,58.5,7,7], CI:[11.1,30.8,12.4,29.9,20,42], CIBR:[16.9,21.4,16.9,21.4,11,11],
  CL:[7.8,14.5,12.9,17.8,20,42], CLF:[-2.8,78.8,5.5,61.3,20,42], CLIP:[4.6,0.2,4.6,0.2,3,3], CLOU:[7.3,30,7.3,30,7,7], CLOZ:[10.1,3.6,10.1,3.6,3,3], CLX:[5.1,19.3,11.1,21.3,20,42], CMCSA:[5.4,22.7,13.2,29.4,20,46], CME:[9.1,26.2,19.1,28.3,20,24],
  CMG:[19.8,36.3,19.8,36.4,20,20], CMI:[18.9,33.2,13,35.1,20,42], COF:[7.1,35.8,13.6,38.2,20,32], COIN:[-13.2,88.2,-13.2,88.2,5,5], COP:[7.4,29.7,10.9,28.5,20,42], COPX:[7.2,37.6,7.2,37.6,16,16], COR:[16.6,22.3,17.8,29.3,20,31], CORN:[-2.7,20.6,-2.7,20.6,16,16],
  COST:[17.8,17.7,13.6,26.5,20,40], COWZ:[12.5,18.6,12.5,18.6,10,10], CPB:[0.5,18.1,7.2,21.7,20,42], CRM:[16.2,34.6,19.7,37.9,20,22], CRWD:[43.6,55.2,43.6,55.2,7,7], CSCO:[10.9,25.8,23.4,35.8,20,36], CSX:[15.4,27.5,13,27.4,20,42], CVNA:[45.3,99.7,45.3,99.7,9,9],
  CVS:[8.6,21.7,10.2,25.5,20,42], CVX:[8.7,26.1,11.9,21.9,20,42], CWGIX:[8.6,15.5,10.7,14.2,20,33], CZR:[18.4,58.4,18.4,58.4,12,12], D:[7.1,15.3,10.5,16.1,20,42], DAL:[8.9,43.7,8.9,43.7,19,19], DASH:[1.8,52.8,1.8,52.8,6,6], DB:[-2.5,41,1.5,38.9,20,30],
  DBA:[1.1,15.4,1.1,15.4,19,19], DBC:[1.8,18.8,2,18.7,20,20], DBEF:[10.4,12.6,10.4,12.6,15,15], DBEU:[9.4,12.8,9.4,12.8,13,13], DBLTX:[3.4,4.1,3.4,4.1,16,16], DD:[6.1,45.7,8.8,33,20,54], DDOG:[33.8,56.8,33.8,56.8,7,7], DE:[15.5,29.7,14.5,28.6,20,42],
  DECK:[21.3,42.3,15.1,46.1,20,33], DEEF:[8,15,8,15,11,11], DELL:[42.3,46.5,42.3,46.5,10,10], DEM:[5.2,19.2,5.2,19.2,19,19], DEO:[3.7,18.6,6.2,19.5,20,35], DEUS:[12.1,15.7,12.1,15.7,11,11], DFAC:[12.6,16.1,12.6,16.1,5,5], DFAE:[9.4,17.2,9.4,17.2,6,6],
  DFAI:[12,15.5,12,15.5,6,6], DFAS:[9,19.4,9,19.4,5,5], DFAT:[11.5,20.1,11.5,20.1,5,5], DFAX:[10,15.7,10,15.7,5,5], DFIV:[15.9,16.5,15.9,16.5,5,5], DFSV:[11.8,20.9,11.8,20.9,4,4], DFUS:[13.6,16.5,13.6,16.5,5,5], DFUV:[14.1,16,14.1,16,4,4],
  DG:[11.8,26.9,11.8,26.9,17,17], DGRO:[12.5,13.5,12.5,13.5,12,12], DGRW:[13.3,13.4,13.3,13.4,13,13], DHI:[11.6,38.9,15.7,39.3,20,34], DHR:[14.1,24.9,19,30.8,20,48], DHS:[7.8,16.1,7.9,16,20,20], DIA:[10.4,14.7,8.8,14.9,20,28], DIS:[6.6,28.2,11.4,30,20,42],
  DIVO:[12.4,12.6,12.4,12.6,10,10], DJP:[-0.5,17.8,-0.5,17.8,20,20], DKNG:[15,68.2,15,68.2,7,7], DKS:[14.3,37.4,18.5,37.5,20,24], DLR:[13.4,24.3,17.3,24.4,20,22], DLS:[6.1,18,6.1,17.9,20,20], DLTNX:[3.3,4.1,3.3,4.1,16,16], DLTR:[13.8,29.2,15.3,36.7,20,31],
  DODBX:[7.5,13.7,9.7,12.1,20,41], DODFX:[6.5,19.4,8.2,19.1,20,25], DODGX:[9,18.6,12.4,16.7,20,41], DODIX:[4.1,4.3,5.8,4.5,20,37], DODWX:[8.2,19.7,8.2,19.7,18,18], DOW:[-1.4,37.5,-1.4,37.5,7,7], DPZ:[18.2,35.2,19.5,34.7,20,22], DRI:[13,30.1,14,31.6,20,31],
  DUK:[8.9,13.4,10.7,18.1,20,42], DVN:[0.1,46,7,43.7,20,41], DVY:[8.4,15.4,8.7,14.7,20,23], DXCM:[17.1,53.5,15.5,53.7,20,21], DXJ:[9.3,17,9.4,16.9,20,20], E:[4.8,26.7,9.7,25.7,20,31], EA:[7.4,31.4,18.1,40.7,20,37], EAGG:[2,5.5,2,5.5,8,8],
  EBAY:[12.7,30.9,17.5,47.5,20,28], EBND:[0.8,10.2,0.8,10.2,15,15], ECL:[10.6,14.3,14.3,17,20,42], ED:[8.7,16.8,10.3,16.7,20,42], EDV:[2.6,21.4,2.6,21.4,18,18], EEM:[5.7,20.9,9.3,20.7,20,23], EEMV:[4.8,12.4,4.8,12.4,15,15], EFA:[5.3,17.1,7,16.5,20,25],
  EFAV:[7.1,11.1,7.1,11.1,15,15], EFG:[5.2,17.1,5.8,16.9,20,21], EFV:[5,18.3,5.7,18,20,21], EIDO:[-2.3,22.9,-2.3,22.9,16,16], EIX:[6.5,21.1,9.2,24,20,42], EL:[9.3,30.7,8.8,30.3,20,31], ELV:[9.7,28.3,12.8,27.1,20,25], EMB:[4.6,11.4,4.6,11.4,19,19],
  EME:[18.5,32.3,22.4,33.8,20,31], EMR:[8.8,22.9,10.6,21.2,20,42], EMXC:[9.7,19.1,9.7,19.1,9,9], ENPH:[13.2,87.1,13.2,87.1,14,14], EOG:[9.5,35.8,12.5,36.3,20,37], EPD:[12.3,21.4,15.5,22.6,20,28], EPI:[4.5,26.2,4.5,26.2,18,18], EQIX:[17.2,28.2,6.3,74.8,20,26],
  EQNR:[6.9,30.6,12.2,29.7,20,25], EQR:[6.3,23.3,10.2,22,20,33], ES:[9.3,16,8.7,19.1,20,42], ESGU:[14.9,16,14.9,16,10,10], ESGV:[14.6,19.6,14.6,19.6,8,8], ESPO:[16.9,23.8,16.9,23.8,8,8], ET:[13.1,40.2,13.6,39.8,20,20], ETHA:[-26,72,-26,72,2,2],
  ETHW:[-25.9,71.6,-25.9,71.6,2,2], ETN:[15.4,26.3,15,25.5,20,42], ETSY:[15.8,58.2,15.8,58.2,11,11], EW:[16.9,28.7,17.6,29.7,20,26], EWA:[6.1,22.5,7.5,21.5,20,30], EWC:[6.6,19.8,8.8,20,20,30], EWG:[5.4,22.4,6.4,22.9,20,30], EWH:[5.6,20.9,4.8,23.9,20,30],
  EWJ:[4.5,15.3,2.7,17.6,20,30], EWL:[7.5,16.1,7.8,16.5,20,30], EWQ:[4.8,21,7.2,20.6,20,30], EWS:[7.2,21,4.3,24.4,20,30], EWT:[11.7,22.8,7.6,24.4,20,26], EWU:[4.3,17.5,5.9,16.4,20,30], EWW:[5.3,24.1,8.8,26.2,20,30], EWY:[8.4,29.5,9.7,30.2,20,26],
  EWZ:[3.8,32.6,6.2,34.3,20,26], EXC:[4.1,20.4,10.6,22.2,20,53], EXPE:[13.6,42.3,11.2,43.2,20,21], EXR:[15.7,27.6,16.5,27.2,20,22], EZA:[5.5,26.2,9.5,26,20,23], EZBC:[16.9,45.7,16.9,45.7,3,3], EZU:[5,21.4,4.9,20.9,20,26], F:[6.5,53.2,8.2,43.7,20,42],
  FAGIX:[7.9,13.2,9.1,11.5,20,41], FAIRX:[6.8,23.8,9.5,21.4,20,26], FALN:[6.2,9.5,6.2,9.5,10,10], FAN:[1.2,24.7,1.2,24.7,18,18], FANG:[21,44.4,21,44.4,14,14], FAS:[15,57.6,15,57.6,18,18], FAST:[14.3,22.2,22,28.5,20,39], FBALX:[9.1,11.1,9.7,10.1,20,39],
  FBGRX:[15.2,19.1,13.5,17.2,20,38], FBND:[2.4,5,2.4,5,12,12], FBNDX:[3.2,4.8,5.7,5,20,41], FBTC:[16.8,45.6,16.8,45.6,3,3], FCNKX:[13.5,15.8,13.5,15.8,18,18], FCNTX:[13,17.3,13.8,16.7,20,41], FCPGX:[11.9,19.7,11.7,19.4,20,22], FCX:[5.8,52.1,7.6,49.5,20,31],
  FDCAX:[11.9,15.8,11.8,17.1,20,39], FDEQX:[10,15.8,11,14.8,20,37], FDEWX:[10.1,13,10.1,13,15,15], FDGRX:[16.5,22.2,14,23,20,41], FDIVX:[6.1,17.2,8.6,15.9,20,34], FDVLX:[9.3,22.6,11,19.7,20,41], FDVV:[13.8,16,13.8,16,10,10], FDX:[7.9,33.9,13.2,38.8,20,48],
  FE:[3.7,20.9,6.5,21.4,20,29], FEMKX:[7,21.2,6.4,22.3,20,36], FEQIX:[8,16.5,9.7,15.3,20,41], FFRHX:[4.5,5.6,4,5,20,26], FFTY:[4.7,24.2,4.7,24.2,11,11], FGMNX:[3.1,4.9,5.1,4.5,20,40], FGRIX:[8.7,16.9,10.4,15.8,20,40], FIGFX:[6.3,17.3,6.3,17.3,19,19],
  FIPDX:[1.9,4.9,1.9,4.9,14,14], FIPFX:[10.2,13,10.2,13,17,17], FIS:[0.7,27.3,0.9,27.8,20,25], FIVE:[13.7,41,13.7,41,14,14], FIXD:[1.7,5.8,1.7,5.8,9,9], FKINX:[6.2,11.5,8,10.2,20,40], FLCOX:[11.4,15.5,11.4,15.5,10,10], FLCSX:[12,17.6,10.3,17.1,20,31],
  FLOT:[2.3,1.7,2.3,1.7,15,15], FLPSX:[9.7,16,13.1,14.7,20,36], FLRN:[2.4,2.2,2.4,2.2,15,15], FMAGX:[9.8,19,11,18.6,20,41], FNBGX:[-1.1,13.6,-1.1,13.6,9,9], FNDA:[10.2,19.4,10.2,19.4,13,13], FNDB:[13,15.1,13,15.1,13,13], FNDE:[6.7,17.6,6.7,17.6,13,13],
  FNDF:[8.6,15.4,8.6,15.4,13,13], FNDX:[13.1,14.8,13.1,14.8,13,13], FNILX:[14.8,18.8,14.8,18.8,8,8], FOCPX:[16.8,21.1,14.4,23.1,20,41], FOSFX:[5.8,18,9.4,18.7,20,41], FPACX:[8.5,11.1,9.7,10.9,20,33], FPADX:[6,16.9,6,16.9,15,15], FPURX:[8.8,12.2,9.7,11.3,20,41],
  FRDM:[17.1,23.1,17.1,23.1,7,7], FREL:[5.6,17.1,5.6,17.1,11,11], FSAGX:[4.5,34.1,6.6,31.6,20,40], FSCSX:[14,21.2,15.6,27.6,20,41], FSDAX:[12.5,16.9,11.9,16.7,20,41], FSELX:[21.4,31.2,16.8,33.9,20,41], FSENX:[5.9,32.1,8.8,25.4,20,41], FSKAX:[14.6,14.4,14.6,14.4,15,15],
  FSLCX:[8.7,20.8,8.9,20.6,20,28], FSLR:[10.7,59.6,10.7,59.6,20,20], FSMAX:[12.3,18.1,12.3,18.1,15,15], FSMDX:[12.4,15.7,12.4,15.7,15,15], FSMEX:[11.2,17,12.2,15.9,20,28], FSPGX:[17.9,17.7,17.9,17.7,10,10], FSPHX:[11.7,17.4,13.9,19.2,20,41], FSPSX:[8.2,14.6,8.2,14.6,15,15],
  FSPTX:[17.9,25.9,14.3,30.5,20,41], FSRPX:[13.5,18.1,13.3,20.3,20,40], FSSNX:[11.5,18.8,11.5,18.8,15,15], FSUTX:[9.2,13.9,10.5,14.9,20,41], FTABX:[3.8,5.2,4.2,5.2,20,25], FTBFX:[4.2,4.9,4.3,4.8,20,24], FTEC:[21.5,19.6,21.5,19.6,13,13], FTIHX:[9.3,15,9.3,15,10,10],
  FTNT:[31.4,39.2,31.4,39.2,17,17], FTRNX:[13.9,20.9,12,20.4,20,41], FUAMX:[1.3,5.6,1.3,5.6,9,9], FUMBX:[1.8,2.4,1.8,2.4,9,9], FVD:[8.7,13.3,9.7,13,20,23], FXAIX:[14.3,14.3,14.3,14.3,15,15], FXI:[3.6,26.6,5.1,26.1,20,22], FXNAX:[2.2,4.5,2.2,4.5,15,15],
  FZILX:[9.2,17.5,9.2,17.5,8,8], FZROX:[14.3,19,14.3,19,8,8], GBTC:[58.6,116.3,58.6,116.3,11,11], GD:[10.9,22.8,12.6,24.7,20,42], GDX:[3.8,37.6,4.1,37.5,20,20], GDXJ:[1.6,41.4,1.6,41.4,17,17], GE:[6,39.2,10.3,28.7,20,65], GILD:[13.3,24.7,18.5,39.4,20,34],
  GIS:[4.9,18,9.7,18.2,20,42], GLD:[9.3,17.3,10.4,17.2,20,22], GLDM:[15.5,15.8,15.5,15.8,8,8], GM:[6.9,31.7,6.9,31.7,16,16], GNMA:[1.3,4.5,1.3,4.5,14,14], GOOG:[20.3,28.2,24.3,30.4,20,22], GOOGL:[20.3,28.3,24.3,30.5,20,22], GOVT:[1.3,4.5,1.3,4.5,14,14],
  GPC:[8.2,19.7,9.6,19.5,20,42], GPN:[7.8,28,12.1,28.8,20,25], GRAB:[-18.7,58.5,-18.7,58.5,6,6], GRID:[12.2,20.4,12.2,20.4,17,17], GS:[12.5,30.7,12.2,31.7,20,27], GSG:[-2.1,23.1,-2.1,23.1,20,20], GSIE:[9,14.5,9,14.5,11,11], GSK:[4.8,19.5,14.2,26.6,20,46],
  GSLC:[13.6,14.8,13.6,14.8,11,11], GWW:[17.7,20.8,14.7,22.6,20,42], GWX:[4.4,18.9,4.4,18.9,19,19], H:[12.1,29.8,12.1,29.8,17,17], HACAX:[13,18.1,11.1,18.5,20,38], HACK:[13.6,20.8,13.6,20.8,12,12], HAL:[1.7,39.8,5.8,38.4,20,42], HCA:[19.6,32.7,19.6,32.7,15,15],
  HD:[14.5,22.3,19.2,28.7,20,42], HDV:[10.3,12.9,10.3,12.9,15,15], HEFA:[10.5,11.9,10.5,11.9,12,12], HIG:[4.6,43.8,7.9,40.9,20,31], HII:[15.2,28.4,15.2,28.4,15,15], HLT:[17.8,25.5,17.8,25.5,13,13], HMC:[0.7,21.9,7.1,21.2,20,42], HODL:[17,45.6,17,45.6,3,3],
  HON:[11.1,23.1,9,25.8,20,65], HOOD:[26.9,72.5,26.9,72.5,5,5], HPE:[20.1,35.2,20.1,35.2,11,11], HPQ:[3.7,32.7,8.7,34.5,20,42], HSBC:[5.9,26.2,6.9,24.6,20,27], HSY:[8.7,18.2,12.5,21.8,20,42], HUM:[11.5,31.4,11.8,38.7,20,42], HWM:[35.6,40.6,35.6,40.6,10,10],
  HYD:[5.3,9.3,5.3,9.3,17,17], HYG:[4.9,10.2,4.9,10.2,19,19], HYLB:[4.6,7.4,4.6,7.4,10,10], IAGG:[2.5,3.9,2.5,3.9,11,11], IAI:[9.2,22.8,9.1,22.7,20,20], IAU:[9.5,17.3,10.6,17.2,20,21], IBB:[11,20.2,8.4,21.6,20,25], IBIT:[16.8,45.8,16.8,45.8,3,3],
  IBM:[7.6,21.8,8.2,25.6,20,65], IBUY:[11.1,29.1,11.1,29.1,10,10], ICE:[13.7,28.2,16.3,30,20,21], ICLN:[-3.3,30.8,-3.3,30.8,18,18], IDEV:[9.3,17.2,9.3,17.2,9,9], IDU:[8.4,14.4,8,15,20,26], IDV:[4.9,20.1,4.9,20.1,19,19], IDXX:[17.4,29.2,20.2,38.4,20,35],
  IEF:[3.3,6.6,3.4,6.6,20,24], IEFA:[8.2,14.4,8.2,14.4,14,14], IEI:[2.8,3.9,2.8,3.9,19,19], IEMG:[6.2,16.5,6.2,16.5,14,14], IEUR:[7,16.2,7,16.2,12,12], IFRA:[13.4,21.9,13.4,21.9,8,8], IGF:[5.4,16.5,5.4,16.5,19,19], IGIB:[3.8,5.8,3.8,5.8,19,19],
  IGSB:[2.8,2.7,2.8,2.7,19,19], IGV:[13.3,21.1,10.6,23.4,20,25], IHE:[10.8,15.7,11,15.7,20,20], IHI:[10.1,17.5,10.2,17.4,20,20], IJH:[10,18.2,9.6,17.7,20,26], IJR:[9.6,19.9,9.8,19.4,20,26], ILF:[4.9,27.1,9.1,26.9,20,25], IMTM:[8.8,13.9,8.8,13.9,11,11],
  INDA:[5.8,18.4,5.8,18.4,14,14], ING:[2.2,44.7,8.1,40.1,20,32], INTC:[10.9,47.4,14.7,46.6,20,42], INTF:[8,15.1,8,15.1,11,11], INVH:[6.2,20.9,6.2,20.9,9,9], IQLT:[8,14.8,8,14.8,11,11], IQV:[12.9,28.9,12.9,28.9,13,13], IRBO:[15.8,27,15.8,27,8,8],
  IRM:[13.3,28,16.5,28.3,20,30], ISRG:[19.9,36.8,19,50.6,20,26], ITA:[13.4,20.2,13.3,20.1,20,20], ITOT:[11.1,15.7,10.7,15,20,22], ITW:[11.8,20.9,14.2,22.4,20,42], IUSB:[2.2,4.8,2.2,4.8,12,12], IUSG:[13,16.6,7.8,17.4,20,26], IUSV:[8.7,15.9,8.4,15.3,20,26],
  IVLU:[9.2,16.1,9.2,16.1,11,11], IVV:[11.2,15.3,8.4,15.1,20,26], IWB:[11.1,15.5,8.4,15.3,20,26], IWD:[8.5,15.8,8.3,15.1,20,26], IWF:[13.3,16.7,8,17.4,20,26], IWM:[7.3,20.2,6.9,20,20,26], IWN:[7.8,20.6,9.3,19.6,20,26], IWO:[9.5,20.8,6.6,21.5,20,26],
  IWR:[9.8,17.6,10.7,16.9,20,25], IWV:[10.9,15.8,8.4,15.6,20,26], IXUS:[7.8,14.2,7.8,14.2,14,14], IYH:[10.1,14.3,8,13.7,20,26], IYK:[9.5,13.8,8.7,13,20,26], IYM:[7.9,22.7,8.4,22.2,20,26], IYR:[5.3,21.3,8.1,19.9,20,26], IYT:[9.2,20.7,10.1,20.2,20,22],
  IYW:[16.9,20.1,8.8,24.5,20,26], IYY:[11,15.7,8.5,15.6,20,26], J:[7.3,28.2,13.2,36.2,20,46], JAAA:[4.4,1.4,4.4,1.4,6,6], JABAX:[8.8,9.8,9.6,9.4,20,34], JBBB:[5.8,6.1,5.8,6.1,5,5], JBHT:[14.8,23.4,13.4,35.5,20,42], JCI:[7.8,29.1,11.2,29.3,20,39],
  JCPB:[2.6,5.2,2.6,5.2,7,7], JD:[1.4,41.9,1.4,41.9,12,12], JEPI:[11.1,10.7,11.1,10.7,6,6], JEPQ:[16.9,15.8,16.9,15.8,4,4], JETS:[3.2,30.4,3.2,30.4,11,11], JMOM:[16,19.6,16,19.6,9,9], JNJ:[10.1,15.1,14.3,20.8,20,42], JNK:[5.1,11.2,5.1,11.2,19,19],
  JPIN:[7.1,14,7.1,14,12,12], JPM:[13.5,26.7,12.2,31,20,42], JPUS:[11.3,15,11.3,15,11,11], JQUA:[14.7,17.2,14.7,17.2,9,9], JVAL:[12.9,19.7,12.9,19.7,9,9], KBE:[3.6,27,3.9,26.7,20,21], KBWB:[14.3,23.9,14.3,23.9,15,15], KHC:[-5,25.6,-5,25.6,11,11],
  KKR:[19.7,32.9,19.7,32.9,16,16], KLAC:[24.9,40.2,19.2,49.1,20,46], KMB:[6.4,15.2,10.7,19.2,20,42], KMI:[5.4,24.5,5.4,24.5,15,15], KMX:[5.9,39,7.3,49.5,20,29], KO:[9.7,14.7,12.9,20.5,20,42], KR:[10.5,25,13.9,31,20,42], KRE:[4.7,26.4,4.8,26.4,20,20],
  KWEB:[2.1,33.3,2.1,33.3,13,13], LCID:[-39.1,92.4,-39.1,92.4,6,6], LEN:[3.8,36.6,11.9,40.4,20,46], LHX:[12.7,24.9,12.1,28.2,20,42], LI:[-3.7,62.6,-3.7,62.6,6,6], LIN:[13.7,18.9,15.1,23.1,20,34], LIT:[6.4,28.2,6.4,28.2,16,16], LLY:[20,26.8,17.1,26.6,20,42],
  LMT:[12.3,22.1,11.9,24.4,20,42], LNG:[11.1,58.1,8.2,84.8,20,32], LOW:[12.2,24.5,15.6,33.8,20,42], LQD:[4.1,8.1,4.4,7.8,20,24], LRCX:[24.3,37.8,19.8,56.4,20,42], LRGF:[12.2,15.2,12.2,15.2,11,11], LSBDX:[4.8,8.2,7.2,7.8,20,35], LTPZ:[2.7,11.9,2.7,11.9,17,17],
  LULU:[10.8,49.5,10.8,49.5,19,19], LUV:[6.9,34.1,10.2,34.8,20,42], LVS:[0.1,59.1,2.3,58.2,20,22], LYB:[13.8,33.7,13.8,33.7,16,16], LYFT:[-19.3,69.6,-19.3,69.6,7,7], LYV:[11.4,42,12,41.7,20,21], MA:[26.4,27.9,27.1,28.1,20,20], MAA:[8.3,22.6,11.6,20.2,20,32],
  MAGS:[37.4,24.2,37.4,24.2,3,3], MALOX:[6.8,10.4,8.7,10,20,37], MAR:[13.6,31.1,13,30.2,20,28], MBB:[2.6,4.2,2.6,4.2,19,19], MCD:[12.6,15.9,13.3,22.2,20,42], MCHI:[2.2,23.4,2.2,23.4,15,15], MCHP:[11.5,32.6,19.1,42.2,20,33], MCK:[15.8,25.4,14.1,29.1,20,32],
  MCO:[12.5,29.4,15.2,27,20,32], MDB:[31.4,64,31.4,64,9,9], MDLOX:[6.5,10.4,8.2,10.4,20,32], MDLZ:[7.7,18.4,6.9,18.6,20,25], MDT:[5,19,14.9,25,20,42], MDY:[9.8,18.2,11,17.7,20,31], MELI:[23.4,52,23.4,52,19,19], MET:[6.2,30.7,8.9,28.7,20,26],
  META:[24.6,37.9,24.6,37.9,14,14], MGC:[12,15.6,12,15.6,19,19], MGK:[14.2,17.6,14.2,17.6,19,19], MGM:[0.7,42.5,7.6,42.6,20,38], MGV:[9.6,15.2,9.6,15.2,19,19], MJ:[-17.9,50.7,-17.9,50.7,11,11], MLPX:[9.5,24.9,9.5,24.9,13,13], MMM:[7.7,21.8,9.1,21.7,20,65],
  MO:[13.3,20.2,17,27.7,20,42], MOAT:[14.3,15.6,14.3,15.6,14,14], MOO:[4.3,20.8,4.3,20.8,19,19], MORT:[4.8,24.2,4.8,24.2,15,15], MP:[30,68.3,30,68.3,6,6], MPC:[22.3,38.5,22.3,38.5,15,15], MRK:[9.3,20.3,13,23.8,20,42], MRNA:[18.2,77.6,18.2,77.6,8,8],
  MRVL:[14,45.5,12.4,59.4,20,26], MS:[9.7,33.8,12.6,35.3,20,33], MSCI:[17,28.1,17,28.1,19,19], MSFT:[16.1,23.4,23.7,31.7,20,40], MSOS:[-24.5,66.4,-24.5,66.4,6,6], MSTR:[12.6,67.7,6.2,85.2,20,28], MTUM:[15.8,16.5,15.8,16.5,13,13], MU:[23.1,60.9,17.4,65.9,20,42],
  MUB:[3.1,5.2,3.1,5.2,19,19], MUFG:[3,28,4.1,29.7,20,25], MWTIX:[4.1,4.7,3.8,4.7,20,26], MWTRX:[3.9,4.7,4.5,4.5,20,29], NCLH:[-3.3,50.8,-3.3,50.8,13,13], NDAQ:[13.3,26.4,14.9,32.4,20,24], NEE:[13.5,17.7,13.3,16.8,20,42], NEM:[5.6,37.5,6.7,36.8,20,42],
  NET:[48.8,67.4,48.8,67.4,7,7], NEWFX:[7.7,16.9,8.5,16.8,20,27], NFLX:[32.1,51.5,31.5,54.5,20,24], NIO:[-8.2,85.3,-8.2,85.3,8,8], NKE:[8,25.1,15.8,31.1,20,42], NLY:[8.8,24.1,10.3,24.3,20,29], NNN:[9.4,22,10.1,20.4,20,42], NOBL:[10,14.1,10,14.1,13,13],
  NOC:[13.9,23.6,11,29.3,20,42], NOW:[23.6,34.7,23.6,34.7,14,14], NRG:[10.5,36.2,13.8,35.1,20,23], NSC:[12.5,24.5,12.4,25,20,42], NSRGY:[8.8,17.2,10.5,17.3,20,30], NTES:[21.4,35.5,27.5,55.4,20,26], NUE:[10.1,33,15,31.5,20,42], NVDA:[36.1,46.4,36.3,59.9,20,27],
  NVO:[15.8,26.9,14.6,26.8,20,45], NVS:[9.4,18.2,9.2,18.1,20,30], NXPI:[22.5,41.1,22.5,41.1,16,16], NYVTX:[9,18.1,9.4,18.1,20,41], O:[10.5,22.1,13.5,20.4,20,32], OAKBX:[7.4,11.4,9.5,10.6,20,31], OAKIX:[5.9,20.8,8.8,19.3,20,34], OAKMX:[11,18.2,12.5,16.4,20,35],
  ODFL:[21.6,30.4,19,32.8,20,35], OEF:[11.6,15.2,8.7,15.2,20,26], OIH:[-2.4,38.5,0.2,36.9,20,25], OKE:[13.8,40,13.7,36.1,20,42], OKTA:[22.2,53.6,22.2,53.6,9,9], OMFL:[13.9,19.2,13.9,19.2,9,9], ON:[14.6,45.8,5.6,60.2,20,26], ONEQ:[14.2,18.5,13,17.9,20,23],
  ONON:[-0.5,55.7,-0.5,55.7,5,5], ORCL:[11.5,28.6,21.1,46.9,20,40], ORLY:[20.6,23.4,20.4,29.1,20,33], OTIS:[9.3,21.6,9.3,21.6,6,6], OXY:[3.2,36.6,7.4,32.2,20,42], PALL:[6.2,29.8,6.2,29.8,16,16], PANW:[28.6,38.3,28.6,38.3,14,14], PAVE:[16.3,23,16.3,23,9,9],
  PBR:[6.5,50.9,10.6,49.1,20,26], PBW:[-3.2,35.6,-1.4,35.4,20,21], PCAR:[11.1,25.3,14.8,29.2,20,46], PCG:[-2.6,36.7,3.8,32.2,20,42], PCY:[4.6,13.8,4.6,13.8,19,19], PDBC:[5.1,17.1,5.1,17.1,12,12], PDD:[17.1,66.4,17.1,66.4,8,8], PEG:[8.5,18.8,11,19.3,20,42],
  PENN:[5.3,48.6,16.9,51.3,20,32], PEP:[7.1,14.4,12.7,20.3,20,42], PFE:[4.1,20.5,10.3,24.1,20,42], PFORX:[4.7,4,6,3.9,20,33], PG:[7.3,16.4,12.3,20.4,20,42], PGR:[15.6,20.3,19,28.9,20,42], PH:[17.2,26.2,14.6,26.4,20,42], PHM:[7.9,38.7,11.1,41.7,20,42],
  PIMIX:[6.8,5.1,6.8,5.1,19,19], PINS:[-0.6,57.2,-0.6,57.2,7,7], PLD:[8.3,30.9,10.5,27.2,20,29], PLUG:[-14.3,93.8,-15.3,100.9,20,27], PM:[12.2,22.5,12.2,22.5,18,18], PNC:[9.7,27.3,11.1,26.9,20,42], POAGX:[13.8,19.7,13.3,19.3,20,22], POGRX:[12.9,17.6,12.7,17.1,20,22],
  PONAX:[6.3,5.1,6.3,5.1,19,19], POOL:[10.4,31.7,20.6,32.4,20,31], POSKX:[11.8,15.8,11.6,15.4,20,22], PPA:[13.5,18.6,13.4,18.3,20,21], PPG:[9,24.4,10.8,24.1,20,42], PPL:[4.8,17,9.9,19.9,20,42], PPLT:[-0.2,23.6,-0.2,23.6,16,16], PRBLX:[11.8,13.9,11.4,12.9,20,34],
  PRDGX:[10.5,13.8,10.1,12.8,20,33], PRF:[10.6,16.8,10.6,16.6,20,21], PRFDX:[8.3,16.9,10.1,15.1,20,41], PRGFX:[11.4,19.6,9.7,18.7,20,41], PRHSX:[13.3,16.8,13,18.6,20,30], PRMTX:[13.8,18.6,13.5,21,20,33], PRNHX:[11.6,21,11.7,22.8,20,41], PRU:[6,36,8.8,33.1,20,25],
  PRWCX:[9.9,11.5,10.6,10.4,20,40], PSA:[10.3,19.3,12.1,20.6,20,42], PSI:[18.4,28.6,17.6,28.5,20,21], PSQ:[-16.7,17.7,-16.8,17.7,20,20], PSX:[18,32.5,18,32.5,14,14], PTTAX:[3.7,5.7,3.6,5.3,20,39], PTTRX:[4.1,5.7,5.8,5.4,20,39], PWR:[19.8,31.6,15.4,46.1,20,28],
  PYPL:[4.3,33.7,4.3,33.7,11,11], QCLN:[5.6,33.3,5.6,33.3,19,19], QCOM:[10.5,34.9,18.9,49.4,20,35], QEFA:[6.9,13.2,6.9,13.2,12,12], QEMM:[5.3,14.6,5.3,14.6,12,12], QLD:[25.5,37.9,25.9,37.8,20,20], QQEW:[12,18.4,11.8,18.4,20,20], QQQ:[16.6,18.6,10.6,23.3,20,27],
  QQQM:[17.8,21.1,17.8,21.1,6,6], QSR:[9,25.1,9,25.1,12,12], QUAL:[13.9,14.6,13.9,14.6,13,13], QUS:[12.6,13.9,12.6,13.9,11,11], QWLD:[10.5,12.6,10.5,12.6,12,12], RBLX:[-3.8,64.7,-3.8,64.7,5,5], RCL:[12.3,53.6,12.7,49.3,20,33], REET:[4.6,16.7,4.6,16.7,12,12],
  REGN:[20.7,42.1,12.1,86.1,20,35], REM:[-0.6,24.1,-0.6,24.1,19,19], REMX:[-4.3,35.4,-4.3,35.4,16,16], REZ:[7.2,20.8,7.2,20.8,19,19], RING:[3.8,37.6,3.8,37.6,14,14], RIO:[9.5,35,11.6,32.1,20,36], RIVN:[-34.5,74.5,-34.5,74.5,5,5], RL:[11.2,34.2,10.6,33.9,20,29],
  RMD:[13.2,26.6,19.9,36.6,20,31], ROBO:[9.5,21.6,9.5,21.6,13,13], ROKU:[21.1,73.7,21.1,73.7,9,9], ROP:[11.3,20.5,16.2,29.6,20,34], ROST:[19.9,23.4,16.9,42.8,20,41], RPBAX:[7.5,11.9,7.5,11.9,20,41], RPG:[12.1,18.7,11.7,18.6,20,20], RPMGX:[10.4,16.9,11.9,16.9,20,34],
  RPV:[9.2,22.3,9.1,22.1,20,20], RSG:[13.7,18.5,11.5,25.9,20,28], RSP:[10,17.3,10.8,16.4,20,23], RTX:[10.9,23.6,13,25.2,20,42], RUN:[1.8,79.8,1.8,79.8,11,11], RWR:[5.5,22.4,8.7,21.2,20,25], RYLD:[5.5,15.6,5.5,15.6,7,7], SAN:[4.2,40,8.2,37.1,20,39],
  SAP:[7.8,26.6,9.7,38,20,31], SBUX:[11.8,27.5,18.8,33.7,20,34], SCCO:[18.3,36.4,20.2,39.2,20,30], SCHA:[11.8,19.2,11.8,19.2,17,17], SCHB:[13.9,14.8,13.9,14.8,17,17], SCHD:[12.9,13.5,12.9,13.5,15,15], SCHE:[5.3,17.2,5.3,17.2,16,16], SCHF:[7.4,15.6,7.4,15.6,17,17],
  SCHG:[16.5,16.7,16.5,16.7,16,16], SCHH:[6.5,17.2,6.5,17.2,15,15], SCHK:[14.6,18.5,14.6,18.5,9,9], SCHM:[11,17.2,11,17.2,15,15], SCHO:[1.3,1.4,1.3,1.4,16,16], SCHP:[2.6,5,2.6,5,16,16], SCHR:[1.8,4.2,1.8,4.2,16,16], SCHV:[11.7,14.1,11.7,14.1,17,17],
  SCHW:[10.7,30.9,19.6,41.1,20,39], SCHX:[14.1,14.5,14.1,14.5,17,17], SCHZ:[1.9,4.6,1.9,4.6,15,15], SCZ:[6.2,18.8,6.2,18.8,19,19], SDS:[-24.8,28.3,-24.8,28.3,20,20], SDY:[8.7,15,8.9,14.8,20,21], SE:[24.8,59.8,24.8,59.8,9,9], SEDG:[6.8,66.3,6.8,66.3,11,11],
  SEQUX:[9.1,16.9,11.6,15.3,20,41], SGOL:[8.1,16.6,8.1,16.6,17,17], SGOV:[3,0.3,3,0.3,6,6], SH:[-11.2,14.6,-11.3,14.6,20,20], SHEL:[6,21.8,13.7,26,20,42], SHM:[1.8,2.6,1.8,2.6,19,19], SHOP:[38.3,52.6,38.3,52.6,11,11], SHV:[1.6,0.6,1.6,0.6,19,19],
  SHW:[16.4,22.1,16,24.3,20,42], SHY:[1.9,1.5,2,1.5,20,24], SHYG:[4.3,5.5,4.3,5.5,13,13], SIL:[4.5,39.8,4.5,39.8,16,16], SILJ:[2.7,47.5,2.7,47.5,14,14], SIVR:[8,31.8,8,31.8,17,17], SIZE:[11.5,15.3,11.5,15.3,13,13], SJNK:[4.8,5.7,4.8,5.7,14,14],
  SKYY:[15.2,21.2,15.2,21.2,15,15], SLB:[0.3,35.4,6.1,32,20,42], SLV:[7.2,32.5,7.3,32.5,20,20], SMCI:[18.3,62.8,18.3,62.8,19,19], SMCWX:[8.2,18.3,8.6,18.1,20,36], SMFG:[1,28.6,1.1,28.3,20,20], SMH:[20.3,25.6,11.2,31.2,20,26], SMIN:[8.9,24.1,8.9,24.1,14,14],
  SMLF:[11.1,19,11.1,19,11,11], SNAP:[-15.4,61.7,-15.4,61.7,9,9], SNOW:[2,58.7,2,58.7,6,6], SNPS:[16.8,25.1,12.2,34.6,20,34], SNVXX:[0,0,0,0,3,3], SNXFX:[11.1,15.5,10.8,14.8,20,35], SNY:[4,20.6,5.5,20.8,20,24], SO:[9.6,13.4,12.9,14.8,20,42],
  SOFI:[-0.7,63,-0.7,63,6,6], SONY:[5.6,29.9,6.3,35.3,20,53], SOXL:[39.4,87.4,39.4,87.4,16,16], SOXX:[19.1,27.3,14.4,30.2,20,25], SOYB:[0.9,16.8,0.9,16.8,15,15], SPAB:[3.1,4.4,3.1,4.4,19,19], SPBO:[3.2,6.1,3.2,6.1,15,15], SPDW:[4.9,17.6,4.9,17.6,19,19],
  SPEM:[5.4,20.2,5.4,20.2,19,19], SPG:[9.8,31.4,12.9,27.2,20,33], SPGI:[12.5,24.6,15.1,24.7,20,53], SPHB:[14.1,24.4,14.1,24.4,15,15], SPHD:[9.8,14.3,9.8,14.3,14,14], SPHIX:[6,8.7,7.4,8.4,20,36], SPIB:[4,4.2,4,4.2,17,17], SPLV:[10.1,11.7,10.1,11.7,15,15],
  SPMB:[2.3,4.3,2.3,4.3,17,17], SPMO:[18.8,17.3,18.8,17.3,11,11], SPOT:[15.6,44.9,15.6,44.9,8,8], SPSB:[2.4,1.7,2.4,1.7,16,16], SPSM:[10.1,19.5,10.1,19.5,13,13], SPTI:[2.5,3.8,2.5,3.8,19,19], SPTL:[3.3,12.6,3.3,12.6,19,19], SPTM:[11.2,15.7,9,15.2,20,26],
  SPTS:[1.4,2.7,1.4,2.7,15,15], SPXL:[31.1,46.2,31.1,46.2,18,18], SPXU:[-41.7,39.6,-41.7,39.6,17,17], SPY:[11.2,15.3,10.8,14.8,20,33], SPYD:[9.6,17.8,9.6,17.8,11,11], SPYG:[13.4,16.5,8.5,17.4,20,26], SPYV:[8.7,15.5,7.9,14.8,20,26], SQQQ:[-52.1,48.1,-52.1,48.1,16,16],
  SRE:[10.4,18.2,11.3,19.5,20,28], SRLN:[3.8,5.1,3.8,5.1,13,13], SRVR:[5,21.7,5,21.7,8,8], SSO:[15.4,31.2,15.5,31.2,20,20], STAG:[13.7,22.5,13.7,22.5,15,15], STIP:[2.3,2.2,2.3,2.2,16,16], STLD:[18,40,15.8,42.7,20,30], STZ:[9.1,28.7,13.7,29.7,20,34],
  SUB:[1.5,1.7,1.5,1.7,18,18], SVOL:[7.3,19.8,7.3,19.8,5,5], SWAGX:[1.6,5.2,1.6,5.2,9,9], SWISX:[5.6,17.2,5.3,16.6,20,29], SWLGX:[17.3,21,17.3,21,9,9], SWPPX:[11.3,15.3,9.5,15.4,20,29], SWSSX:[8.7,20.6,7.5,20.4,20,29], SWTSX:[11.2,15.7,8.6,15.5,20,27],
  SWVXX:[0,0,0,0,3,3], SYF:[11.4,34.6,11.4,34.6,12,12], SYK:[10.8,21.4,17.9,26.4,20,42], SYY:[7.4,18.8,13.1,19.4,20,42], T:[6.2,18.3,10.9,18.1,20,43], TAN:[-7,43.6,-7,43.6,18,18], TAP:[3,23.3,6.1,27.1,20,42], TCEHY:[19.3,32.5,19.3,32.5,16,16],
  TDG:[28.5,27.1,27.4,27.1,20,20], TEAM:[15.3,49.2,15.3,49.2,11,11], TECL:[47.1,60.3,47.1,60.3,18,18], TFC:[4.9,26.7,9.7,25.3,20,42], TFI:[3,5.7,3,5.7,19,19], TFLO:[2,0.6,2,0.6,12,12], TGT:[7,25.3,11.9,28.5,20,42], THD:[4.8,24.3,4.8,24.3,18,18],
  TIP:[3.4,5.7,3.5,5.7,20,23], TJX:[18.4,20.1,16.4,30.5,20,39], TLH:[2.8,10,2.8,10,19,19], TLT:[3,13.9,3.4,13.4,20,24], TM:[4.4,22,9.6,22.1,20,42], TMO:[13.8,23.7,13.8,28.7,20,42], TMUS:[6.5,34.5,6.5,34.5,19,19], TNA:[14.1,60.7,14.1,60.7,18,18],
  TOL:[8.8,39,13.6,52.1,20,40], TPINX:[2.8,7.4,5,7.1,20,40], TPR:[10.4,40.1,18.5,38.9,20,26], TQQQ:[40.6,54.9,40.6,54.9,16,16], TRBCX:[12.7,17.8,11.7,16.8,20,33], TRGP:[20.2,48.3,20.2,48.3,16,16], TRIP:[-4.7,48.1,-4.7,48.1,15,15], TRMCX:[10.2,17.1,11.7,16.2,20,30],
  TRV:[12.4,16.2,10.9,21,20,42], TSLA:[42.6,62,42.6,62,16,16], TSLL:[-14.2,103,-14.2,103,4,4], TSM:[24.7,28.4,19.8,37.9,20,29], TSN:[8.7,33.6,5.7,34.8,20,42], TT:[18,31.1,16.2,30.3,20,42], TTD:[23.3,68.5,23.3,68.5,10,10], TTE:[6.7,24.3,10,23.6,20,35],
  TTWO:[16.2,38.2,14.1,48,20,29], TUR:[0.7,33.9,0.7,33.9,18,18], TXN:[15,26.7,14.3,36.1,20,42], U:[-12.5,75.8,-12.5,75.8,6,6], UAL:[8.6,56.2,5.9,56.1,20,20], UBER:[8.3,49,8.3,49,7,7], UBS:[1.8,34.1,4.7,31.7,20,26], UDOW:[24.7,43.9,24.7,43.9,16,16],
  UL:[7.2,19.1,12.1,21.4,20,46], ULTA:[16.8,39.5,16.8,39.5,19,19], UNG:[-28.5,47.1,-28.5,47.1,19,19], UNH:[12.5,28.7,20.6,37.3,20,42], UNP:[15.9,23.4,13.2,22.5,20,42], UPRO:[31.4,44.4,31.4,44.4,17,17], UPS:[5.9,24,4.9,22.8,20,27], URA:[-4.4,37.1,-4.4,37.1,16,16],
  URI:[21.6,49.7,14.3,51.4,20,29], URNM:[26.2,45.9,26.2,45.9,7,7], USB:[6.5,25.1,12.7,23.9,20,42], USFR:[2,0.9,2,0.9,12,12], USHY:[4.8,9.9,4.8,9.9,9,9], USIG:[3.8,6.4,3.8,6.4,19,19], USMV:[11.4,11.1,11.4,11.1,15,15], USO:[-7.1,37.9,-7.2,37.7,20,20],
  USRT:[6.1,21.3,6.1,21.3,19,19], UVXY:[-79.2,100.6,-79.2,100.6,15,15], V:[17.6,20.8,17.6,20.8,18,18], VAIPX:[3.4,5.7,3.3,5.6,20,21], VALE:[7.1,42.6,13.5,41.9,20,24], VASGX:[8,13,8.6,12.6,20,32], VASIX:[4.3,5.3,5.6,4.9,20,32], VAW:[8.5,21,8.7,20.4,20,22],
  VB:[9.7,19.5,9.8,18.9,20,22], VBIAX:[8.3,10,7.2,9.7,20,26], VBILX:[4,5.4,3.9,5.4,20,25], VBIRX:[2.6,2.1,2.5,2.1,20,25], VBK:[10,20.1,9.8,19.6,20,22], VBLAX:[0.5,12.9,0.5,12.9,7,7], VBMFX:[3,3.7,5,4.2,20,39], VBR:[9.1,19.8,9.5,19.1,20,22],
  VBTLX:[3.2,4.3,3.1,4.2,20,25], VCIT:[4.2,6,4.2,6,17,17], VCLT:[4.5,10.7,4.5,10.7,17,17], VCR:[12,20.4,10.9,19.6,20,22], VCSH:[2.9,2.6,2.9,2.6,17,17], VDADX:[12.2,12.9,12.2,12.9,12,12], VDC:[9.4,12.2,9.1,11.7,20,22], VDE:[6.1,26.8,7.9,26.6,20,22],
  VDIGX:[9.9,12.8,9,12.2,20,34], VEA:[2,17.8,2,17.8,19,19], VEIEX:[5.5,20,6.5,21.4,20,32], VEIPX:[9.7,13.7,10.5,13,20,38], VEIRX:[10,13.9,9.3,13.5,20,25], VEMAX:[5.8,20.1,5.8,20.1,20,20], VEU:[5,17.8,5,17.8,19,19], VEVFX:[10.8,19.2,10.8,19.2,16,16],
  VEXAX:[10.1,19.5,9.1,19.2,20,26], VEXPX:[9.8,21,9.1,21.7,20,41], VFC:[2.4,30,8.2,31,20,42], VFFVX:[10.9,12.8,10.9,12.8,16,16], VFH:[6.6,21.3,6.8,20.3,20,22], VFIAX:[11.4,15.3,9,15.1,20,26], VFIDX:[4.3,5.6,4.1,5.4,20,25], VFIFX:[8.8,14.1,8.8,14.1,20,20],
  VFINX:[11,16.4,11.3,16,20,41], VFMF:[12.4,21,12.4,21,8,8], VFMO:[14.8,23.1,14.8,23.1,8,8], VFORX:[8.3,13.6,8.3,13.6,20,20], VFQY:[11.3,20.5,11.3,20.5,8,8], VFSUX:[3.1,2.7,2.9,2.5,20,25], VFVA:[11,24.7,11,24.7,8,8], VFWAX:[7.8,14.5,7.8,14.5,15,15],
  VGELX:[4.7,21.7,8.4,21.2,20,25], VGENX:[4.6,20.1,10.1,19.9,20,41], VGHAX:[9.9,13.7,9.5,13.2,20,25], VGHCX:[9.8,12.5,14.3,13.6,20,41], VGIAX:[11.1,15.5,9.4,15.1,20,25], VGIT:[2.3,4.2,2.3,4.2,17,17], VGK:[5.6,19,6.7,18.5,20,21], VGLT:[2.6,12.4,2.6,12.4,16,16],
  VGPMX:[3.6,31,7.2,30.1,20,41], VGSH:[1.4,1.4,1.4,1.4,17,17], VGSIX:[6,22,9,19.7,20,30], VGSLX:[5.8,21.9,8.1,20.8,20,25], VGSTX:[7.6,10.5,8.8,10,20,41], VGT:[16.9,19.9,15.1,19.5,20,22], VGTSX:[5.7,17.4,6,16.8,20,30], VHCAX:[13.3,17.5,12.3,17.7,20,25],
  VHGEX:[8,17.2,9.4,16.1,20,31], VHT:[10.4,14.5,9.7,14,20,22], VHYAX:[12.6,17.1,12.6,17.1,7,7], VICI:[8.9,30.2,8.9,30.2,9,9], VIG:[10.3,13.3,10.3,13.3,20,20], VIGAX:[13.4,17.2,9.9,16.8,20,26], VIMAX:[9.9,17.5,10,16.9,20,25], VINEX:[5.5,18.7,7.9,18.9,20,30],
  VIOO:[11.9,19,11.9,19,16,16], VIPSX:[3.3,5.7,4,5.7,20,26], VIS:[10.9,19.6,10.9,19,20,22], VLCAX:[11.4,15.4,11,14.8,20,22], VLO:[12.9,39.9,15.8,42,20,42], VLUE:[12.7,17.7,12.7,17.7,13,13], VLXVX:[10.9,15.5,10.9,15.5,9,9], VMBS:[2.2,4.1,2.2,4.1,17,17],
  VMFXX:[0,0,0,0,3,3], VMGMX:[12.1,16.7,12.1,16.7,15,15], VMLUX:[2.4,2.1,2.2,2,20,25], VMVAX:[12.1,15.5,12.1,15.5,15,15], VNM:[-1.4,24.1,-1.4,24.1,17,17], VNQ:[6,22,7.4,21.5,20,22], VNQI:[3.8,16.3,3.8,16.3,16,16], VO:[9.8,17.5,10.1,16.9,20,22],
  VOE:[9.3,17.6,9.3,17.6,20,20], VONE:[14.2,14.3,14.2,14.3,16,16], VONG:[16.3,15.8,16.3,15.8,16,16], VONV:[11.8,14.4,11.8,14.4,16,16], VOO:[14.4,14.1,14.4,14.1,16,16], VOOG:[16.2,15.4,16.2,15.4,16,16], VOOV:[11.9,14.3,11.9,14.3,16,16], VOT:[9.8,18.6,9.8,18.6,20,20],
  VOX:[7.9,17.2,8.7,16.8,20,22], VPCCX:[13,15.9,12.9,15.5,20,21], VPMAX:[13.5,16,12.2,15.8,20,25], VPMCX:[13.1,17.7,13.4,18.6,20,41], VPU:[8.6,14.4,9.7,13.9,20,22], VQNPX:[10.8,15,10.6,15.2,20,39], VRTX:[14.1,37.5,13.8,51.7,20,35], VSCGX:[5.6,7.6,6.6,7.2,20,32],
  VSEQX:[10.3,19.1,10.5,18.3,20,31], VSGAX:[11.6,18.2,11.6,18.2,15,15], VSGX:[8.8,17.6,8.8,17.6,8,8], VSIAX:[11.9,17.7,11.9,17.7,15,15], VSMAX:[9.8,19.5,9.5,19.2,20,26], VSMGX:[6.9,10.2,7.7,9.8,20,32], VSS:[8,16.9,8,16.9,17,17], VST:[32.8,37.9,32.8,37.9,10,10],
  VSTCX:[10.1,20.4,9.9,20.3,20,20], VSVNX:[16.7,13.5,16.7,13.5,4,4], VT:[9,16.6,9,16.6,18,18], VTABX:[2.4,4,2.4,4,13,13], VTAPX:[2.2,2.1,2.2,2.1,14,14], VTCLX:[11.4,15.6,10.1,15.3,20,25], VTEB:[2.4,4.9,2.4,4.9,11,11], VTHRX:[7.3,12.1,7.3,12.1,20,20],
  VTI:[11.1,15.8,9.8,15.3,20,25], VTIAX:[6.6,15,6.6,15,16,16], VTINX:[5.3,6,5.3,5.8,20,23], VTIP:[2.2,2.2,2.2,2.2,14,14], VTIVX:[8.6,14,8.9,13.4,20,23], VTMFX:[7.6,8.3,7.9,8.2,20,32], VTMGX:[6,17.4,5.8,16.8,20,27], VTR:[8.3,31.7,10.1,34.7,20,29],
  VTRIX:[5.5,17.5,6.5,17.3,20,41], VTSAX:[11.2,15.8,9.3,15.5,20,26], VTSMX:[11.1,15.8,10.7,15.1,20,34], VTTHX:[7.8,13,8,12.4,20,23], VTTSX:[10.8,12.6,10.8,12.6,14,14], VTTVX:[6.9,11,7,10.5,20,23], VTV:[9.2,15.2,9.5,14.5,20,22], VTWAX:[13.6,17.7,13.6,17.7,7,7],
  VTWNX:[6.3,9.7,6.3,9.7,20,20], VUG:[13.3,17.2,12.2,16.5,20,22], VUSXX:[0,0,0,0,3,3], VV:[11.4,15.5,11,14.8,20,22], VVIAX:[9.3,15.2,7.9,15.2,20,26], VWAHX:[3.9,5.8,6,5.7,20,41], VWALX:[4.1,5.9,4.1,5.6,20,25], VWEAX:[5.9,8,5.7,7.6,20,25],
  VWEHX:[5.6,8.1,7.1,7.1,20,41], VWELX:[8.5,10.8,10.1,10.3,20,41], VWENX:[8.8,10.3,8.5,9.9,20,25], VWIAX:[6.6,6.9,6.3,6.6,20,25], VWIGX:[7.2,19.8,8.9,18.1,20,41], VWILX:[7.5,19.5,8.6,18.6,20,25], VWINX:[6.4,6.9,8.6,7,20,41], VWITX:[3.2,3.9,5.2,4.1,20,41],
  VWIUX:[3.4,4.2,3.2,4.1,20,25], VWLUX:[3.8,5.5,3.7,5.4,20,25], VWNAX:[9.5,15.6,8.7,15,20,25], VWNDX:[8.7,17.9,10,17.2,20,41], VWNEX:[9,17,8.5,16.6,20,25], VWNFX:[9.3,15.2,11,15.3,20,41], VWO:[5.8,20.2,7.3,20.2,20,21], VWOB:[3.8,8.6,3.8,8.6,13,13],
  VWUSX:[12.1,20.5,8.7,21.7,20,41], VXF:[10,19.6,10.4,18.8,20,24], VXUS:[6.4,15,6.4,15,15,15], VXX:[-40.6,69.4,-40.6,69.4,8,8], VYM:[9.2,14.5,9.2,14.5,20,20], VYMI:[10.4,14.8,10.4,14.8,10,10], VZ:[6.6,16.7,8.8,17.1,20,42], W:[12.1,78.7,12.1,78.7,12,12],
  WBD:[7.5,41.3,6.7,40.5,20,21], WCLD:[4.8,36.5,4.8,36.5,7,7], WDAY:[8,36.5,8,36.5,14,14], WEAT:[-9.9,23.1,-9.9,23.1,15,15], WEC:[11.7,13.9,11.9,14.9,20,42], WELL:[14.1,21.5,14.4,20.4,20,42], WFC:[7.5,36.1,14.5,30.4,20,42], WING:[17.9,48.9,17.9,48.9,11,11],
  WM:[12.7,16.6,14.1,36.5,20,38], WMB:[10.9,33.1,11.7,38.6,20,42], WMT:[12.4,17.7,18.7,25.7,20,54], WPC:[11.7,22.2,11.5,21.2,20,28], WST:[15.4,29.7,14.2,27.9,20,42], WYNN:[4.3,50.6,11.8,49.1,20,24], XAR:[17.7,20.1,17.7,20.1,15,15], XBI:[12.5,27.1,11.8,26.9,20,20],
  XEL:[10.5,13.9,9.9,20.2,20,42], XLB:[8.3,20.2,8.2,20.7,20,28], XLC:[11.7,20.1,11.7,20.1,8,8], XLE:[6.7,26.3,8.9,25,20,28], XLF:[5.8,22.1,6,20.9,20,28], XLG:[11.6,15.4,11.4,15,20,21], XLI:[11.1,19,9.4,18.7,20,28], XLK:[16.7,19.2,9.7,23,20,28],
  XLP:[9,12.3,6.7,12.5,20,28], XLRE:[7.1,17,7.1,17,11,11], XLU:[8.6,14.7,7.8,15.2,20,28], XLV:[10.1,14.1,8.2,14.2,20,28], XLY:[11.7,19.4,9.3,19.2,20,28], XME:[5.6,34.5,5.3,34.4,20,20], XMHQ:[9.2,17.7,9.2,17.7,20,20], XOM:[6.8,26.8,11.7,21.7,20,42],
  XOP:[1.7,37.2,1.5,37.1,20,20], XPEV:[-7.9,87.1,-7.9,87.1,6,6], XRT:[9.7,24.7,9.8,24.7,20,20], XSD:[17.3,29.7,16.3,29.6,20,20], XYLD:[7.9,11,7.9,11,13,13], YUM:[13.6,22.9,13.9,25.9,20,29], ZBH:[2.3,25.3,5.6,25,20,25], ZROZ:[2.4,21.5,2.4,21.5,17,17],
  ZS:[19.9,56.9,19.9,56.9,8,8], ZTS:[7,23.6,7,23.6,13,13]
};
let HIST_NORM = null;
function histLookup(tk) {                                              // BRK.B, BRK-B, brkb all resolve
  if (!HIST_NORM) { HIST_NORM = {}; for (const k in HIST) HIST_NORM[tkNorm(k)] = HIST[k]; }
  return HIST_NORM[tkNorm(tk)] || null;
}
/* Normalized lookup: BRK.B, BRK-B, brk b and BRKB all resolve to the same entry. */
let TICKERS_NORM = null;
const tkNorm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function tickerLookup(tk) {
  if (!TICKERS_NORM) { TICKERS_NORM = {}; Object.keys(TICKERS).forEach(k => TICKERS_NORM[tkNorm(k)] = TICKERS[k]); }
  return TICKERS_NORM[tkNorm(tk)] || null;
}
function resolveHolding(h) {
  const tk = String(h.ticker || '').trim().toUpperCase();
  const lib = tickerLookup(tk);
  const cls = h.cls || (lib ? lib[0] : 'custom');
  const base = ASSET_CLASSES[cls] || ASSET_CLASSES.custom;
  const basis = (STATE.portfolios && STATE.portfolios.settings && STATE.portfolios.settings.retBasis) || 'forward';
  const hAll = histLookup(tk);                                          // real trailing history for this ticker, if we have it
  const hd = basis !== 'forward' ? hAll : null;
  const histRet = hd ? (basis === 'hlife' ? hd[2] : hd[0]) : null;      // hlife = since inception, else trailing 20yr
  const histVol = hd ? (basis === 'hlife' ? hd[3] : hd[1]) : null;
  const histYrs = hd ? (basis === 'hlife' ? hd[5] : hd[4]) : 0;
  const ret = h.ret != null && h.ret !== '' ? +h.ret : histRet != null ? histRet : (lib && lib[3] != null ? lib[3] : base.ret);
  const vol = h.vol != null && h.vol !== '' ? +h.vol : histVol != null ? histVol : (lib && lib[2] != null ? lib[2] : base.vol);
  const name = h.name || (lib ? lib[1] : '');
  const single = vol > (ASSET_CLASSES[cls] ? ASSET_CLASSES[cls].vol : SINGLE_STOCK_VOL) * 1.25;
  const usedHist = histRet != null && (h.ret == null || h.ret === '');  // real history is driving this row's return
  return { ticker: tk, known: !!lib, cls, ret, vol, name, single, weight: +h.weight || 0,
           histAvail: !!hAll, usedHist, histYrs };
}
function portfolioStats(holdings) {
  const rs = (holdings || []).map(resolveHolding).filter(r => r.weight > 0);
  const totW = rs.reduce((s, r) => s + r.weight, 0);
  if (!rs.length || totW <= 0) return null;
  rs.forEach(r => r.w = r.weight / totW);
  const mean = rs.reduce((s, r) => s + r.w * r.ret, 0);
  let variance = 0;
  for (let i = 0; i < rs.length; i++) for (let j = 0; j < rs.length; j++) {
    const a = rs[i], b = rs[j];
    let rho;
    if (i === j) rho = 1;
    else if (a.cls === b.cls) rho = (a.single && b.single) ? .55 : (a.single || b.single) ? .70 : .95;
    else rho = clsCorr(a.cls, b.cls) * ((a.single || b.single) ? .85 : 1);
    variance += a.w * b.w * (a.vol / 100) * (b.vol / 100) * rho;
  }
  const byClass = {};
  rs.forEach(r => byClass[r.cls] = (byClass[r.cls] || 0) + r.w);
  const unknown = rs.filter(r => !r.known && !r.cls).map(r => r.ticker);
  return { mean: mean / 100, vol: Math.sqrt(variance), holdings: rs, totW, byClass, unknown };
}
/* Retirement-income Monte Carlo — draw an (inflation-adjusted) withdrawal from the portfolio each year. */
function withdrawMC(start, years, wd0, infl, mean, vol, trials) {
  trials = trials || 1200; years = Math.max(1, Math.round(years));
  const paths = [], deplYears = []; let successes = 0;
  for (let i = 0; i < trials; i++) {
    let b = start, gone = null; const p = [b];
    for (let y = 0; y < years; y++) {
      const wd = wd0 * pow(1 + infl, y);
      b = b * (1 + Math.max(-0.6, randNormal(mean, vol))) - wd;
      if (b <= 0) { b = 0; if (gone == null) gone = y + 1; }
      p.push(b);
    }
    if (gone == null) { successes++; deplYears.push(years + 1); } else deplYears.push(gone);
    paths.push(p);
  }
  const idx = pPct => Math.min(trials - 1, Math.floor(trials * pPct));
  const bandAt = pPct => { const out = []; for (let y = 0; y <= years; y++) { const col = paths.map(p => p[y]).sort((a, b) => a - b); out.push(col[idx(pPct)]); } return out; };
  const endings = paths.map(p => p[years]).sort((a, b) => a - b);
  deplYears.sort((a, b) => a - b);
  return { trials, years, success: successes / trials,
    p10: bandAt(.10), p50: bandAt(.50), p90: bandAt(.90),
    endP10: endings[idx(.10)], endP50: endings[idx(.50)], endP90: endings[idx(.90)],
    lastYearsP10: deplYears[idx(.10)] };
}
/* Sustainable withdrawal at a confidence level — bisect the first-year draw until success ≈ conf. */
function swrAt(start, years, infl, mean, vol, conf) {
  if (!(start > 0)) return 0;
  conf = conf || 0.9;
  const ok = wd => withdrawMC(start, years, wd, infl, mean, vol, 500).success >= conf;
  let lo = 0, hi = start * 0.12;
  if (!ok(lo + start * 0.001)) return 0;
  for (let i = 0; i < 11; i++) { const mid = (lo + hi) / 2; if (ok(mid)) lo = mid; else hi = mid; }
  return lo;
}
/* Standalone accumulation Monte Carlo — grow a lump sum (plus annual additions) under the portfolio. */
function growthMC(start, years, annual, mean, vol, trials) {
  trials = trials || 1500; years = Math.max(1, Math.round(years));
  const paths = [];
  for (let i = 0; i < trials; i++) {
    let b = start; const p = [b];
    for (let y = 0; y < years; y++) { b = Math.max(0, b * (1 + Math.max(-0.6, randNormal(mean, vol))) + annual); p.push(b); }
    paths.push(p);
  }
  const idx = pPct => Math.min(trials - 1, Math.floor(trials * pPct));
  const bandAt = pPct => { const out = []; for (let y = 0; y <= years; y++) { const col = paths.map(p => p[y]).sort((a, b) => a - b); out.push(col[idx(pPct)]); } return out; };
  const endings = paths.map(p => p[years]).sort((a, b) => a - b);
  const invested = start + annual * years;
  return { trials, years, p10: bandAt(.10), p50: bandAt(.50), p90: bandAt(.90),
    endP10: endings[idx(.10)], endP50: endings[idx(.50)], endP90: endings[idx(.90)],
    lossProb: endings.filter(e => e < invested).length / trials, invested };
}
/* Async runner + cache: analyses keyed by portfolio + plan signature; debounced so typing stays smooth. */
const PL_CACHE = new Map();
let PL_TIMER = null;
function plSignature() {
  const P = STATE.portfolios || {};
  return JSON.stringify([P.settings, P.current, P.proposed, mcSignature(STATE)]);
}
function plRunNow() {
  const sig = plSignature();
  if (PL_CACHE.has(sig)) return PL_CACHE.get(sig);
  const P = STATE.portfolios, st = P.settings || {};
  const run = key => {
    const stats = portfolioStats(plHoldings(key));           // $ amounts resolve to effective weights
    if (!stats) return null;
    const res = { stats };
    const mode = st.mode || 'plan';
    if (mode === 'plan') res.mc = monteCarlo(STATE, +st.trials || 800, { mean: stats.mean, vol: stats.vol });
    else if (mode === 'withdraw') {
      const start = +st.start || RESULTS.investable || 1000000;
      const infl = st.inflateWd === false ? 0 : (+STATE.assumptions.inflation || 0) / 100;
      const wd0 = (st.wdType || 'pct') === 'pct' ? start * (+st.wdPct || 0) / 100 : (+st.wdAmount || 0);
      res.w = withdrawMC(start, +st.years || 30, wd0, infl, stats.mean, stats.vol, +st.trials || 1200);
      res.w.start = start; res.w.wd0 = wd0;
      res.swr = swrAt(start, +st.years || 30, infl, stats.mean, stats.vol, 0.9);
    }
    else res.g = growthMC(+st.start || RESULTS.investable || 100000, +st.years || 30, +st.annual || 0, stats.mean, stats.vol, 1500);
    return res;
  };
  const out = { current: run('current'), proposed: run('proposed') };
  PL_CACHE.set(sig, out);
  if (PL_CACHE.size > 6) PL_CACHE.delete(PL_CACHE.keys().next().value);
  return out;
}
function plAsync(onReady) {
  const hit = PL_CACHE.get(plSignature());
  if (hit) return hit;
  clearTimeout(PL_TIMER);
  PL_TIMER = setTimeout(() => { plRunNow(); if (onReady) onReady(); }, 350);
  return null;
}

/* ----------------------------- Social Security optimizer ------------------ */
/* Benefit factors relative to PIA (Full Retirement Age = 67) for claim ages. */
function ssFactor(claimAge, fra) {
  fra = fra || 67;
  if (claimAge >= fra) return 1 + Math.min(70, claimAge - fra) * 0.08;       // +8%/yr delayed credits, capped at 70
  const monthsEarly = (fra - claimAge) * 12;
  const first = Math.min(36, monthsEarly), beyond = Math.max(0, monthsEarly - 36);
  return Math.max(0.5, 1 - (first * 5 / 9 + beyond * 5 / 12) / 100);          // 5/9%/mo first 36, 5/12%/mo beyond
}
function ssOptimize(pia, currentAge, lifeExp, cola) {
  cola = cola || 0;
  const claims = [62, 67, 70];
  const rows = claims.map(claim => {
    const annual = pia * ssFactor(claim, 67);
    let lifetime = 0;
    for (let age = claim; age <= lifeExp; age++) lifetime += annual * pow(1 + cola, age - claim);
    return { claim, annual, lifetime };
  });
  let best = rows[0]; rows.forEach(r => { if (r.lifetime > best.lifetime) best = r; });
  return { rows, best };
}

/* ----------------------------- compute engine ----------------------------- */
function computeGoal(g, ctx) {
  const { infl, pre, eduI, capitalNeeded, projAtRet, totalProtNeed, existingLife, endingBalance = 0, estate = {}, curAge = 0, annualExp = 0, cash = 0 } = ctx;
  const years = +g.years || 0;
  let target, projected, reqMonthly = 0;
  const accum = (tgt, yrs) => { projected = fv(+g.funded || 0, pre, yrs) + fvAnnuity((+g.monthly || 0) * 12, pre, yrs); reqMonthly = pmtForFV(Math.max(0, tgt - fv(+g.funded || 0, pre, yrs)), pre, yrs) / 12; return tgt; };
  if (g.type === 'retirement') { target = capitalNeeded; projected = projAtRet; }
  else if (g.type === 'protection') { target = totalProtNeed; projected = existingLife; }
  else if (g.type === 'legacy') { target = (+g.amount || +estate.legacyTarget || 0); projected = endingBalance; }   // funded by the projected estate
  else if (g.type === 'home') {                                              // save the down payment by the purchase date
    const yrs = Math.max(0, (+g.buyAge || 0) - curAge);
    target = accum((+g.price || 0) * ((g.downPct != null ? +g.downPct : 20) / 100) * pow(1 + infl, yrs), yrs);
  }
  else if (g.type === 'emergency') { target = (g.months != null ? +g.months : 6) * (annualExp / 12); projected = cash + (+g.funded || 0); }
  else if (g.type === 'ltc') {                                               // future care cost over a duration, net of insurance coverage
    const yrs = Math.max(0, (+g.startAge || 0) - curAge), dur = Math.max(1, +g.duration || 1), cov = (+g.coverage || 0) / 100;
    let fc = 0; for (let k = 0; k < dur; k++) fc += (+g.amount || 0) * (1 - cov) * pow(1 + infl, yrs + k);
    target = accum(fc, yrs);
  }
  else if (g.type === 'purchase') {                                          // cash or financed; save the cash price or the down payment
    const bA = +g.buyAge || (curAge + years), yrs = Math.max(0, bA - curAge), financed = (+g.term || 0) > 0;
    const base = financed ? (+g.amount || 0) * ((g.downPct != null ? +g.downPct : 20) / 100) : (+g.amount || 0);
    target = accum(base * pow(1 + infl, yrs), yrs);
  }
  else if (['custom', 'travel', 'gifting', 'charitable'].includes(g.type)) {  // recurring/one-time spend over a period, own inflation
    const gi = (g.inflation != null && g.inflation !== '' ? +g.inflation : infl * 100) / 100;
    const sA = +g.startAge || curAge, eA = Math.max(sA, +g.endAge || sA), freq = g.frequency || 'once', yTo = Math.max(0, sA - curAge);
    let tgt;
    if (freq === 'once') tgt = (+g.amount || 0) * pow(1 + gi, yTo);
    else { const per = (+g.amount || 0) * (freq === 'monthly' ? 12 : 1); tgt = 0; for (let a = sA; a <= eA; a++) tgt += per * pow(1 + gi, Math.max(0, a - curAge)); }
    target = accum(tgt, yTo);
  }
  else if (g.type === 'education') {
    const dur = Math.max(1, +g.duration || 1), cost = +g.amount || 0;
    let fc = 0; for (let k = 0; k < dur; k++) fc += cost * pow(1 + eduI, years + k);
    target = fc;
    projected = fv(+g.funded || 0, pre, years) + fvAnnuity((+g.monthly || 0) * 12, pre, years);
    reqMonthly = pmtForFV(Math.max(0, fc - fv(+g.funded || 0, pre, years)), pre, years) / 12;
  } else {
    target = (+g.amount || 0) * pow(1 + infl, years);
    projected = fv(+g.funded || 0, pre, years) + fvAnnuity((+g.monthly || 0) * 12, pre, years);
    reqMonthly = pmtForFV(Math.max(0, target - fv(+g.funded || 0, pre, years)), pre, years) / 12;
  }
  const ratio = target > 0 ? projected / target : 1;
  return { ...g, target, projected, reqMonthly, ratio, gap: target - projected };
}

function compute(S) {
  const A = S.assumptions, H = S.household, I = S.income, E = S.expenses, SV = S.savings, P = S.protection, INS = S.insurance;
  const infl = A.inflation / 100, pre = A.preReturn / 100, post = A.postReturn / 100,
        eduI = A.eduInflation / 100, tax = A.effectiveTaxRate / 100, salg = (+I.salaryGrowth || 0) / 100;
  const c = H.client, sp = H.spouse, spOn = !!sp.included;
  const curAge = +c.age || 0, retAge = +c.retireAge || 0, life = +c.lifeExpectancy || 90;
  const endAge = Math.max(life, spOn ? (+sp.lifeExpectancy || life) : life);
  const alreadyRetired = curAge >= retAge;
  const yearsToRet = alreadyRetired ? 0 : Math.max(0, retAge - curAge);
  const retYears = Math.max(1, life - retAge);
  const retHorizon = Math.max(0, life - curAge);   /* years of plan remaining from today */

  /* assets */
  const list = S.assets || []; const byType = {}; let totalAssets = 0;
  list.forEach(a => { const v = +a.balance || 0; byType[a.type] = (byType[a.type] || 0) + v; totalAssets += v; });
  const cash = byType.cash || 0, taxable = byType.taxable || 0, trad = byType.traditional || 0,
        roth = byType.roth || 0, eduAssets = byType.education || 0, re = byType.realestate || 0, other = byType.other || 0;
  const investable = cash + taxable + trad + roth + other;
  const deferredFrac = investable > 0 ? trad / investable : 0;

  /* liabilities */
  let totalLiab = 0; (S.liabilities || []).forEach(l => totalLiab += (+l.balance || 0));
  const netWorth = totalAssets - totalLiab;

  /* income / expense / savings */
  const grossIncome = (+I.clientSalary || 0) + (spOn ? (+I.spouseSalary || 0) : 0) + (+I.otherIncome || 0);
  const annualExp = livingExpenses(E);
  const retExpToday = annualExp * ((+E.retirementExpensePct || 100) / 100);
  const acct = SV.mode === 'accounts' ? acctContribsFor(S) : null;
  const baseContrib = SV.mode === 'percent' ? (+SV.savingsRatePct || 0) / 100 * grossIncome : acct ? acct.employee : (+SV.annualSavings || 0);
  const empMatch = SV.mode === 'percent' ? grossIncome * Math.min((+SV.savingsRatePct || 0) / 100, (+SV.matchLimitPct || 0) / 100) * ((+SV.matchPct || 0) / 100)
    : acct ? acct.match
    : (+SV.employerMatch || 0);
  const annualSavings = baseContrib + empMatch;
  const savingsRate = grossIncome > 0 ? annualSavings / grossIncome : 0;
  const emergencyMonths = annualExp > 0 ? cash / (annualExp / 12) : 0;
  const guaranteedToday = (+I.ssClient || 0) + (spOn ? (+I.ssSpouse || 0) : 0) + (+I.pension || 0);

  /* retirement needs (clean "the number") — framing differs for clients already retired */
  let projAtRet, needAtRet, guaranteedAtRet, capitalNeeded, extraMonthly;
  if (alreadyRetired) {
    projAtRet = investable;                                          // current portfolio (no future growth/savings added)
    needAtRet = retExpToday;                                         // today's $, no inflation forward
    guaranteedAtRet = guaranteedToday;
    capitalNeeded = pvGrowingAnnuity(Math.max(0, needAtRet - guaranteedAtRet), post, infl, retHorizon);
    extraMonthly = 0;
  } else {
    projAtRet = fv(investable, pre, yearsToRet) + fvAnnuity(annualSavings, pre, yearsToRet);
    needAtRet = retExpToday * pow(1 + infl, yearsToRet);
    guaranteedAtRet = guaranteedToday * pow(1 + infl, yearsToRet);
    capitalNeeded = pvGrowingAnnuity(Math.max(0, needAtRet - guaranteedAtRet), post, infl, retYears);
    extraMonthly = pmtForFV(Math.max(0, capitalNeeded - projAtRet), pre, yearsToRet) / 12;
  }
  /* year-by-year simulation (taxes, three tax buckets, debt amortization, RMDs, events) */
  const sim = simulate(S);
  const rows = sim.rows;
  const endingBalance = sim.endingBalance;
  const depletionAge = sim.depletionAge;

  /* Gross the capital need up for taxes, using the simulation's first retirement year — the
     analytic gap is pre-tax, but every real withdrawal must also cover the taxes it creates. */
  const r1 = rows.find(r => r.phase === 'retire');
  if (r1) {
    const g1 = (r1.ss || 0) + (r1.pension || 0) + (r1.annuity || 0);
    const netGap = Math.max(0, (r1.need || 0) - g1);
    if (netGap > 0 && (r1.withdrawal || 0) > netGap) capitalNeeded *= clamp(r1.withdrawal / netGap, 1, 3);
  }
  const fundedRatio = capitalNeeded > 0 ? projAtRet / capitalNeeded : (projAtRet > 0 ? 2 : 1);
  const surplus = projAtRet - capitalNeeded;
  const shortfallFV = Math.max(0, capitalNeeded - projAtRet);
  if (!alreadyRetired) extraMonthly = pmtForFV(shortfallFV, pre, yearsToRet) / 12;   // reflects the tax-grossed capital need

  /* quick education needs */
  const QE = S.quickEducation || {};
  const eYears = +QE.yearsUntil || 0, eDur = Math.max(1, +QE.duration || 1), eCost = +QE.annualCost || 0,
        eFunded = +QE.funded || 0, eMon = +QE.monthly || 0;
  let eduFuture = 0; for (let k = 0; k < eDur; k++) eduFuture += eCost * pow(1 + eduI, eYears + k);
  const eduProjected = fv(eFunded, pre, eYears) + fvAnnuity(eMon * 12, pre, eYears);
  const eduGap = eduFuture - eduProjected;
  const eduFundedRatio = eduFuture > 0 ? eduProjected / eduFuture : 1;
  const eduReqMonthly = pmtForFV(Math.max(0, eduFuture - fv(eFunded, pre, eYears)), pre, eYears) / 12;

  /* protection (life insurance) needs */
  const realRate = Math.max(0.0005, (1 + post) / (1 + infl) - 1);
  const cInc = pvAnnuity((+I.clientSalary || 0) * ((P.replacePct || 0) / 100), realRate, P.replaceYears || 0) + (P.finalExpenses || 0);
  const sInc = spOn ? pvAnnuity((+I.spouseSalary || 0) * ((P.replacePct || 0) / 100), realRate, P.replaceYears || 0) + (P.finalExpenses || 0) : 0;
  const shared = (P.includeDebt ? totalLiab : 0) + (P.includeEducation ? eduFuture : 0);
  const totalProtNeed = cInc + sInc + shared;
  const existingLife = (+INS.lifeClient || 0) + (spOn ? (+INS.lifeSpouse || 0) : 0);
  const protGap = Math.max(0, totalProtNeed - existingLife - investable);

  /* goals */
  const estate = S.estate || {};
  const goalCtx = { infl, pre, eduI, capitalNeeded, projAtRet, totalProtNeed, existingLife, endingBalance, estate, curAge, annualExp, cash };
  const goals = (S.goals || []).map(g => computeGoal(g, goalCtx));
  if ((+estate.legacyTarget || 0) > 0 && !goals.some(g => g.type === 'legacy'))   // estate legacy target funds a real goal vs projected estate
    goals.push(computeGoal({ id: 'estate-legacy', name: 'Legacy / Estate', type: 'legacy', priority: 'Legacy' }, goalCtx));

  /* allocation */
  const alloc = [
    { label: 'Cash',         value: cash,    color: '#9fb0c2' },
    { label: 'Taxable',      value: taxable, color: '#C8A46A' },
    { label: 'Tax-Deferred', value: trad,    color: '#0F1A2B' },
    { label: 'Roth',         value: roth,    color: '#2F7D62' },
    { label: 'Education',    value: eduAssets, color: '#E6C789' },
    { label: 'Real Estate',  value: re,      color: '#5B6B80' },
    { label: 'Other',        value: other,   color: '#b08968' }
  ].filter(x => x.value > 0);

  return { curAge, retAge, life, endAge, yearsToRet, retYears, alreadyRetired, retHorizon, totalAssets, totalLiab, netWorth, byType,
    cash, taxable, trad, roth, eduAssets, re, investable, grossIncome, annualExp, retExpToday, annualSavings,
    savingsRate, emergencyMonths, guaranteedToday, projAtRet, needAtRet, guaranteedAtRet, capitalNeeded,
    fundedRatio, surplus, shortfallFV, extraMonthly, rows, endingBalance, depletionAge, eduFuture, eduProjected,
    eduGap, eduFundedRatio, eduReqMonthly, cInc, sInc, totalProtNeed, existingLife, protGap, goals, alloc, spOn,
    lifetimeTax: sim.lifetimeTax, lifetimeFedTax: sim.lifetimeFedTax, lifetimeStateTax: sim.lifetimeStateTax,
    taxNow: rows[0] || {}, planLastsToLife: depletionAge == null };
}

/* ----------------------------- insights (CoPlanner) ----------------------- */
function buildInsights(R) {
  const out = [];
  const add = (sev, title, detail, action) => out.push({ sev, title, detail, action });

  // Retirement readiness
  if (R.fundedRatio >= 1) add('good', 'Retirement is on track',
    `Projected assets of ${fmt$(R.projAtRet)} at retirement exceed the estimated ${fmt$(R.capitalNeeded)} needed to fund the lifestyle goal.`,
    `Surplus of ${fmt$(R.surplus)} — consider tax-efficient withdrawal sequencing and legacy planning.`);
  else if (R.fundedRatio >= 0.8) add('warn', 'Retirement is nearly funded',
    `Projected to cover ${pct(R.fundedRatio * 100, 0)} of the retirement goal — a gap of about ${fmt$(R.shortfallFV)} at retirement.`,
    `Saving an additional ${fmt$(R.extraMonthly)}/mo would close the gap.`);
  else add('bad', 'Retirement funding gap',
    `Current trajectory funds ${pct(R.fundedRatio * 100, 0)} of the goal, leaving a projected shortfall of ${fmt$(R.shortfallFV)}.`,
    `Closing it requires roughly ${fmt$(R.extraMonthly)}/mo more, a later retirement age, or adjusted spending.`);

  if (R.depletionAge != null) add('bad', 'Portfolio longevity risk',
    `Under current assumptions the investment portfolio is projected to be depleted at age ${R.depletionAge}.`,
    `Model a lower withdrawal rate or delayed Social Security in the Decision Center.`);

  // Savings rate
  if (R.savingsRate >= 0.15) add('good', 'Strong savings rate',
    `Saving ${pct(R.savingsRate * 100, 0)} of gross income — above the 15% benchmark.`, '');
  else if (R.savingsRate >= 0.10) add('warn', 'Moderate savings rate',
    `Saving ${pct(R.savingsRate * 100, 0)} of income. Many households target 15%+.`,
    `An additional ${fmt$(Math.max(0, 0.15 * R.grossIncome - R.annualSavings) / 12)}/mo reaches the 15% benchmark.`);
  else if (R.grossIncome > 0) add('bad', 'Low savings rate',
    `Saving only ${pct(R.savingsRate * 100, 0)} of income limits future flexibility.`,
    `Prioritize automated contributions and capturing the full employer match.`);

  // Emergency fund
  if (R.annualExp > 0) {
    if (R.emergencyMonths >= 6) add('good', 'Healthy cash reserve',
      `${R.emergencyMonths.toFixed(1)} months of expenses held in cash.`, '');
    else if (R.emergencyMonths >= 3) add('warn', 'Build cash reserve',
      `${R.emergencyMonths.toFixed(1)} months of expenses in cash — aim for 6 months.`,
      `Target reserve: ${fmt$(R.annualExp / 2)}.`);
    else add('bad', 'Thin emergency reserve',
      `Only ${R.emergencyMonths.toFixed(1)} months of expenses in accessible cash.`,
      `Build toward ${fmt$(R.annualExp / 2)} (6 months) before increasing risk assets.`);
  }

  // Protection
  if (R.protGap > 0) add(R.protGap > R.grossIncome * 3 ? 'bad' : 'warn', 'Life insurance gap',
    `Estimated protection need exceeds current coverage and assets by ${fmt$(R.protGap)}.`,
    `Review term coverage to protect the family's income and goals.`);
  else add('good', 'Protection adequately covered',
    `Current coverage and assets meet the estimated protection need.`, '');

  // Education
  if (R.eduFuture > 0) {
    if (R.eduGap > 0) add('warn', 'Education funding gap',
      `Projected to cover ${pct(R.eduFundedRatio * 100, 0)} of education costs — short by ${fmt$(R.eduGap)}.`,
      `Approximately ${fmt$(R.eduReqMonthly)}/mo fully funds the goal.`);
    else add('good', 'Education goal on track',
      `Projected savings cover the estimated education costs.`, '');
  }

  // Tax diversification
  const inv = R.investable || 1;
  if ((R.roth / inv) < 0.1 && inv > 0) add('info', 'Limited tax diversification',
    `Roth assets are ${pct((R.roth / inv) * 100, 0)} of investable assets.`,
    `Consider Roth contributions/conversions to add tax-free flexibility in retirement.`);

  const order = { bad: 0, warn: 1, info: 2, good: 3 };
  return out.sort((a, b) => order[a.sev] - order[b.sev]);
}
function readinessScore(R) {
  let s = 0;
  s += clamp(R.fundedRatio, 0, 1) * 40;
  s += clamp(R.savingsRate / 0.15, 0, 1) * 15;
  s += clamp(R.emergencyMonths / 6, 0, 1) * 10;
  s += (R.protGap <= 0 ? 1 : clamp(1 - R.protGap / (R.totalProtNeed || 1), 0, 1)) * 15;
  s += (R.eduFuture <= 0 ? 1 : clamp(R.eduFundedRatio, 0, 1)) * 10;
  s += clamp((R.roth / (R.investable || 1)) / 0.2, 0, 1) * 10;
  return Math.round(clamp(s, 0, 100));
}

/* ----------------------------- SVG charts --------------------------------- */
function lineChart(series, opts = {}) {
  const W = opts.w || 760, H = opts.h || 250, pad = { l: 56, r: 16, t: 16, b: 28 };
  const xs = series.flatMap(s => s.points.map(p => p.x));
  const ys = series.flatMap(s => s.points.map(p => p.y));
  const xMin = opts.xMin ?? Math.min(...xs), xMax = opts.xMax ?? Math.max(...xs);
  const yMin = opts.yMin ?? 0, yMax = (opts.yMax ?? (Math.max(...ys, 1) * 1.08)) || 1;
  const sx = x => pad.l + (x - xMin) / ((xMax - xMin) || 1) * (W - pad.l - pad.r);
  const sy = y => H - pad.b - (y - yMin) / ((yMax - yMin) || 1) * (H - pad.t - pad.b);
  let grid = '', ylab = '';
  for (let i = 0; i <= 4; i++) {
    const v = yMin + (yMax - yMin) * i / 4, yy = sy(v);
    grid += `<line class="grid-line" x1="${pad.l}" y1="${yy}" x2="${W - pad.r}" y2="${yy}"/>`;
    ylab += `<text class="lbl amount" x="${pad.l - 8}" y="${yy + 3}" text-anchor="end">${fmtK(v)}</text>`;
  }
  let xlab = ''; const xt = opts.xticks || 6;
  for (let i = 0; i <= xt; i++) { const xv = xMin + (xMax - xMin) * i / xt; xlab += `<text class="lbl" x="${sx(xv)}" y="${H - 8}" text-anchor="middle">${Math.round(xv)}</text>`; }
  let mk = ''; (opts.markers || []).forEach(m => {
    const atStart = m.x <= xMin;                 // e.g. an already-retired client: "Retire" sits at/before "now"
    const mx = sx(atStart ? xMin : m.x);
    mk += `<line class="marker-line" x1="${mx}" y1="${pad.t}" x2="${mx}" y2="${H - pad.b}"/><text class="lbl-strong" x="${mx}" y="${pad.t + 9}" text-anchor="middle">${escapeHtml(atStart ? 'Now' : m.label)}</text>`;
  });
  let paths = '';
  series.forEach(s => {
    if (!s.points.length) return;
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(' ');
    if (s.fill) {
      const x0 = sx(s.points[0].x).toFixed(1), x1 = sx(s.points[s.points.length - 1].x).toFixed(1), yb = sy(yMin).toFixed(1);
      paths += `<path class="area" d="${d} L${x1} ${yb} L${x0} ${yb} Z" fill="${s.color}"/>`;
    }
    paths += `<path class="line" d="${d}" stroke="${s.color}"${s.dash ? ' stroke-dasharray="5 4"' : ''}/>`;
  });
  let hi = '';
  if (opts.highlight) {
    const hx = sx(opts.highlight.x), hy = sy(opts.highlight.y), col = opts.highlight.color || 'var(--gold-deep)';
    hi = `<line x1="${hx.toFixed(1)}" y1="${pad.t}" x2="${hx.toFixed(1)}" y2="${H - pad.b}" stroke="${col}" stroke-width="1.5" stroke-dasharray="4 3" opacity=".65"/><circle cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="6" fill="${col}" stroke="#fff" stroke-width="2.5"/>`;
  }
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">${grid}${mk}${paths}${hi}<line class="axis" x1="${pad.l}" y1="${H - pad.b}" x2="${W - pad.r}" y2="${H - pad.b}"/>${ylab}${xlab}</svg>`;
}

function bandChart(ages, lo, mid, hi, opts = {}) {
  const W = opts.w || 760, H = opts.h || 250, pad = { l: 56, r: 16, t: 16, b: 28 };
  const xMin = ages[0], xMax = ages[ages.length - 1];
  const yMax = (Math.max(...hi, 1) * 1.08) || 1, yMin = 0;
  const sx = x => pad.l + (x - xMin) / ((xMax - xMin) || 1) * (W - pad.l - pad.r);
  const sy = y => H - pad.b - (y - yMin) / ((yMax - yMin) || 1) * (H - pad.t - pad.b);
  let grid = '', ylab = '';
  for (let i = 0; i <= 4; i++) { const v = yMax * i / 4, yy = sy(v); grid += `<line class="grid-line" x1="${pad.l}" y1="${yy}" x2="${W - pad.r}" y2="${yy}"/>`; ylab += `<text class="lbl amount" x="${pad.l - 8}" y="${yy + 3}" text-anchor="end">${fmtK(v)}</text>`; }
  let xlab = ''; for (let i = 0; i <= 6; i++) { const xv = xMin + (xMax - xMin) * i / 6; xlab += `<text class="lbl" x="${sx(xv)}" y="${H - 8}" text-anchor="middle">${Math.round(xv)}</text>`; }
  const top = ages.map((a, i) => `${i ? 'L' : 'M'}${sx(a).toFixed(1)} ${sy(hi[i]).toFixed(1)}`).join(' ');
  const bot = ages.map((a, i) => `${sx(a).toFixed(1)} ${sy(lo[i]).toFixed(1)}`).reverse().map((p, i) => `${i ? 'L' : 'L'}${p}`).join(' ');
  const area = `<path d="${top} ${bot} Z" fill="var(--gold)" opacity=".18"/>`;
  const midPath = `<path class="line" d="${ages.map((a, i) => `${i ? 'L' : 'M'}${sx(a).toFixed(1)} ${sy(mid[i]).toFixed(1)}`).join(' ')}" stroke="var(--gold-deep)"/>`;
  let mk = ''; (opts.markers || []).forEach(m => { const atStart = m.x <= xMin; const mx = sx(atStart ? xMin : m.x); mk += `<line class="marker-line" x1="${mx}" y1="${pad.t}" x2="${mx}" y2="${H - pad.b}"/><text class="lbl-strong" x="${mx}" y="${pad.t + 9}" text-anchor="middle">${escapeHtml(atStart ? 'Now' : m.label)}</text>`; });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${grid}${mk}${area}${midPath}<line class="axis" x1="${pad.l}" y1="${H - pad.b}" x2="${W - pad.r}" y2="${H - pad.b}"/>${ylab}${xlab}</svg>`;
}
function barChart(items, opts = {}) {
  const W = opts.w || 760, H = opts.h || 250, pad = { l: 56, r: 16, t: 16, b: 40 };
  const max = Math.max(...items.flatMap(it => it.bars ? it.bars.map(b => b.value) : [it.value]), 1) * 1.12;
  const sy = v => H - pad.b - (v / max) * (H - pad.t - pad.b);
  const gw = (W - pad.l - pad.r) / items.length;
  let grid = '', ylab = '';
  for (let i = 0; i <= 4; i++) { const v = max * i / 4, yy = sy(v); grid += `<line class="grid-line" x1="${pad.l}" y1="${yy}" x2="${W - pad.r}" y2="${yy}"/>`; ylab += `<text class="lbl amount" x="${pad.l - 8}" y="${yy + 3}" text-anchor="end">${fmtK(v)}</text>`; }
  let bars = '';
  items.forEach((it, gi) => {
    const cx = pad.l + gw * gi + gw / 2;
    const bs = it.bars || [{ value: it.value, color: opts.color || 'var(--gold)' }];
    const bw = Math.min(36, (gw * 0.62) / bs.length); const totalW = bw * bs.length + (bs.length - 1) * 6; let bx = cx - totalW / 2;
    bs.forEach(b => { const y = sy(b.value), hh = Math.max(0, H - pad.b - y); bars += `<rect x="${bx.toFixed(1)}" y="${y.toFixed(1)}" width="${bw}" height="${hh.toFixed(1)}" rx="3" fill="${b.color}"/>`; bx += bw + 6; });
    bars += `<text class="lbl" x="${cx}" y="${H - 22}" text-anchor="middle">${escapeHtml(it.label)}</text>`;
    if (it.sub) bars += `<text class="lbl" x="${cx}" y="${H - 9}" text-anchor="middle" opacity=".7">${escapeHtml(it.sub)}</text>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}">${grid}${bars}<line class="axis" x1="${pad.l}" y1="${H - pad.b}" x2="${W - pad.r}" y2="${H - pad.b}"/>${ylab}</svg>`;
}

function donut(items, opts = {}) {
  const size = opts.size || 190, r = size / 2, rin = r * 0.62, cx = r, cy = r;
  const total = items.reduce((s, i) => s + Math.max(0, i.value), 0) || 1;
  let ang = -Math.PI / 2, arcs = '';
  items.forEach(it => {
    const frac = Math.max(0, it.value) / total; if (frac <= 0) return;
    const a2 = ang + frac * Math.PI * 2, large = frac > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.cos(ang), y1 = cy + r * Math.sin(ang), x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
    const xi1 = cx + rin * Math.cos(a2), yi1 = cy + rin * Math.sin(a2), xi2 = cx + rin * Math.cos(ang), yi2 = cy + rin * Math.sin(ang);
    arcs += `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} L${xi1.toFixed(1)} ${yi1.toFixed(1)} A${rin} ${rin} 0 ${large} 0 ${xi2.toFixed(1)} ${yi2.toFixed(1)} Z" fill="${it.color}"/>`;
    ang = a2;
  });
  const legend = items.filter(i => i.value > 0).map(i =>
    `<span><i class="dot" style="background:${i.color}"></i>${escapeHtml(i.label)} · <b class="amount">${fmtK(i.value)}</b> <span style="color:var(--faint)">(${pct(i.value / total * 100, 0)})</span></span>`).join('');
  return `<div style="display:flex;gap:1.4rem;align-items:center;flex-wrap:wrap">
    <svg class="chart" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="flex:none;width:${size}px">${arcs}
      <circle cx="${cx}" cy="${cy}" r="${rin - 1}" fill="var(--paper)"/>
      <text x="${cx}" y="${cy - 4}" text-anchor="middle" class="lbl" style="font-size:10px">TOTAL</text>
      <text x="${cx}" y="${cy + 13}" text-anchor="middle" class="amount" style="font-size:14px;font-weight:700;fill:var(--ink)">${fmtK(total)}</text>
    </svg>
    <div class="legend" style="flex-direction:column;align-items:flex-start;gap:.4rem">${legend}</div></div>`;
}

function gauge(scoreVal, opts = {}) {
  const size = opts.size || 200, cx = size / 2, cy = size / 2, r = size * 0.4, sw = 14;
  const start = Math.PI * 0.75, end = Math.PI * 2.25, frac = clamp(scoreVal / 100, 0, 1);
  const ang = start + (end - start) * frac;
  const pt = a => `${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
  const arc = (a1, a2) => { const large = (a2 - a1) > Math.PI ? 1 : 0; return `M${pt(a1)} A${r} ${r} 0 ${large} 1 ${pt(a2)}`; };
  const col = scoreVal >= 75 ? 'var(--good)' : scoreVal >= 50 ? 'var(--warn)' : 'var(--bad)';
  return `<svg class="chart" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="width:${size}px">
    <path d="${arc(start, end)}" fill="none" stroke="var(--ivory-2)" stroke-width="${sw}" stroke-linecap="round"/>
    <path d="${arc(start, ang)}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round"/>
    <text x="${cx}" y="${cy + 4}" text-anchor="middle" style="font-family:var(--ff);font-size:34px;font-weight:600;fill:var(--ink)">${scoreVal}</text>
    <text x="${cx}" y="${cy + 26}" text-anchor="middle" class="lbl">/ 100</text></svg>`;
}

/* ----------------------------- small UI helpers --------------------------- */
const tone = r => (r >= 1 ? 'good' : r >= 0.8 ? 'warn' : 'bad');
function statCard(label, value, opts = {}) {
  return `<div class="stat ${opts.tone || ''}">
    <div class="s-label">${escapeHtml(label)}</div>
    <div class="s-value ${opts.small ? 'sm' : ''} ${opts.valClass || ''}">${opts.raw ? value : `<span class="amount">${value}</span>`}</div>
    ${opts.note ? `<div class="s-note">${opts.note}</div>` : ''}</div>`;
}
function progressBar(label, ratio, opts = {}) {
  const w = clamp(ratio, 0, 1.2) / 1.2 * 100;
  const t = opts.tone || tone(ratio);
  return `<div>${label != null ? `<div class="progress-label"><span>${label}</span><b>${pct(ratio * 100, 0)}</b></div>` : ''}
    <div class="progress ${t}"><i style="width:${w}%"></i></div></div>`;
}
function badge(text, t) { return `<span class="badge ${t}">${escapeHtml(text)}</span>`; }
function panel(title, body, opts = {}) {
  const extra = (opts.headExtra || '') + (opts.hideKey ? hideToggle(opts.hideKey) : '');
  return `<div class="panel ${opts.cls || ''}" ${opts.hideKey ? hideAttr(opts.hideKey) : ''}>
    ${title ? `<div class="panel-head"><h3>${escapeHtml(title)}</h3><div style="display:flex;align-items:center;gap:.7rem">${opts.sub ? `<span class="ph-sub">${escapeHtml(opts.sub)}</span>` : ''}${extra}</div></div>` : ''}
    <div class="panel-body">${body}</div>${opts.foot ? `<div class="panel-foot">${opts.foot}</div>` : ''}</div>`;
}
const portfolioSeries = R => ({ name: 'Portfolio', color: 'var(--gold)', fill: 'var(--gold)', points: R.rows.map(r => ({ x: r.age, y: r.end })) });

function toast(msg) {
  const t = $('#toast'); t.innerHTML = msg; t.hidden = false;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(t._t); t._t = setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.hidden = true, 260); }, 2000);
}

/* ----------------------------- runtime state ------------------------------ */
let STATE = defaultState();
let RESULTS = compute(STATE);
let currentView = 'dashboard';
let currentPlanId = null;
let presentMode = false;
const built = {};

/* ----------------------------- field helpers ------------------------------ */
function field(f) {
  const v = getPath(STATE, f.path);
  const hint = f.hint ? `<span class="hint">${escapeHtml(f.hint)}</span>` : '';
  if (f.type === 'select') {
    const opts = f.options.map(o => `<option value="${escapeAttr(o.value)}" ${String(o.value) === String(v ?? '') ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
    return `<div class="field"><label>${escapeHtml(f.label)}${hint}</label><select data-path="${f.path}" data-vtype="text">${opts}</select></div>`;
  }
  if (f.type === 'textarea') {
    return `<div class="field"><label>${escapeHtml(f.label)}${hint}</label><textarea data-path="${f.path}" data-vtype="text" rows="${f.rows || 4}" placeholder="${escapeAttr(f.ph || '')}">${escapeHtml(v ?? '')}</textarea></div>`;
  }
  const isCur = f.type === 'currency', isMo = f.type === 'monthly', isPct = f.type === 'percent', isText = f.type === 'text';
  const pre = (isCur || isMo) ? '<span class="prefix">$</span>' : '';
  const suf = isPct ? '<span class="suffix">%</span>' : (isMo ? '<span class="suffix">/mo</span>' : (f.suffix ? `<span class="suffix">${escapeHtml(f.suffix)}</span>` : ''));
  const cls = `control ${(isCur || isMo) ? 'has-prefix' : ''} ${(isPct || isMo || f.suffix) ? 'has-suffix' : ''}`.trim();
  let input, echo = '';
  if (isMo) {
    /* Monthly-first money field: the advisor types $/month; the plan stores the annual figure at f.path. */
    const annual = +v || 0;
    input = `<input type="text" inputmode="decimal" data-path="${f.path}" data-money data-permonth value="${escapeAttr(moneyDisplay(annual ? Math.round(annual / 12) : ''))}" placeholder="${escapeAttr(f.ph || '0')}">`;
    echo = `<div class="annual-echo" data-echo-for="${f.path}">${annual > 0 ? '= ' + fmt$(annual) + ' per year' : '&nbsp;'}</div>`;
  } else if (isCur) {
    input = `<input type="text" inputmode="decimal" data-path="${f.path}" data-money value="${escapeAttr(moneyDisplay(v))}" placeholder="${escapeAttr(f.ph || '0')}">`;
  } else {
    const vtype = isText ? 'text' : (f.type || 'number');
    const step = isPct ? (f.step || 0.1) : (f.step || 1);
    const attrs = isText ? '' : `step="${step}" min="${f.min != null ? f.min : 0}" ${f.max != null ? `max="${f.max}"` : ''}`;
    input = `<input type="${isText ? 'text' : 'number'}" data-path="${f.path}" data-vtype="${vtype}" value="${escapeAttr(v ?? '')}" ${attrs} placeholder="${escapeAttr(f.ph || '')}">`;
  }
  return `<div class="field"><label>${escapeHtml(f.label)}${hint}</label><div class="${cls}">${pre}${input}${suf}</div>${echo}</div>`;
}
const fieldRow = (...f) => `<div class="field-row${f.length === 3 ? ' three' : ''}">${f.map(field).join('')}</div>`;

/* --------------------- collapsible profile sections ----------------------- */
const OPEN_SECTIONS = new Set(['household', 'income']);   /* module-level so open state survives the spouse-toggle rebuild */
function profileSectionStatus(S) {                        /* reuses factFinder's field checks, grouped per section */
  const c = S.household.client, sp = S.household.spouse, I = S.income, E = S.expenses, SV = S.savings, INS = S.insurance;
  const pos = v => +v > 0;
  return {
    household: (c.name && (!sp.included || sp.name)) ? 'ok' : 'todo',
    income: (pos(I.clientSalary) || pos(I.otherIncome) || (sp.included && pos(I.spouseSalary))) ? 'ok' : 'todo',
    expenses: (livingExpenses(E) > 0 && (pos(SV.savingsRatePct) || pos(SV.annualSavings) || pos(SV.employerMatch)
      || (SV.mode === 'accounts' && (S.assets || []).some(a => pos(a.contribution) || pos(a.contribPct)))
      || +S.household.client.age >= +S.household.client.retireAge)) ? 'ok' : 'todo',   // retirees aren't expected to be saving
    assets: (S.assets && S.assets.length) ? 'ok' : 'todo',
    insurance: pos(INS.lifeClient) ? 'ok' : 'todo'
    /* liabilities / assumptions / notes are optional → no status dot */
  };
}
const statusDot = (id, st, cls) => st ? `<span class="${cls} ${st}" data-status-for="${id}" aria-hidden="true">${st === 'ok' ? '✓' : ''}</span>` : '';
function collapsiblePanel(id, title, body, opts = {}) {
  const open = OPEN_SECTIONS.has(id);
  return `<div class="panel accordion ${open ? '' : 'collapsed'} ${opts.cls || ''}" id="sec-${id}" data-section="${id}">
    <button type="button" class="acc-head" data-action="toggle-section" data-section="${id}" aria-expanded="${open}">
      ${statusDot(id, opts.status, 'acc-dot')}<h3>${escapeHtml(title)}</h3>
      <span class="acc-head-right">${opts.sub ? `<span class="ph-sub">${escapeHtml(opts.sub)}</span>` : ''}<svg class="acc-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></span>
    </button>
    <div class="acc-body"><div class="panel-body">${body}</div></div>
  </div>`;
}
const PROFILE_INDEX = [['household', 'Household'], ['income', 'Income'], ['expenses', 'Expenses'], ['assets', 'Assets'], ['liabilities', 'Liabilities'], ['insurance', 'Insurance'], ['assumptions', 'Assumptions'], ['notes', 'Notes']];
function profileIndexNav(status) {
  return `<nav class="section-index" aria-label="Profile sections"><div class="sx-title">Sections</div>${PROFILE_INDEX.map(([id, label]) =>
    `<button type="button" class="sx-item ${OPEN_SECTIONS.has(id) ? 'open' : ''}" data-action="goto-section" data-section="${id}">${status[id] ? statusDot(id, status[id], 'sx-dot') : '<span class="sx-dot na" aria-hidden="true"></span>'}<span class="sx-label">${escapeHtml(label)}</span></button>`).join('')}</nav>`;
}
function syncProfileStatus() {                            /* live dot refresh without rebuilding the form */
  const map = profileSectionStatus(STATE);
  Object.keys(map).forEach(id => $$(`[data-status-for="${id}"]`).forEach(d => {
    d.classList.toggle('ok', map[id] === 'ok');
    d.classList.toggle('todo', map[id] === 'todo');
    d.textContent = map[id] === 'ok' ? '✓' : '';
  }));
}
function toggleField(path, label, rebuild) {
  const on = !!getPath(STATE, path);
  return `<div class="switch-row"><label>${escapeHtml(label)}</label>
    <button class="switch" role="switch" aria-checked="${on}" data-toggle="${path}"${rebuild ? ' data-rebuild' : ''}></button></div>`;
}
const sectionLabel = t => `<div class="section-label">${escapeHtml(t)}</div>`;
const modeSeg = (action, current, opts) => `<span class="seg mode-seg" role="group">${opts.map(([v, l]) => `<button type="button" class="seg-btn ${current === v ? 'on' : ''}" data-action="${action}" data-mode="${v}">${l}</button>`).join('')}</span>`;
const EXP_CATS = [['housing', 'Housing — rent / taxes / upkeep'], ['utilities', 'Utilities'], ['food', 'Food & groceries'], ['transportation', 'Transportation'], ['healthcare', 'Healthcare'], ['insurance', 'Insurance (non-loan)'], ['personal', 'Personal & discretionary'], ['other', 'Other']];
const BUDGET_TEMPLATE = { housing: .30, utilities: .07, food: .12, transportation: .15, healthcare: .08, insurance: .08, personal: .15, other: .05 };
function expensesBlock() {
  const E = STATE.expenses, detailed = E.expenseMode === 'detailed';
  const inputs = detailed
    ? `<div class="grid cols-2">${EXP_CATS.map(([k, l]) => field({ path: `expenses.budget.${k}`, label: l, type: 'currency', suffix: '/mo' })).join('')}</div>`
    : field({ path: 'expenses.annualExpenses', label: 'How much do they spend a month?', hint: 'today’s dollars', type: 'monthly', ph: 'e.g. 10,000' });
  return `<div class="block-head"><span class="block-title">Living expenses</span>${modeSeg('set-exp-mode', E.expenseMode || 'simple', [['simple', 'Monthly total'], ['detailed', 'Walk the budget']])}</div>
    <p class="budget-note">Living costs only — <b>loan &amp; mortgage payments are added automatically</b> from the Liabilities section, so don’t enter them here. If they don’t know the number, switch to <b>Walk the budget</b> and build it together.</p>
    ${inputs}
    ${field({ path: 'expenses.retirementExpensePct', label: 'Spending in retirement', hint: '% of today’s spending — 100 = unchanged', type: 'percent', ph: '100' })}`;
}
function savingsBlock() {
  const SV = STATE.savings, mode = SV.mode || 'dollar';
  const matchRow = sectionLabel('Employer 401(k) match') + fieldRow({ path: 'savings.matchPct', label: 'Match', hint: '% of your contribution', type: 'percent' }, { path: 'savings.matchLimitPct', label: 'Up to', hint: '% of pay', type: 'percent' });
  const split = sectionLabel('Where new savings go (tax treatment)') + fieldRow({ path: 'savingsSplit.pretax', label: 'Pre-tax', hint: '401k / IRA', type: 'percent' }, { path: 'savingsSplit.roth', label: 'Roth', type: 'percent' }, { path: 'savingsSplit.taxable', label: 'Taxable', type: 'percent' });
  let inputs;
  if (mode === 'percent') inputs = field({ path: 'savings.savingsRatePct', label: 'You save', hint: 'of gross income — scales as pay grows', type: 'percent' }) + matchRow + split;
  else if (mode === 'accounts') inputs = field({ path: 'savings.targetRatePct', label: 'Target savings rate', hint: '% of gross income — the goal to hit', type: 'percent' })
    + `<p class="budget-note">Set each contribution <b>on the account itself</b> in the Accounts section below — the 401(k) as a <b>% of salary with its employer match</b>, a Roth or brokerage as <b>$ per month</b>. Every deposit grows inside its own account, and the totals appear live on the right.</p>`;
  else inputs = fieldRow({ path: 'savings.annualSavings', label: 'Annual savings', type: 'currency' }, { path: 'savings.employerMatch', label: 'Employer match', type: 'currency' }) + split;
  return `<div class="block-head"><span class="block-title">Savings</span>${modeSeg('set-sav-mode', mode, [['percent', '% of income'], ['accounts', 'By account'], ['dollar', '$ per year']])}</div>
    ${inputs}
    ${sectionLabel('Leftover income (after expenses, taxes &amp; planned savings)')}
    ${field({ path: 'savings.surplusMode', label: 'Treat the surplus as', type: 'select', options: [{ value: 'invest', label: 'Extra savings — invest it' }, { value: 'discretionary', label: 'Discretionary — free to spend' }] })}`;
}

const ASSET_TYPES = [['cash', 'Cash / Reserve'], ['taxable', 'Taxable / Brokerage'], ['traditional', 'Tax-Deferred (401k/IRA)'], ['roth', 'Roth'], ['education', 'Education (529)'], ['realestate', 'Real Estate'], ['other', 'Other']];
const LIAB_TYPES = [['mortgage', 'Mortgage'], ['auto', 'Auto Loan'], ['student', 'Student Loan'], ['credit', 'Credit Card'], ['other', 'Other']];
const typeOpts = (types, sel) => types.map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${l}</option>`).join('');

const ACCT_TAX = { roth: ['Roth · tax-free', 'good'], traditional: ['Tax-deferred', 'gold'], taxable: ['Taxable', 'ink'], cash: ['Taxable', 'ink'], other: ['Taxable', 'ink'], education: ['529 · education', 'gold'], realestate: ['Property', 'ink'] };
function assetRow(a, i) {
  const tax = ACCT_TAX[a.type] || ['Taxable', 'ink'];
  const byAccount = (STATE.savings || {}).mode === 'accounts';
  const canContribute = CONTRIB_TYPES.includes(a.type);
  const defGrowth = (STATE.assumptions && STATE.assumptions.preReturn != null) ? STATE.assumptions.preReturn : 6;
  const pctMode = a.contribMode === 'pct';
  const isPlan = a.type === 'traditional' || a.type === 'roth';        // workplace-style accounts can contribute a % of salary
  const spIncl = (STATE.household.spouse || {}).included;
  const owner = a.owner || (isPlan ? 'client' : 'household');
  const ownerWages = ownerWagesNow(owner);
  const pctEcho = pctMode ? `<div class="annual-echo" data-acct-echo="${i}">${ownerWages > 0 ? '= ' + fmt$(ownerWages * (+a.contribPct || 0) / 100 / 12) + '/mo today' : '&nbsp;'}</div>` : '';
  const ownerSel = spIncl && canContribute ? `<div class="rr-cell"><label>Whose account</label><select data-arr="assets" data-idx="${i}" data-key="owner" data-vtype="text">
      <option value="client" ${owner === 'client' ? 'selected' : ''}>${escapeHtml((STATE.household.client.name || 'Client').split(' ')[0])}</option>
      <option value="spouse" ${owner === 'spouse' ? 'selected' : ''}>${escapeHtml((STATE.household.spouse.name || 'Spouse').split(' ')[0])}</option>
      <option value="household" ${owner === 'household' ? 'selected' : ''}>Joint</option></select></div>` : '';
  const contribInput = pctMode
    ? `<div class="rr-cell"><label>Contribution — % of salary</label><div class="control has-suffix"><input type="number" step="0.5" min="0" max="100" data-arr="assets" data-idx="${i}" data-key="contribPct" data-vtype="percent" value="${a.contribPct != null && a.contribPct !== '' ? a.contribPct : ''}" placeholder="6"><span class="suffix">%</span></div>${pctEcho}</div>`
    : `<div class="rr-cell"><label>Saving / month ($)</label><div class="control has-prefix"><span class="prefix">$</span><input type="text" inputmode="decimal" data-arr="assets" data-idx="${i}" data-key="contribution" data-money value="${moneyDisplay(a.contribution || 0)}"></div></div>`;
  const segBtn = (v, l) => `<button type="button" class="seg-btn ${(pctMode ? 'pct' : 'dollar') === v ? 'on' : ''}" data-action="acct-contrib-mode" data-idx="${i}" data-mode="${v}">${l}</button>`;
  const modeToggle = isPlan ? `<div class="rr-cell"><label>Contribute as</label><span class="seg mode-seg" role="group">${segBtn('dollar', '$ / mo')}${segBtn('pct', '% of salary')}</span></div>` : '';
  const matchCells = a.type === 'traditional' ? `
      <div class="rr-cell"><label>Employer match</label><div class="control has-suffix"><input type="number" step="5" min="0" max="200" data-arr="assets" data-idx="${i}" data-key="matchPct" data-vtype="percent" value="${a.matchPct != null && a.matchPct !== '' ? a.matchPct : ''}" placeholder="0"><span class="suffix">% of contrib.</span></div></div>
      <div class="rr-cell"><label>Match up to</label><div class="control has-suffix"><input type="number" step="0.5" min="0" max="25" data-arr="assets" data-idx="${i}" data-key="matchCapPct" data-vtype="percent" value="${a.matchCapPct != null && a.matchCapPct !== '' ? a.matchCapPct : ''}" placeholder="0"><span class="suffix">% of pay</span></div></div>` : '';
  const contribRow = byAccount ? `<div class="rr-grid" style="grid-column:1/-1;margin-top:.5rem">
      ${canContribute
        ? `${ownerSel}${modeToggle}${contribInput}
           <div class="rr-cell"><label>Growth / yr</label><div class="control has-suffix"><input type="number" step="0.1" min="0" data-arr="assets" data-idx="${i}" data-key="growth" data-vtype="percent" value="${a.growth != null && a.growth !== '' ? a.growth : ''}" placeholder="${defGrowth}"><span class="suffix">%</span></div></div>${matchCells}`
        : `<div class="rr-cell" style="grid-column:span 2"><label>Contributions</label><div class="rr-note" style="margin:0">${a.type === 'education' ? 'Fund this with an Education goal' : 'Held asset — no ongoing contributions'}</div></div>`}
      <div class="rr-cell"><label>Tax treatment</label><div style="padding-top:.15rem">${badge(tax[0], tax[1])}</div></div>
    </div>` : '';
  return `<div class="repeat-row" style="grid-template-columns:1fr 170px 140px 24px;align-items:end">
    <div class="rr-cell"><label>Account name</label><input type="text" data-arr="assets" data-idx="${i}" data-key="name" value="${escapeAttr(a.name)}" placeholder="e.g. 401(k), Brokerage"></div>
    <div class="rr-cell"><label>Account type</label><select data-arr="assets" data-idx="${i}" data-key="type">${typeOpts(ASSET_TYPES, a.type)}</select></div>
    <div class="rr-cell"><label>Current balance</label><div class="control has-prefix"><span class="prefix">$</span><input type="text" inputmode="decimal" data-arr="assets" data-idx="${i}" data-key="balance" data-money value="${moneyDisplay(a.balance)}"></div></div>
    <button class="rr-del" data-action="del-asset" data-idx="${i}" title="Remove">×</button>
    ${contribRow}</div>`;
}
function liabRow(l, i) {
  return `<div class="repeat-row" style="grid-template-columns:1fr 120px 24px;align-items:end">
    <div class="rr-cell"><label>Liability</label><input type="text" data-arr="liabilities" data-idx="${i}" data-key="name" value="${escapeAttr(l.name)}" placeholder="e.g. Mortgage"></div>
    <div class="rr-cell"><label>Type</label><select data-arr="liabilities" data-idx="${i}" data-key="type">${typeOpts(LIAB_TYPES, l.type)}</select></div>
    <button class="rr-del" data-action="del-liab" data-idx="${i}" title="Remove">×</button>
    <div class="rr-grid" style="grid-column:1/-1">
      <div class="rr-cell"><label>Balance owed</label><div class="control has-prefix"><span class="prefix">$</span><input type="text" inputmode="decimal" data-arr="liabilities" data-idx="${i}" data-key="balance" data-money value="${moneyDisplay(l.balance)}"></div></div>
      <div class="rr-cell"><label>Interest rate</label><div class="control has-suffix"><input type="number" step="0.1" min="0" data-arr="liabilities" data-idx="${i}" data-key="rate" data-vtype="percent" value="${l.rate || 0}"><span class="suffix">%</span></div></div>
      <div class="rr-cell"><label>Term left (yrs)</label><input type="number" min="0" step="1" data-arr="liabilities" data-idx="${i}" data-key="term" value="${l.term != null && l.term !== '' ? l.term : ''}" placeholder="${l.type === 'mortgage' ? '30' : ''}"></div>
      <div class="rr-cell"><label>Monthly payment</label><div class="control has-prefix"><span class="prefix">$</span><input type="text" inputmode="decimal" data-arr="liabilities" data-idx="${i}" data-key="payment" data-money value="${moneyDisplay(l.payment || 0)}"></div></div>
    </div></div>`;
}
const GOAL_TYPES = [['retirement', 'Retirement'], ['home', 'Buy a home'], ['education', 'Education / college'], ['purchase', 'Major purchase'], ['travel', 'Travel / lifestyle'], ['gifting', 'Gifting'], ['charitable', 'Charitable giving'], ['debt', 'Debt payoff'], ['emergency', 'Emergency reserve'], ['protection', 'Survivor / income-replacement'], ['ltc', 'Long-term care'], ['legacy', 'Legacy / estate'], ['custom', 'Custom']];
function goalRow(g, i) {
  const isMgmt = g.type === 'retirement' || g.type === 'protection';
  const isLegacy = g.type === 'legacy', isCustom = g.type === 'custom', isEdu = g.type === 'education';
  const M = (label, key) => `<div class="rr-cell"><label>${label}</label><div class="control has-prefix"><span class="prefix">$</span><input type="text" inputmode="decimal" data-arr="goals" data-idx="${i}" data-key="${key}" data-money value="${moneyDisplay(g[key] || 0)}"></div></div>`;
  const N = (label, key, def) => `<div class="rr-cell"><label>${label}</label><input type="number" min="0" data-arr="goals" data-idx="${i}" data-key="${key}" value="${g[key] != null && g[key] !== '' ? g[key] : (def != null ? def : '')}"></div>`;
  const P = (label, key, def) => `<div class="rr-cell"><label>${label}</label><div class="control has-suffix"><input type="number" min="0" step="0.1" data-arr="goals" data-idx="${i}" data-key="${key}" value="${g[key] != null && g[key] !== '' ? g[key] : (def != null ? def : '')}"><span class="suffix">%</span></div></div>`;
  const grid = inner => `<div class="rr-grid">${inner}</div>`;
  const isRecurring = ['custom', 'travel', 'gifting', 'charitable'].includes(g.type);
  const injectable = isRecurring || g.type === 'education' || g.type === 'ltc' || g.type === 'purchase';
  const planToggle = injectable ? `<div class="rr-plan"><button type="button" class="switch" role="switch" aria-checked="${!!g.onPlan}" data-goalplan data-idx="${i}"></button><span>${g.onPlan ? 'Spending flows through your plan timeline' : 'Funding tracker only — turn on to model it on your timeline'}</span></div>` : '';
  const freqSel = `<div class="rr-cell"><label>How often</label><select data-arr="goals" data-idx="${i}" data-key="frequency" data-vtype="text"><option value="once" ${(g.frequency || 'once') === 'once' ? 'selected' : ''}>One-time</option><option value="annual" ${g.frequency === 'annual' ? 'selected' : ''}>Every year</option><option value="monthly" ${g.frequency === 'monthly' ? 'selected' : ''}>Every month</option></select></div>`;
  const inflCell = `<div class="rr-cell"><label>Inflation / yr</label><div class="control has-suffix"><input type="number" min="0" step="0.1" data-arr="goals" data-idx="${i}" data-key="inflation" data-vtype="percent" value="${g.inflation != null ? g.inflation : ''}" placeholder="plan"><span class="suffix">%</span></div></div>`;
  let body;
  if (isMgmt) body = `<div class="rr-note">Calculated automatically from your Retirement &amp; Protection inputs — nothing to enter here.</div>`;
  else if (g.type === 'home') body = grid(M('Home price ($)', 'price') + P('Down payment', 'downPct', 20) + N('Buy at age', 'buyAge') + N('Mortgage term (yrs)', 'term', 30) + P('Interest rate', 'rate', 6) + M('Already saved ($)', 'funded') + M('Saving / month ($)', 'monthly'))
      + `<div class="rr-note">You save the <b>down payment</b>; at purchase the rest becomes a mortgage whose payment flows through your plan for the term.</div>`;
  else if (isLegacy) body = grid(M('Legacy target ($)', 'amount')) + `<div class="rr-note">Measured against your projected estate (ending portfolio).</div>`;
  else if (g.type === 'emergency') body = grid(N('Months of expenses', 'months', 6) + M('Reserve already set aside ($)', 'funded')) + `<div class="rr-note">Target = months × your monthly expenses, measured against current cash.</div>`;
  else if (g.type === 'ltc') body = grid(M('Annual care cost ($)', 'amount') + N('Care starts at age', 'startAge') + N('For how many years', 'duration', 3) + P('Insurance covers', 'coverage') + M('Already saved ($)', 'funded') + M('Saving / month ($)', 'monthly')) + planToggle;
  else if (g.type === 'purchase') body = grid(M('Purchase amount ($)', 'amount') + N('Buy at age', 'buyAge') + N('Loan term — 0 = cash', 'term') + P('Interest rate', 'rate', 6) + P('Down payment', 'downPct', 20) + M('Already saved ($)', 'funded') + M('Saving / month ($)', 'monthly'))
      + `<div class="rr-note">Leave <b>term = 0</b> to pay cash; set a term to finance it (down payment now, payments over the term).</div>` + planToggle;
  else if (isRecurring) body = grid(M('Amount each time ($)', 'amount') + freqSel + N('Start age', 'startAge') + N('End age', 'endAge') + inflCell + M('Already saved ($)', 'funded') + M('Saving / month ($)', 'monthly')) + planToggle;
  else if (isEdu) body = grid(M('Annual cost ($)', 'amount') + N('Years until', 'years') + N('Years of school', 'duration', 4) + M('Already saved ($)', 'funded') + M('Saving / month ($)', 'monthly')) + planToggle;
  else body = grid(M('Goal amount ($)', 'amount') + N('Years until', 'years') + M('Already saved ($)', 'funded') + M('Saving / month ($)', 'monthly'));
  return `<div class="repeat-row" style="grid-template-columns:1fr 160px 26px">
      <div class="rr-cell"><label>Goal name</label><input type="text" data-arr="goals" data-idx="${i}" data-key="name" value="${escapeAttr(g.name)}" placeholder="e.g. New car"></div>
      <div class="rr-cell"><label>Goal type</label><select data-arr="goals" data-idx="${i}" data-key="type">${GOAL_TYPES.map(([v, l]) => `<option value="${v}" ${v === g.type ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <button class="rr-del" data-action="del-goal" data-idx="${i}" title="Remove" style="align-self:end">×</button>
      ${body}</div>`;
}

const EVENT_TYPES = [['child', 'Child / dependent'], ['college', 'College funding'], ['expenseRecurring', 'Recurring expense'], ['income', 'Extra income'], ['expense', 'One-time expense'], ['windfall', 'Windfall / inheritance'], ['ltc', 'Long-term care'], ['downturn', 'Market downturn'], ['mortgagePayoff', 'Pay off mortgage'], ['sellAsset', 'Sell asset / downsize'], ['annuity', 'Buy income annuity']];
function eventRow(ev, i) {
  const recurring = ['child', 'college', 'ltc', 'income', 'expenseRecurring'].includes(ev.type);
  const oneTime = ['expense', 'windfall'].includes(ev.type);
  const isDown = ev.type === 'downturn', isSell = ev.type === 'sellAsset', isAnnuity = ev.type === 'annuity';
  const M = (label, key) => `<div class="rr-cell"><label>${label}</label><div class="control has-prefix"><span class="prefix">$</span><input type="text" inputmode="decimal" data-arr="events" data-idx="${i}" data-key="${key}" data-money value="${moneyDisplay(ev[key] || 0)}"></div></div>`;
  const N = (label, key, def) => `<div class="rr-cell"><label>${label}</label><input type="number" min="0" data-arr="events" data-idx="${i}" data-key="${key}" value="${ev[key] != null && ev[key] !== '' ? ev[key] : (def != null ? def : '')}"></div>`;
  let fields;
  if (recurring) fields = N('Begins at age', 'startAge') + N('For how many years', 'years', 1) + M('Amount / year', 'amount');
  else if (oneTime) fields = N('At age', 'atAge') + M('Amount', 'amount');
  else if (isDown) fields = N('At age', 'atAge') + `<div class="rr-cell"><label>Portfolio drop</label><div class="control has-suffix"><input type="number" min="0" max="90" data-arr="events" data-idx="${i}" data-key="amount" data-vtype="percent" value="${ev.amount || 0}"><span class="suffix">%</span></div></div>`;
  else if (isSell) fields = N('At age', 'atAge') + M('Proceeds', 'amount') + M('Expense cut / yr', 'cut');
  else if (isAnnuity) fields = N('Buy at age', 'atAge') + M('Premium (→ lifetime income)', 'amount');
  else fields = N('At age', 'atAge') + `<div class="rr-cell" style="align-self:end"><div class="rr-note" style="margin:0">Remaining mortgage paid from savings</div></div>`;
  return `<div class="repeat-row" style="grid-template-columns:1fr 26px">
    <div class="rr-cell"><label>Event name</label><input type="text" data-arr="events" data-idx="${i}" data-key="label" value="${escapeAttr(ev.label || '')}" placeholder="e.g. Buy a boat"></div>
    <button class="rr-del" data-action="del-event" data-idx="${i}" title="Remove" style="align-self:end">×</button>
    <div class="rr-cell" style="grid-column:1/-1"><label>What kind of event</label><select data-arr="events" data-idx="${i}" data-key="type">${EVENT_TYPES.map(([v, l]) => `<option value="${v}" ${v === ev.type ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="rr-grid" style="grid-column:1/-1">${fields}</div></div>`;
}

/* ----------------------------- save / plans ------------------------------- */
const setStatus = (txt, saving) => { const el = $('#saveStatus'); if (el) { el.textContent = txt; el.classList.toggle('saving', !!saving); } };
function saveCurrent() {
  if (!currentPlanId) return;
  const store = loadStore();
  store.plans[currentPlanId] = { id: currentPlanId, name: planLabel(STATE), updatedAt: Date.now(), state: STATE };
  store.current = currentPlanId; saveStore(store);
  setStatus('Saved');
  cloudMaybePush();                                                     // mirror to the cloud when signed in & unlocked
}
const scheduleSave = debounce(saveCurrent, 600);
function updateHeader() {
  $('#planNameLabel').textContent = planLabel(STATE);
  const av = $('#planAvatar'); if (av) av.textContent = (planLabel(STATE).trim()[0] || '?').toUpperCase();
  const cc = $('#coverClient'); if (cc) cc.textContent = clientNames();
}

function newPlan(seed) {
  const store = loadStore();
  currentPlanId = uid();
  STATE = seed || defaultState();
  store.plans[currentPlanId] = { id: currentPlanId, name: planLabel(STATE), updatedAt: Date.now(), state: STATE };
  store.current = currentPlanId; saveStore(store);
  resetBuilt(); RESULTS = compute(STATE); showView(seed ? 'dashboard' : 'intake'); refreshAll();
}
function switchPlan(id) {
  const store = loadStore(); const p = store.plans[id]; if (!p) return;
  currentPlanId = id; STATE = ensureDefaults(p.state);
  store.current = id; saveStore(store);
  document.body.classList.toggle('inputs-collapsed', !!(STATE.ui && STATE.ui.collapsed));
  resetBuilt(); RESULTS = compute(STATE); showView('dashboard'); refreshAll(); closePlanMenu();
  toast(`Opened <b>${escapeHtml(planLabel(STATE))}</b>`);
}
function deletePlan(id) {
  const store = loadStore(); delete store.plans[id];
  if (store.current === id) store.current = null;
  saveStore(store);
  if (id === currentPlanId) { const ids = Object.keys(store.plans); ids.length ? switchPlan(ids[0]) : newPlan(); }
  renderPlanMenu();
}
function duplicatePlan() {
  const clone = JSON.parse(JSON.stringify(STATE));
  clone.household.client.name = (planLabel(STATE) === 'New Client' ? 'Copy' : planLabel(STATE)) + ' (copy)';
  newPlan(clone); toast('Plan duplicated');
}
function resetBuilt() { Object.keys(built).forEach(k => delete built[k]); }
function refreshAll() { updateHeader(); renderPlanMenu(); const f = liveFns[currentView]; if (f) f(); }

function exportPlan() {
  const blob = new Blob([JSON.stringify(STATE, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (planLabel(STATE).replace(/[^\w]+/g, '_') || 'financial_plan') + '.json';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
  toast('Plan exported');
}
function importPlan(file) {
  const fr = new FileReader();
  fr.onload = () => { try { const data = JSON.parse(fr.result); newPlan(Object.assign(defaultState(), data)); toast('Plan imported'); } catch { toast('Could not read that file'); } };
  fr.readAsText(file);
}

/* ----------------------------- misc render utils -------------------------- */
const DATESTR = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
const getViewEl = v => $(`.view[data-view="${v}"]`);
function headBlock(eyebrow, title, sub, extra = '') {
  return `<div class="view-head"><div>
    <div class="view-eyebrow">${escapeHtml(eyebrow)}</div>
    <h1 class="view-title">${title}</h1>
    ${sub ? `<p class="view-sub">${sub}</p>` : ''}
  </div><div class="btn-row">${extra}</div></div>`;
}
function ensureDefaults(S) {
  const d = defaultState();
  const hadNoSavMode = S.savings && S.savings.mode == null && ((+S.savings.annualSavings || 0) > 0 || (+S.savings.employerMatch || 0) > 0);
  ['meta', 'income', 'expenses', 'savings', 'savingsSplit', 'insurance', 'protection', 'assumptions', 'quickEducation', 'rothStrategy', 'debtStrategy', 'withdrawalStrategy', 'pensionElection', 'charitableStrategy', 'estate'].forEach(k => S[k] = Object.assign({}, d[k], S[k]));
  S.expenses.budget = Object.assign({}, d.expenses.budget, S.expenses.budget);   // deep-merge budget categories for older plans
  if (hadNoSavMode) S.savings.mode = 'dollar';                                   // pre-modes plans keep their annual-dollar savings
  S.portfolios = S.portfolios || d.portfolios;                                   // Portfolio Lab state
  S.portfolios.settings = Object.assign({}, d.portfolios.settings, S.portfolios.settings);
  ['current', 'proposed'].forEach(k => { S.portfolios[k] = Object.assign({}, d.portfolios[k], S.portfolios[k]); S.portfolios[k].holdings = S.portfolios[k].holdings || []; });
  if (S.savings.mode === 'accounts' && (+S.savings.matchPct || 0) > 0 && (S.assets || []).length &&
      !(S.assets || []).some(a => (+a.matchPct || 0) > 0)) {                     // move the old global match onto the largest 401(k)/IRA row
    const trads = (S.assets || []).filter(a => a.type === 'traditional').sort((x, y) => (+y.balance || 0) - (+x.balance || 0));
    if (trads.length) { trads[0].matchPct = +S.savings.matchPct; trads[0].matchCapPct = +S.savings.matchLimitPct || 0; S.savings.matchPct = 0; S.savings.matchLimitPct = 0; }
  }
  S.household = S.household || d.household;
  S.household.client = Object.assign({}, d.household.client, S.household.client);
  S.household.spouse = Object.assign({}, d.household.spouse, S.household.spouse);
  S.assets = S.assets || []; S.liabilities = S.liabilities || [];
  S.goals = (S.goals && S.goals.length) ? S.goals : d.goals;
  S.events = S.events || [];
  if (S.advisorNotes == null) S.advisorNotes = '';
  S.presentation = Object.assign({ hidden: {} }, S.presentation);
  S.ui = Object.assign({ collapsed: false }, S.ui);
  S.quickRetire = Object.assign({ age: S.household.client.age, retireAge: S.household.client.retireAge, lifeExpectancy: S.household.client.lifeExpectancy, currentSavings: 300000, monthlySavings: 1500, desiredAnnualIncome: 90000, socialSecurity: 30000 }, S.quickRetire);
  S.quickProtect = Object.assign({ income: 150000, replacePct: 70, replaceYears: 15, debts: 300000, finalExpenses: 20000, existingCoverage: 250000 }, S.quickProtect);
  return S;
}
const isHidden = key => !!(STATE.presentation && STATE.presentation.hidden && STATE.presentation.hidden[key]);
const hideAttr = key => `data-client-hidden="${isHidden(key)}"`;
const hideToggle = key => `<label class="hide-toggle advisor-only" title="Hide this section in presentation & client report">
  <input type="checkbox" data-action="hidesec" data-key="${key}" ${isHidden(key) ? 'checked' : ''}> Hide from client</label>`;
const collapseBtn = () => `<button class="btn ghost sm advisor-only" data-action="toggle-inputs" title="Collapse the data-entry column to enlarge the charts">${(STATE.ui && STATE.ui.collapsed) ? '› Show data entry' : '‹ Hide data entry'}</button>`;

function netWorthTable(R) {
  const aRows = (STATE.assets || []).map(a => `<tr><td>${escapeHtml(a.name || '—')}</td><td style="text-align:left;color:var(--muted);font-size:.78rem">${(ASSET_TYPES.find(t => t[0] === a.type) || [, a.type])[1]}</td><td class="amount">${fmt$(a.balance)}</td></tr>`).join('');
  const lRows = (STATE.liabilities || []).map(l => `<tr><td>${escapeHtml(l.name || '—')}</td><td style="text-align:left;color:var(--muted);font-size:.78rem">${(LIAB_TYPES.find(t => t[0] === l.type) || [, l.type])[1]}</td><td class="amount neg">(${fmt$(l.balance)})</td></tr>`).join('');
  return `<table class="tbl"><thead><tr><th>Holding</th><th style="text-align:left">Type</th><th>Value</th></tr></thead>
    <tbody>${aRows || '<tr><td colspan="3" style="color:var(--faint)">No assets entered</td></tr>'}
    ${lRows}</tbody>
    <tfoot><tr><td>Net Worth</td><td></td><td class="amount ${R.netWorth >= 0 ? 'pos' : 'neg'}">${fmt$(R.netWorth)}</td></tr></tfoot></table>`;
}

/* ----------------------------- DASHBOARD ---------------------------------- */
let dashAge = null;
let dashWin = null;   // timeline zoom: null = full plan, else { start, years }
function dashWinRange(R) {
  if (!dashWin) return { lo: R.curAge, hi: R.endAge, full: true };
  const lo = clamp(Math.round(+dashWin.start || R.curAge), R.curAge, R.endAge - 1);
  const hi = clamp(lo + Math.max(1, Math.round(+dashWin.years || 10)), lo + 1, R.endAge);
  return { lo, hi, full: false };
}
const eventTypeLabel = t => (EVENT_TYPES.find(e => e[0] === t) || [, 'Event'])[1];
function heroAges(R) {
  const c = STATE.household.client, sp = STATE.household.spouse;
  let s = `${escapeHtml(c.name || 'Client')} age ${R.curAge}`;
  if (R.spOn && sp.name) s += `  ·  ${escapeHtml(sp.name)} age ${+sp.age || 0}`;
  return s;
}
function getMilestones(R) {
  const m = {}, add = (age, txt) => { if (age == null || isNaN(age)) return; age = Math.round(age); (m[age] = m[age] || []).push(txt); };
  const c = STATE.household.client, sp = STATE.household.spouse, I = STATE.income, spDiff = R.curAge - (+sp.age || R.curAge);
  add(R.retAge, `${escapeHtml(c.name || 'Client')} retires`);
  if (R.spOn) add((+sp.retireAge || 65) + spDiff, `${escapeHtml(sp.name || 'Spouse')} retires`);
  add(+I.ssClaimClient || R.retAge, `Social Security begins`);
  if (R.spOn) add((+I.ssClaimSpouse || 67) + spDiff, `${escapeHtml(sp.name || 'Spouse')}’s Social Security`);
  add(+STATE.assumptions.rmdStartAge, `Required distributions (RMDs) begin`);
  (STATE.events || []).forEach(ev => {
    const label = (ev.label || '').trim() || eventTypeLabel(ev.type);
    if (['child', 'college', 'ltc', 'income', 'expenseRecurring'].includes(ev.type)) add(+ev.startAge, label + ' begins');
    else add(+ev.atAge, label);
  });
  return m;
}
function renderDashboard() {
  const R = RESULTS, ins = buildInsights(R).slice(0, 3);
  const mc = mcAsync(() => { if (currentView === 'dashboard') (presentMode ? showPresentView('dashboard') : renderDashboard()); });
  const successPct = mc ? Math.round(mc.success * 100) : null;
  if (dashAge == null || dashAge < R.curAge || dashAge > R.endAge) dashAge = clamp(R.retAge, R.curAge, R.endAge);
  const who = clientNames();
  const t3 = successPct == null ? 'gold' : successPct >= 80 ? 'good' : successPct >= 60 ? 'warn' : 'bad';
  const healthText = successPct == null ? 'Running market simulations…'
    : (successPct >= 80 ? 'On track' : successPct >= 60 ? 'Likely on track' : 'Needs attention') + ` — ${successPct}% probability of success`;
  getViewEl('dashboard').innerHTML = `
    <div class="dash-hero">
      <div>
        <div class="dh-eyebrow">Financial Plan · ${DATESTR}</div>
        <div class="dh-name">${escapeHtml(who)}</div>
        <div class="dh-meta">${heroAges(R)}  ·  plan horizon to age ${R.endAge}</div>
      </div>
      <div style="display:flex;gap:.6rem;align-items:center;flex-wrap:wrap">
        <div class="dh-status"><span class="dot" style="background:var(--${t3})"></span>${healthText}</div>
        <button class="btn advisor-only" data-action="goto" data-view="profile">Edit</button>
        <button class="btn gold advisor-only" data-action="open-report">Report</button>
      </div>
    </div>
    <div class="grid cols-4" style="margin-bottom:1.3rem">
      ${statCard('Net Worth', fmt$(R.netWorth), { tone: R.netWorth >= 0 ? 'good' : 'bad', note: `${money(R.totalAssets)} assets · ${money(R.totalLiab)} debt` })}
      ${statCard('Probability of Success', successPct == null ? '…' : successPct + '%', { raw: true, tone: t3 === 'gold' ? '' : t3, valClass: 'val-' + t3, note: successPct == null ? 'running simulations…' : `${mc.trials} market simulations` })}
      ${statCard('Retirement Funded', pct(R.fundedRatio * 100, 0), { raw: true, tone: tone(R.fundedRatio), valClass: 'val-' + tone(R.fundedRatio), note: R.surplus >= 0 ? `Surplus ${money(R.surplus)}` : `Gap ${money(-R.surplus)}` })}
      ${statCard('Lifetime Taxes', fmtK(R.lifetimeTax), { tone: 'warn', note: `${money(R.lifetimeFedTax)} federal` })}
    </div>
    ${dashTimeline(R)}
    <div style="height:1.3rem"></div>
    ${comparePanel()}
    <div class="split" style="grid-template-columns:1fr 1fr">
      ${panel('Goal Funding', goalProgressList(R), { hideKey: 'dash-goals', headExtra: `<button class="btn sm advisor-only" data-action="goto" data-view="cashflow">Manage</button>` })}
      ${panel('Top Insights', ins.map(insightHTML).join('') || '<div class="empty">Enter client data to generate insights.</div>',
        { sub: 'CoPlanner', headExtra: `<button class="btn sm advisor-only" data-action="goto" data-view="coplanner">View all</button>` })}
    </div>`;
  updateDashScrub();
}
function comparePanel() {
  if (!STATE.baseline) {
    return `<div class="advisor-only"><div class="panel pad" style="display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:1.3rem">
      <div><b style="font-size:1.05rem">Before / After compare</b><div class="view-sub" style="margin:.2rem 0 0;max-width:none">Save the current plan as a baseline, then apply a recommendation — the impact appears here, live, for the client.</div></div>
      <button class="btn gold" data-action="save-baseline">Save current as baseline</button></div></div>`;
  }
  const base = compute(STATE.baseline), R = RESULTS;
  const sBase = Math.round(mcFor(STATE.baseline, 400).success * 100), sNow = Math.round(mcFor(STATE, 600).success * 100);
  const lastsB = base.depletionAge != null ? base.depletionAge : base.life + 1, lastsN = R.depletionAge != null ? R.depletionAge : R.life + 1;
  const ageFmt = v => v > R.life ? `${R.life}+` : `age ${Math.round(v)}`;
  return panel('Before / After — vs Saved Baseline',
    lineChart([
      { name: 'Baseline', color: 'var(--ink)', points: base.rows.map(r => ({ x: r.age, y: r.end })) },
      { name: 'Current', color: 'var(--gold)', fill: 'var(--gold)', points: R.rows.map(r => ({ x: r.age, y: r.end })) }
    ], { markers: [{ x: R.retAge, label: 'Retire' }], h: 220 }) +
    `<div class="legend"><span><i class="dot" style="background:var(--ink)"></i>Baseline</span><span><i class="dot" style="background:var(--gold)"></i>Current plan</span></div>
    <table class="tbl" style="margin-top:1rem"><thead><tr><th style="text-align:left">Metric</th><th>Baseline</th><th>Current</th><th>Change</th></tr></thead><tbody>
      ${cmpRow('Probability of success', sBase, sNow, v => v + '%')}
      ${cmpRow('Net worth', base.netWorth, R.netWorth, fmt$)}
      ${cmpRow('Retirement funded', base.fundedRatio, R.fundedRatio, v => pct(v * 100, 0))}
      ${cmpRow('Ending balance · age ' + R.life, base.endingBalance, R.endingBalance, fmt$)}
      ${cmpRow('Lifetime taxes', base.lifetimeTax, R.lifetimeTax, fmt$, false)}
      ${cmpRow('Portfolio lasts to', lastsB, lastsN, ageFmt)}
    </tbody></table>`,
    { sub: 'Recommendation impact', hideKey: 'dash-compare', headExtra: `<span class="btn-row"><button class="btn sm advisor-only" data-action="save-baseline">Update</button><button class="btn ghost sm advisor-only" data-action="clear-baseline">Clear</button></span>` })
    + `<div style="height:1.3rem"></div>`;
}
function dashTimeline(R) {
  const win = dashWinRange(R), yrsVal = win.hi - win.lo;
  const retInWin = R.retAge >= win.lo && R.retAge <= win.hi;
  return `<div class="timeline">
    <div class="tl-main">
      <div class="tl-main-head"><h3>Plan Timeline</h3>
        <div class="tl-win">
          <span class="tlw-label">Show</span>
          <button class="seg-btn ${win.full ? 'on' : ''}" data-dashwin="full">Full</button>
          <button class="seg-btn ${!win.full && yrsVal === 10 ? 'on' : ''}" data-dashwin="10">10 yr</button>
          <button class="seg-btn ${!win.full && yrsVal === 20 ? 'on' : ''}" data-dashwin="20">20 yr</button>
          <span class="tlw-edit">age <input type="number" class="tlw-num" min="${R.curAge}" max="${R.endAge}" value="${win.lo}" data-dashwin-from aria-label="From age"> for <input type="number" class="tlw-num" min="1" max="${R.endAge - R.curAge}" value="${yrsVal}" data-dashwin-years aria-label="Years to show"> yrs</span>
        </div>
      </div>
      <div class="tl-chart-wrap" id="tlChart"></div>
      <div id="tlWinSum"></div>
      <div class="scrubber-wrap">
        <input type="range" class="scrubber" min="${win.lo}" max="${win.hi}" step="1" value="${clamp(dashAge == null ? R.retAge : dashAge, win.lo, win.hi)}" data-scrub aria-label="Select year">
        <div class="scrub-ticks"><span>Age ${win.lo}</span><span>${R.alreadyRetired && win.full ? 'Now ' + R.curAge : (retInWin ? 'Retire ' + R.retAge : '')}</span><span>Age ${win.hi}</span></div>
        <div class="scrub-hint" id="tlHint"></div>
      </div>
    </div>
    <div class="tl-side" id="tlSide"></div>
  </div>`;
}
function updateDashScrub() {
  const R = RESULTS, win = dashWinRange(R);
  if (dashAge == null || dashAge < win.lo || dashAge > win.hi) dashAge = clamp(dashAge == null ? R.retAge : dashAge, win.lo, win.hi);
  const row = R.rows.find(r => r.age === dashAge) || R.rows[0]; if (!row) return;
  const scr = $('.scrubber'); if (scr) { scr.min = win.lo; scr.max = win.hi; if (+scr.value !== dashAge) scr.value = dashAge; }
  const chart = $('#tlChart');
  const pts = R.rows.filter(r => r.age >= win.lo && r.age <= win.hi).map(r => ({ x: r.age, y: r.end }));
  const markers = (R.retAge >= win.lo && R.retAge <= win.hi) ? [{ x: R.retAge, label: 'Retire' }] : [];
  if (chart) chart.innerHTML = lineChart([{ name: 'Portfolio', color: 'var(--gold)', fill: 'var(--gold)', points: pts }],
    { xMin: win.lo, xMax: win.hi, markers, highlight: { x: dashAge, y: row.end }, h: 248, xticks: Math.min(8, Math.max(2, win.hi - win.lo)) });
  const winSum = $('#tlWinSum');
  if (winSum) {
    const wr = R.rows.filter(r => r.age >= win.lo && r.age <= win.hi), s0 = wr[0], s1 = wr[wr.length - 1];
    const dV = s1.end - s0.end, sum = k => wr.reduce((a, r) => a + (r[k] || 0), 0);
    winSum.innerHTML = `<div class="tl-winsum">
      <div class="tws-cell"><span>${win.full ? 'Full plan' : 'Selected period'}</span><b>Ages ${win.lo}–${win.hi} · ${wr.length} yrs</b></div>
      <div class="tws-cell"><span>Portfolio ${win.full ? 'at end' : 'start → end'}</span><b class="amount">${win.full ? fmt$(s1.end) : fmt$(s0.end) + ' → ' + fmt$(s1.end)}</b></div>
      <div class="tws-cell"><span>Change</span><b class="amount ${dV >= 0 ? 'pos' : 'neg'}">${dV >= 0 ? '+' : '−'}${fmt$(Math.abs(dV))}</b></div>
      <div class="tws-cell"><span>Taxes (period)</span><b class="amount">${fmt$(sum('taxes'))}</b></div>
      <div class="tws-cell"><span>Contributions</span><b class="amount">${fmt$(sum('contribution'))}</b></div>
      <div class="tws-cell"><span>Withdrawals</span><b class="amount">${fmt$(sum('withdrawal'))}</b></div>
    </div>`;
  }
  const comp = [
    { label: 'Wages', value: row.wages || 0, color: 'var(--gold)' },
    { label: 'Social Security', value: row.ss || 0, color: 'var(--ink)' },
    { label: 'Pension', value: row.pension || 0, color: '#7c8aa0' },
    { label: 'RMD', value: Math.max(0, (row.rmd || 0) - (row.qcd || 0)), color: '#b08968' },
    { label: 'Portfolio', value: Math.max(0, (row.withdrawal || 0) - (row.rmd || 0)), color: 'var(--good)' }
  ].filter(x => x.value > 0);
  const totalIn = comp.reduce((s, x) => s + x.value, 0) || 1;
  const compbar = comp.map(x => `<i style="width:${(x.value / totalIn * 100).toFixed(1)}%;background:${x.color}"></i>`).join('') || '<i style="width:100%;background:var(--ivory-2)"></i>';
  const complegend = comp.map(x => `<span><i class="dot" style="background:${x.color}"></i>${x.label}</span>`).join('');
  const ms = getMilestones(R)[dashAge];
  const spAge = R.spOn ? (+STATE.household.spouse.age || 0) + (dashAge - R.curAge) : null;
  const side = $('#tlSide');
  if (side) side.innerHTML = `
    <div class="tl-year">${row.year} · ${row.phase === 'work' ? 'Working years' : 'Retirement'}</div>
    <div class="tl-age">${dashAge}<small> &nbsp;${escapeHtml((STATE.household.client.name || 'client').split(' ')[0])}</small></div>
    ${R.spOn ? `<div class="tl-phase">${escapeHtml((STATE.household.spouse.name || 'spouse').split(' ')[0])} is ${spAge}</div>` : ''}
    <div style="margin-top:.9rem"><div class="compbar">${compbar}</div><div class="comp-legend">${complegend}</div></div>
    <div class="tl-rows">
      <div class="tl-row"><span>Portfolio</span><b class="amount big">${fmt$(row.end)}</b></div>
      <div class="tl-row"><span>Net worth</span><b class="amount">${fmt$(row.netWorth)}</b></div>
      <div class="tl-row"><span>Total income</span><b class="amount">${fmt$(totalIn)}</b></div>
      <div class="tl-row"><span>Spending</span><b class="amount">${fmt$(row.need)}</b></div>
      <div class="tl-row"><span>Taxes</span><b class="amount">${fmt$(row.taxes)}</b></div>
      <div class="tl-row"><span>${row.phase === 'work' ? 'Saved' : 'Withdrawn'}</span><b class="amount">${fmt$(row.phase === 'work' ? (row.savedToAccounts || 0) : (row.withdrawal || 0))}</b></div>
      <div class="tl-row"><span>Leftover to spend</span><b class="amount ${(row.leftover || 0) > 0 ? 'pos' : ''}">${fmt$(row.leftover || 0)}</b></div>
    </div>
    <div class="tl-milestone ${ms ? '' : 'none'}"><span class="m-ico">${ms ? '★' : '•'}</span><span>${ms ? ms.join(' · ') : 'A steady year on plan'}</span></div>`;
  const hint = $('#tlHint'); if (hint) hint.innerHTML = `Showing <b>age ${dashAge}</b> · ${row.year} — drag the slider to explore`;
}
function goalProgressList(R) {
  if (!R.goals.length) return '<div class="empty">No goals yet.</div>';
  return R.goals.map(g => `<div style="margin-bottom:.9rem">
    <div class="progress-label"><span><b>${escapeHtml(g.name)}</b> ${badge(g.priority || '', 'gold')}</span><span class="amount">${fmtK(g.projected)} / ${fmtK(g.target)}</span></div>
    <div class="progress ${tone(g.ratio)}"><i style="width:${clamp(g.ratio, 0, 1.2) / 1.2 * 100}%"></i></div></div>`).join('');
}
function insightHTML(i) {
  const ico = { good: '✓', warn: '!', bad: '✕', info: '◆' }[i.sev];
  return `<div class="insight ${i.sev}"><div class="i-ico">${ico}</div><div>
    <h4>${escapeHtml(i.title)}</h4><p>${i.detail}</p>${i.action ? `<div class="i-action">→ ${i.action}</div>` : ''}</div></div>`;
}

/* ----------------------------- PROFILE ------------------------------------ */
function buildProfile() {
  const spOn = STATE.household.spouse.included;
  const st = profileSectionStatus(STATE);
  const left =
    collapsiblePanel('household', 'Household', `
      ${fieldRow({ path: 'household.client.name', label: 'Client name', type: 'text', ph: 'Full name' }, { path: 'household.client.age', label: 'Age', type: 'age' })}
      ${fieldRow({ path: 'household.client.retireAge', label: 'Retirement age', type: 'age' }, { path: 'household.client.lifeExpectancy', label: 'Life expectancy', type: 'age' })}
      ${toggleField('household.spouse.included', 'Include spouse / partner', true)}
      ${spOn ? `${fieldRow({ path: 'household.spouse.name', label: 'Spouse name', type: 'text' }, { path: 'household.spouse.age', label: 'Age', type: 'age' })}
        ${fieldRow({ path: 'household.spouse.retireAge', label: 'Retirement age', type: 'age' }, { path: 'household.spouse.lifeExpectancy', label: 'Life expectancy', type: 'age' })}` : ''}
      ${fieldRow({ path: 'household.filing', label: 'Tax filing', type: 'select', options: [{ value: 'married', label: 'Married filing jointly' }, { value: 'single', label: 'Single' }, { value: 'hoh', label: 'Head of household' }] }, { path: 'household.state', label: 'State', type: 'text', ph: 'e.g. NY' })}`, { status: st.household }) +
    collapsiblePanel('income', 'Income', `
      ${fieldRow({ path: 'income.clientSalary', label: 'Client salary', type: 'currency' }, spOn ? { path: 'income.spouseSalary', label: 'Spouse salary', type: 'currency' } : { path: 'income.otherIncome', label: 'Other income', type: 'currency' })}
      ${spOn ? fieldRow({ path: 'income.otherIncome', label: 'Other income', type: 'currency' }, { path: 'income.salaryGrowth', label: 'Salary growth', type: 'percent' }) : field({ path: 'income.salaryGrowth', label: 'Salary growth', type: 'percent' })}
      ${sectionLabel('Guaranteed retirement income — enter monthly amounts')}
      ${fieldRow({ path: 'income.ssClient', label: 'Social Security — client', hint: 'per month', type: 'monthly' }, spOn ? { path: 'income.ssSpouse', label: 'Social Security — spouse', hint: 'per month', type: 'monthly' } : { path: 'income.pension', label: 'Pension', hint: 'per month', type: 'monthly' })}
      ${fieldRow({ path: 'income.ssClaimClient', label: 'SS claim age — client', hint: 'if already receiving, their current age', type: 'age' }, spOn ? { path: 'income.ssClaimSpouse', label: 'SS claim age — spouse', type: 'age' } : { path: 'income.pensionCola', label: 'Pension COLA', hint: '0 = level payment', type: 'percent' })}
      ${spOn ? fieldRow({ path: 'income.pension', label: 'Pension', hint: 'per month', type: 'monthly' }, { path: 'income.pensionCola', label: 'Pension COLA', hint: '0 = level payment', type: 'percent' }) : ''}
      <p class="budget-note">Not claiming Social Security yet? Enter the <b>ssa.gov estimate at full retirement age (67)</b> — the plan adjusts it up or down for the claim age you choose. Already receiving benefits? Enter <b>what actually arrives each month</b> and set the claim age to when they started (or their current age).</p>`, { status: st.income }) +
    collapsiblePanel('expenses', 'Expenses & Savings', `
      ${expensesBlock()}
      <div class="block-divider"></div>
      ${savingsBlock()}`, { status: st.expenses }) +
    collapsiblePanel('assets', 'Assets', `<div id="assetsList">${(STATE.assets || []).map(assetRow).join('')}</div>
      <button class="add-row" data-action="add-asset">＋ Add account</button>`, { status: st.assets, sub: 'Investable, education & property' }) +
    collapsiblePanel('liabilities', 'Liabilities', `<div id="liabList">${(STATE.liabilities || []).map(liabRow).join('')}</div>
      <button class="add-row" data-action="add-liab">＋ Add liability</button>`) +
    collapsiblePanel('insurance', 'Insurance & Protection', `
      ${fieldRow({ path: 'insurance.lifeClient', label: 'Life insurance — client', type: 'currency' }, spOn ? { path: 'insurance.lifeSpouse', label: 'Life insurance — spouse', type: 'currency' } : { path: 'protection.finalExpenses', label: 'Final expenses', type: 'currency' })}
      ${fieldRow({ path: 'protection.replacePct', label: 'Income replacement', type: 'percent' }, { path: 'protection.replaceYears', label: 'Years', type: 'number' })}
      ${spOn ? field({ path: 'protection.finalExpenses', label: 'Final expenses', type: 'currency' }) : ''}
      ${toggleField('protection.includeDebt', 'Cover outstanding debts')}
      ${toggleField('protection.includeEducation', 'Cover education funding')}`, { status: st.insurance }) +
    collapsiblePanel('assumptions', 'Planning Assumptions', `
      ${fieldRow({ path: 'assumptions.inflation', label: 'Inflation', type: 'percent' }, { path: 'assumptions.ssCola', label: 'SS / COLA', type: 'percent' })}
      ${fieldRow({ path: 'assumptions.preReturn', label: 'Return — pre-retire', type: 'percent' }, { path: 'assumptions.postReturn', label: 'Return — in retire', type: 'percent' })}
      ${fieldRow({ path: 'assumptions.eduInflation', label: 'Education inflation', type: 'percent' }, { path: 'assumptions.stateTaxRate', label: 'State income tax', type: 'percent' })}
      ${fieldRow({ path: 'assumptions.rmdStartAge', label: 'RMD start age', type: 'age' }, { path: 'assumptions.dividendYield', label: 'Taxable acct yield', hint: 'dividends', type: 'percent' })}`) +
    collapsiblePanel('notes', 'Advisor Notes', `<div class="advisor-flag" style="margin-bottom:.5rem">Private — never shown to client</div>
      ${field({ path: 'advisorNotes', label: '', type: 'textarea', rows: 6, ph: 'Confidential notes, meeting follow-ups, strategy reminders…' })}`, { cls: 'advisor-only' });

  getViewEl('profile').innerHTML = headBlock('Foundation', 'Client Profile',
    'Capture the household’s full financial picture. Everything here powers the plan, charts, and client reports.') +
    `<div class="profile-layout"><div class="input-cols">${profileIndexNav(st)}<div class="acc-stack">${left}</div></div><aside class="rail"><div id="res-profile"></div></aside></div>`;
}
function factFinder(S) {
  const out = [], add = (status, label, hint) => out.push({ status, label, hint });
  const c = S.household.client, sp = S.household.spouse, I = S.income, E = S.expenses, SV = S.savings, INS = S.insurance;
  add(c.name ? 'ok' : 'todo', 'Client name', c.name ? '' : 'Full name');
  add((+I.clientSalary > 0 || +I.otherIncome > 0) ? 'ok' : 'todo', 'Income', I.clientSalary > 0 ? '' : 'Annual salary / income');
  add(livingExpenses(E) > 0 ? 'ok' : 'todo', 'Living expenses', livingExpenses(E) > 0 ? '' : 'Annual spending');
  add((+SV.savingsRatePct > 0 || +SV.annualSavings > 0 || +SV.employerMatch > 0) ? 'ok' : 'todo', 'Savings rate', (+SV.savingsRatePct > 0 || +SV.annualSavings > 0) ? '' : 'Saved per year');
  add((S.assets && S.assets.length) ? 'ok' : 'todo', 'Accounts & assets', (S.assets && S.assets.length) ? `${S.assets.length} entered` : 'Add accounts');
  add(+I.ssClient > 0 ? 'ok' : 'todo', 'Social Security', I.ssClient > 0 ? '' : 'Est. benefit (ssa.gov)');
  add(+INS.lifeClient > 0 ? 'ok' : 'todo', 'Life insurance', INS.lifeClient > 0 ? '' : 'Existing coverage');
  if (sp.included) {
    add(sp.name ? 'ok' : 'todo', 'Spouse details', sp.name ? '' : 'Name & age');
    add(+I.spouseSalary > 0 ? 'ok' : 'todo', 'Spouse income', '');
  }
  const debtsMissing = (S.liabilities || []).filter(l => (+l.balance > 0) && (!(+l.rate > 0) || !(+l.payment > 0)));
  if (debtsMissing.length) add('warn', 'Debt details', `${debtsMissing.length} missing rate/payment`);
  if (+c.retireAge <= +c.age && +c.age > 0) add('warn', 'Retirement age', 'At/below current age');
  const gross = (+I.clientSalary || 0) + (+I.spouseSalary || 0) + (+I.otherIncome || 0);
  const effSav = SV.mode === 'percent' ? (+SV.savingsRatePct || 0) / 100 * gross : ((+SV.annualSavings || 0) + (+SV.employerMatch || 0));
  if (gross > 0 && effSav > gross) add('warn', 'Savings vs income', 'Savings exceed income');
  return out;
}
function factFinderPanel() {
  const items = factFinder(STATE);
  const todo = items.filter(i => i.status !== 'ok').length;
  const rows = items.map(i => {
    const ico = i.status === 'ok' ? '✓' : i.status === 'warn' ? '!' : '○';
    return `<div class="ff-row ${i.status}"><span class="ff-ico">${ico}</span><span class="ff-label">${escapeHtml(i.label)}</span>${i.hint ? `<span class="ff-hint">${escapeHtml(i.hint)}</span>` : ''}</div>`;
  }).join('');
  return panel('Fact Finder', rows, { sub: todo ? `${todo} to collect` : 'Complete ✓', cls: 'advisor-only' });
}
function liveProfile() {
  const R = RESULTS;
  syncProfileStatus();
  const el = $('#res-profile'); if (!el) return;
  el.innerHTML = factFinderPanel() + `<div style="height:1rem"></div>` + panel('Snapshot', `
    <div class="grid cols-2" style="margin-bottom:1rem">
      ${statCard('Net Worth', fmt$(R.netWorth), { tone: R.netWorth >= 0 ? 'good' : 'bad', small: true })}
      ${statCard('Investable', fmt$(R.investable), { small: true })}</div>
    ${R.alloc.length ? donut(R.alloc) : '<div class="empty">Add accounts to see allocation.</div>'}
    <div class="section-label">Savings & Liquidity</div>
    ${progressBar('Savings rate (of 15% target)', R.savingsRate / 0.15, { tone: R.savingsRate >= 0.15 ? 'good' : R.savingsRate >= 0.1 ? 'warn' : 'bad' })}
    <div style="height:.7rem"></div>
    ${progressBar('Emergency fund (of 6 months)', R.emergencyMonths / 6, {})}
    `, { sub: 'Live' }) +
    `<div style="height:1rem"></div>` +
    budgetSnapshot(R) +
    savingsByAccountPanel(R) +
    `<div style="height:1rem"></div>` +
    panel('Net Worth', netWorthTable(R));
}
function budgetSnapshot(R) {
  const mIncome = R.grossIncome / 12, mLiving = R.annualExp / 12;
  const liabs = STATE.liabilities || [], SV = STATE.savings;
  const mDebt = liabs.reduce((s, l) => s + (+l.payment || 0), 0);
  const mSave = ((R.rows && R.rows[0] ? R.rows[0].savedToAccounts : 0) || 0) / 12;   // engine truth — works in every savings mode
  const mTax = (R.rows && R.rows[0] ? R.rows[0].taxes : 0) / 12;
  const mLeft = mIncome - mLiving - mDebt - mSave - mTax;
  const items = [
    { label: 'Taxes (est.)', value: mTax, color: 'var(--ink)' },
    { label: 'Living expenses', value: mLiving, color: 'var(--gold)' },
    { label: 'Debt payments', value: mDebt, color: '#b08968' },
    { label: 'Savings', value: mSave, color: 'var(--good)' },
    { label: mLeft >= 0 ? 'Unallocated cushion' : 'Over budget', value: Math.abs(mLeft), color: mLeft >= 0 ? '#7c8aa0' : 'var(--bad)' }
  ].filter(x => x.value > 1);
  const tot = items.reduce((s, x) => s + x.value, 0) || 1;
  const bar = items.map(x => `<i style="width:${(x.value / tot * 100).toFixed(1)}%;background:${x.color}" title="${escapeAttr(x.label)}"></i>`).join('') || '<i style="width:100%;background:var(--ivory-2)"></i>';
  const list = items.map(x => `<div class="cf-bd-row"><span><i class="dot" style="background:${x.color}"></i>${x.label}</span><b class="amount">${fmt$(x.value)}/mo</b></div>`).join('');
  if (mIncome <= 0) return panel('Monthly Budget', '<div class="empty">Enter income to see the monthly budget.</div>', { sub: 'Where the money goes', hideKey: 'prof-budget' });
  return panel('Monthly Budget', `
    <div class="progress-label"><span>Gross income</span><b class="amount">${fmt$(mIncome)}/mo</b></div>
    <div class="compbar" style="height:16px">${bar}</div>
    <div class="cf-bd-list">${list}</div>
    ${mDebt > 0 ? `<p class="budget-note" style="margin-top:.55rem"><b>${fmt$(mDebt)}/mo</b> of loan payments (from ${liabs.length} liabilit${liabs.length === 1 ? 'y' : 'ies'}) are added on top of living expenses — your mortgage belongs in Liabilities, not the budget above.</p>` : '<p class="budget-note" style="margin-top:.55rem">No liabilities entered. Add a mortgage or loan in the Liabilities section and its payment flows in here automatically.</p>'}
  `, { sub: 'Where the money goes', hideKey: 'prof-budget' });
}
/* Today's wages for an account's owner — % of salary means THAT person's salary. */
function ownerWagesNow(owner) {
  const I = STATE.income || {}, spIncl = (STATE.household.spouse || {}).included;
  const wc = +I.clientSalary || 0, ws = spIncl ? (+I.spouseSalary || 0) : 0;
  return owner === 'spouse' ? ws : owner === 'household' ? wc + ws : wc;
}
/* Per-account monthly contribution + employer match, evaluated at today's wages (mirrors the engine's year-1 math). */
function acctContribNow(a) {
  if (!CONTRIB_TYPES.includes(a.type)) return { mo: 0, matchMo: 0, rule: '' };
  const owner = a.owner || (a.type === 'traditional' || a.type === 'roth' ? 'client' : 'household');
  const wages = ownerWagesNow(owner);
  const mo = a.contribMode === 'pct' ? wages * (+a.contribPct || 0) / 100 / 12 : (+a.contribution || 0);
  let matchMo = 0;
  if (a.type === 'traditional' && (+a.matchPct || 0) > 0 && wages > 0 && mo > 0) {
    const rate = Math.min((mo * 12) / wages, (+a.matchCapPct || 0) / 100);
    matchMo = wages * rate * ((+a.matchPct || 0) / 100) / 12;
  }
  const rule = a.contribMode === 'pct' ? `${+a.contribPct || 0}% of salary` : `${fmt$(mo)}/mo`;
  return { mo, matchMo, rule };
}
function savingsByAccountPanel(R) {
  if ((STATE.savings || {}).mode !== 'accounts') return '';
  const wages = R.grossIncome || 0;
  const accts = (STATE.assets || []).map(a => ({ a, c: acctContribNow(a) })).filter(x => x.c.mo > 0 || x.c.matchMo > 0);
  if (!accts.length) return `<div style="height:1rem"></div>` + panel('Savings by Account', '<div class="empty">Enter a contribution on an account below — the 401(k) as a % of salary with its match, a Roth or brokerage in $/month — and the totals appear here.</div>', { sub: 'By account', hideKey: 'prof-sba' });
  const cls = t => t === 'roth' ? ['Roth · tax-free', 'good'] : t === 'traditional' ? ['Tax-deferred', 'gold'] : ['Taxable', 'ink'];
  const grp = { free: 0, def: 0, tax: 0 }; let totMo = 0, matchMo = 0;
  accts.forEach(({ a, c }) => { totMo += c.mo; matchMo += c.matchMo; if (a.type === 'roth') grp.free += c.mo; else if (a.type === 'traditional') grp.def += c.mo + c.matchMo; else grp.tax += c.mo; });
  const rate = wages > 0 ? (totMo * 12) / wages : 0;
  const target = (+STATE.savings.targetRatePct || 0) / 100;
  const rows = accts.map(({ a, c }) => { const [l, t] = cls(a.type); return `<div class="cf-bd-row"><span>${escapeHtml(a.name || 'Account')} ${badge(l, t)}<span style="color:var(--faint);font-size:.7rem"> · ${c.rule}</span></span><b class="amount">${fmt$(c.mo)}/mo</b></div>`
    + (c.matchMo > 0 ? `<div class="cf-bd-row" style="padding-left:1rem"><span style="color:var(--good)">↳ employer match</span><b class="amount" style="color:var(--good)">+${fmt$(c.matchMo)}/mo</b></div>` : ''); }).join('');
  const taxRow = (label, v, color) => v > 0 ? `<div class="cf-bd-row"><span><i class="dot" style="background:${color}"></i>${label}</span><b class="amount">${fmt$(v)}/mo</b></div>` : '';
  const msg = target > 0
    ? (rate >= target ? `✓ Hitting your ${pct(target * 100, 0)} target — saving ${fmt$(totMo)}/mo${matchMo > 0 ? ` + ${fmt$(matchMo)}/mo employer match` : ''} (${fmt$((totMo + matchMo) * 12)}/yr all-in).`
      : `▲ ${pct((target - rate) * 100, 1)} below your ${pct(target * 100, 0)} target — about <b>${fmt$(Math.max(0, (target - rate) * wages / 12))}/mo</b> more gets you there.${matchMo > 0 ? ` Employer adds ${fmt$(matchMo)}/mo on top.` : ''}`)
    : `Saving ${fmt$(totMo)}/mo (${pct(rate * 100, 1)} of income)${matchMo > 0 ? ` + ${fmt$(matchMo)}/mo match` : ''}. Set a target rate in the Savings section.`;
  return `<div style="height:1rem"></div>` + panel('Savings by Account', `
    ${rows}
    <div class="section-label">Where it lands (incl. match)</div>
    ${taxRow('Tax-free (Roth)', grp.free, 'var(--good)')}${taxRow('Tax-deferred', grp.def, 'var(--gold)')}${taxRow('Taxable', grp.tax, 'var(--ink)')}
    <div class="section-label">Savings rate</div>
    ${progressBar(`${pct(rate * 100, 1)} saved${target > 0 ? ` · ${pct(target * 100, 0)} target` : ''}`, target > 0 ? rate / target : rate / 0.15, { tone: (target > 0 ? rate >= target : rate >= 0.15) ? 'good' : rate >= 0.1 ? 'warn' : 'bad' })}
    <p class="i-action" style="margin-top:.5rem">${msg}</p>`, { sub: 'By account', hideKey: 'prof-sba' });
}

/* ----------------------------- NEEDS ANALYSIS ----------------------------- */
function buildNeeds() {
  const retInputs =
    fieldRow({ path: 'quickRetire.age', label: 'Current age', type: 'age' }, { path: 'quickRetire.retireAge', label: 'Retire at', type: 'age' }) +
    field({ path: 'quickRetire.desiredAnnualIncome', label: 'Desired income / yr', hint: 'today’s $', type: 'currency' }) +
    fieldRow({ path: 'quickRetire.currentSavings', label: 'Saved so far', type: 'currency' }, { path: 'quickRetire.monthlySavings', label: 'Saving / mo', type: 'currency', step: 50 }) +
    field({ path: 'quickRetire.socialSecurity', label: 'Social Security / yr', type: 'currency' });
  const eduInputs =
    fieldRow({ path: 'quickEducation.childName', label: 'Student', type: 'text' }, { path: 'quickEducation.annualCost', label: 'Cost / yr', type: 'currency' }) +
    fieldRow({ path: 'quickEducation.yearsUntil', label: 'Years until', type: 'number' }, { path: 'quickEducation.duration', label: 'Years of school', type: 'number', min: 1 }) +
    fieldRow({ path: 'quickEducation.funded', label: 'Saved so far', type: 'currency' }, { path: 'quickEducation.monthly', label: 'Saving / mo', type: 'currency', step: 50 });
  const protInputs =
    fieldRow({ path: 'quickProtect.income', label: 'Income to replace', type: 'currency' }, { path: 'quickProtect.replacePct', label: 'Replace %', type: 'percent' }) +
    fieldRow({ path: 'quickProtect.replaceYears', label: 'For years', type: 'number' }, { path: 'quickProtect.existingCoverage', label: 'Existing coverage', type: 'currency' }) +
    fieldRow({ path: 'quickProtect.debts', label: 'Debts to clear', type: 'currency' }, { path: 'quickProtect.finalExpenses', label: 'Final expenses', type: 'currency' });
  getViewEl('needs').innerHTML = headBlock('Engage', 'Needs Analysis',
    'Quick, single-goal analyses that create immediate impact. Adjust a few inputs and show the result live — then open the door to deeper planning.') +
    `<div class="grid cols-3" style="align-items:start">
      ${panel('Retirement', retInputs + '<div id="res-needs-ret"></div>', { sub: 'Quick' })}
      ${panel('Education', eduInputs + '<div id="res-needs-edu"></div>', { sub: 'Quick' })}
      ${panel('Protection', protInputs + '<div id="res-needs-prot"></div>', { sub: 'Quick' })}
    </div>
    <p class="view-sub" style="margin-top:1rem">These are fast estimates. Open <b>Foundational Planning</b> for the comprehensive, account-level picture.</p>`;
}
function needsResult(stats, ratio, chart) {
  return `<div class="section-label">Result</div>
    <div class="grid cols-2" style="gap:.7rem;margin-bottom:.8rem">${stats}</div>
    ${progressBar('Funded', ratio, {})}<div style="height:.7rem"></div>${chart}`;
}
function liveNeeds() {
  const A = STATE.assumptions, R = RESULTS;
  const infl = A.inflation / 100, pre = A.preReturn / 100, post = A.postReturn / 100;
  // Retirement quick
  const q = STATE.quickRetire;
  const yrs = Math.max(0, q.retireAge - q.age), ry = Math.max(1, q.lifeExpectancy - q.retireAge);
  const proj = fv(q.currentSavings, pre, yrs) + fvAnnuity(q.monthlySavings * 12, pre, yrs);
  const need = q.desiredAnnualIncome * pow(1 + infl, yrs), ss = q.socialSecurity * pow(1 + infl, yrs);
  const cap = pvGrowingAnnuity(Math.max(0, need - ss), post, infl, ry);
  const rr = cap > 0 ? proj / cap : 1, extra = pmtForFV(Math.max(0, cap - proj), pre, yrs) / 12;
  if ($('#res-needs-ret')) $('#res-needs-ret').innerHTML = needsResult(
    statCard('Capital needed', fmt$(cap), { small: true }) + statCard('Projected', fmt$(proj), { small: true, tone: tone(rr) }),
    rr, barChart([{ label: 'Needed', value: cap, bars: [{ value: cap, color: 'var(--ink)' }] }, { label: 'Projected', value: proj, bars: [{ value: proj, color: 'var(--gold)' }] }], { h: 150 }) +
    `<p class="i-action" style="margin-top:.5rem">${rr >= 1 ? '✓ On track for the income goal.' : `→ Save about <b>${fmt$(extra)}/mo</b> more to fully fund.`}</p>`);
  // Education quick (from RESULTS)
  if ($('#res-needs-edu')) $('#res-needs-edu').innerHTML = R.eduFuture > 0 ? needsResult(
    statCard('Total cost', fmt$(R.eduFuture), { small: true }) + statCard('Projected', fmt$(R.eduProjected), { small: true, tone: tone(R.eduFundedRatio) }),
    R.eduFundedRatio, barChart([{ label: 'Cost', value: R.eduFuture, bars: [{ value: R.eduFuture, color: 'var(--ink)' }] }, { label: 'Saved', value: R.eduProjected, bars: [{ value: R.eduProjected, color: 'var(--gold)' }] }], { h: 150 }) +
    `<p class="i-action" style="margin-top:.5rem">${R.eduGap <= 0 ? '✓ Education goal on track.' : `→ Save about <b>${fmt$(R.eduReqMonthly)}/mo</b> to fully fund.`}</p>`) :
    '<div class="empty">Enter an annual cost to analyze.</div>';
  // Protection quick
  const qp = STATE.quickProtect, realRate = Math.max(0.0005, (1 + post) / (1 + infl) - 1);
  const pneed = pvAnnuity(qp.income * (qp.replacePct / 100), realRate, qp.replaceYears) + (+qp.debts || 0) + (+qp.finalExpenses || 0);
  const pgap = Math.max(0, pneed - (+qp.existingCoverage || 0)), pratio = pneed > 0 ? clamp((qp.existingCoverage || 0) / pneed, 0, 1) : 1;
  if ($('#res-needs-prot')) $('#res-needs-prot').innerHTML = needsResult(
    statCard('Total need', fmt$(pneed), { small: true }) + statCard('Coverage gap', pgap > 0 ? fmt$(pgap) : 'None', { small: true, raw: pgap <= 0, tone: pgap > 0 ? 'warn' : 'good' }),
    pratio, barChart([{ label: 'Need', value: pneed, bars: [{ value: pneed, color: 'var(--ink)' }] }, { label: 'In force', value: qp.existingCoverage, bars: [{ value: qp.existingCoverage, color: 'var(--gold)' }] }], { h: 150 }) +
    `<p class="i-action" style="margin-top:.5rem">${pgap <= 0 ? '✓ Protection need is covered.' : `→ Consider <b>${fmt$(pgap)}</b> additional coverage.`}</p>`);
}

/* ----------------------------- GOALS & CASH FLOW -------------------------- */
function buildCashflow() {
  getViewEl('cashflow').innerHTML = headBlock('Plan', 'Goals & Cash Flow',
    'Combine goals-based funding with comprehensive, year-by-year cash flow — the right conversation at the right time.', collapseBtn()) +
    `<div class="split io-split"><div class="advisor-only io-inputs">
      ${panel('Goals', `<div id="goalsList">${(STATE.goals || []).map(goalRow).join('')}</div><button class="add-row" data-action="add-goal">＋ Add goal</button>`,
        { sub: 'Funding tracker' })}
    </div><div id="res-cashflow"></div></div>`;
}
let CF_GRANULARITY = 'all';   /* 'all' | 'five' — cash-flow table granularity */
const cfGranularityToggle = () => `<span class="seg advisor-only" role="group" aria-label="Table granularity">
  <button class="seg-btn ${CF_GRANULARITY === 'all' ? 'on' : ''}" data-action="cf-granularity" data-mode="all">Every year</button>
  <button class="seg-btn ${CF_GRANULARITY === 'five' ? 'on' : ''}" data-action="cf-granularity" data-mode="five">Every 5 yrs</button></span>`;
function cfCell(age, metric, inner) {
  return `<button class="cf-cell" data-cf-break="${metric}" data-cf-age="${age}" aria-expanded="false" title="See the breakdown">${inner}</button>`;
}
function cfBreakdown(r, metric) {
  const A = STATE.assumptions, infl = (+A.inflation || 0) / 100, g = pow(1 + infl, r.t || 0), curAge = +STATE.household.client.age || 0;
  const cn = ((STATE.household.client.name || 'Client').split(' ')[0]) || 'Client';
  const sn = ((STATE.household.spouse.name || 'Spouse').split(' ')[0]) || 'Spouse', spOn = STATE.household.spouse.included;
  const dl = arr => { const f = arr.filter(x => x.v > 0.5); return f.length ? f.map(x => `<div class="cf-drill-row"><span>${x.l}</span><b class="amount">${fmt$(x.v)}${x.pct != null ? ' · ' + pct(x.pct, 0) + ' of portfolio' : ''}</b></div>`).join('') : '<div class="cf-drill-row"><span style="color:var(--faint)">No detail to break out</span></div>'; };
  const acctDrill = (types, bucketVal) => {                            // named accounts in a tax bucket + each one's estimated % of the total portfolio
    const accts = (STATE.assets || []).filter(a => types.includes(a.type));
    const initSum = accts.reduce((s, a) => s + (+a.balance || 0), 0), total = r.end || 1;
    if (!accts.length) return bucketVal > 1 ? dl([{ l: 'Accumulated savings (no named account)', v: bucketVal, pct: bucketVal / total * 100 }]) : dl([]);
    return dl(accts.map(a => { const share = initSum > 0 ? (+a.balance || 0) / initSum : 1 / accts.length; const v = bucketVal * share; return { l: escapeHtml(a.name || '(unnamed account)'), v, pct: v / total * 100 }; }));
  };
  if (metric === 'income') return { title: 'Income sources', items: [
    { label: 'Wages / earned', value: r.wages || 0, color: 'var(--gold)', drill: dl([{ l: cn, v: r.wagesC || 0 }].concat(spOn ? [{ l: sn, v: r.wagesS || 0 }] : [])) },
    { label: 'Social Security', value: r.ss || 0, color: 'var(--ink)', drill: dl([{ l: cn, v: r.ssC || 0 }].concat(spOn ? [{ l: sn, v: r.ssS || 0 }] : [])) },
    { label: 'Pension', value: r.pension || 0, color: '#7c8aa0' },
    { label: 'Annuity', value: r.annuity || 0, color: 'var(--gold-deep)' },
    { label: 'Disability', value: r.disabilityInc || 0, color: '#b08968' },
    { label: 'Other income', value: r.otherInc || 0, color: 'var(--good)' },
    { label: 'RMD (required)', value: r.rmdW || 0, color: 'var(--warn)' },
    { label: 'Windfall / one-off', value: r.evIn || 0, color: 'var(--gold-2)' }
  ] };
  if (metric === 'spending') {
    const detailed = STATE.expenses.expenseMode === 'detailed';
    const livingDrill = detailed ? dl(EXP_CATS.map(([k, lab]) => ({ l: lab, v: (+STATE.expenses.budget[k] || 0) * 12 * g }))) : '<div class="cf-drill-row"><span style="color:var(--faint)">Single annual figure — switch Expenses to a budget to itemize</span></div>';
    const debtDrill = dl((STATE.liabilities || []).map(l => ({ l: escapeHtml(l.name || l.type || 'Loan') + ' (' + l.type + ')', v: (+l.payment || 0) * 12 })));
    const goalDrill = dl((STATE.goals || []).map(go => ({ l: escapeHtml(go.name || go.type), v: goalSpendYear([go], r.age, infl, curAge, (+A.eduInflation || 5) / 100) })));
    const evDrill = dl((STATE.events || []).map(e => ({ l: escapeHtml(e.label || e.type), v: applyEventsYear([e], r.age, r.t || 0, infl).out })));
    return { title: 'Spending this year', note: (r.eduDraw || 0) > 0.5 ? '529/education savings covered ' + fmt$(r.eduDraw) + ' of tuition this year — drawn before household cash flow.' : undefined, items: [
      { label: 'Living expenses', value: r.expenses || 0, color: 'var(--gold)', drill: livingDrill },
      { label: 'Debt payments', value: r.debtPay || 0, color: '#b08968', drill: debtDrill },
      { label: 'Life-event costs', value: r.evOut || 0, color: '#7c8aa0', drill: evDrill },
      { label: 'Goal spending', value: r.goalOut || 0, color: 'var(--gold-deep)', drill: goalDrill }
    ] };
  }
  if (metric === 'taxes') return { title: 'Taxes this year', items: [
    { label: 'Federal', value: r.fed || 0, color: 'var(--ink)' },
    { label: 'State', value: r.state || 0, color: '#7c8aa0' },
    { label: 'FICA (payroll)', value: r.fica || 0, color: '#b08968' }
  ] };
  if (metric === 'flow') {
    if (r.phase === 'work') {
      const acctMode = STATE.savings.mode === 'accounts', sg = pow(1 + ((+STATE.income.salaryGrowth || 0) / 100), r.t || 0);
      const byType = types => dl((STATE.assets || []).filter(a => types.includes(a.type) && (+a.contribution || 0) > 0).map(a => ({ l: escapeHtml(a.name || '(account)'), v: (+a.contribution || 0) * 12 * sg })));
      return { title: 'Savings this year', items: [
        { label: 'Pre-tax (401k / IRA)', value: r.cPretax || 0, color: 'var(--gold)', drill: acctMode ? byType(['traditional']) : undefined },
        { label: 'Roth', value: r.cRoth || 0, color: 'var(--gold-deep)', drill: acctMode ? byType(['roth']) : undefined },
        { label: 'Taxable', value: r.cTaxable || 0, color: '#7c8aa0', drill: acctMode ? byType(['cash', 'taxable', 'other']) : undefined },
        { label: 'Employer match', value: r.match || 0, color: 'var(--good)' }
      ] };
    }
    return { title: 'Withdrawals this year', items: [
      { label: 'From taxable', value: r.wTax || 0, color: 'var(--gold)', drill: acctDrill(['cash', 'taxable', 'other'], r.bTax) },
      { label: 'From tax-deferred', value: r.wDef || 0, color: 'var(--ink)', drill: acctDrill(['traditional'], r.bDef) },
      { label: 'From Roth', value: r.wRoth || 0, color: 'var(--gold-deep)', drill: acctDrill(['roth'], r.bRoth) }
    ] };
  }
  const guar = [];
  if ((r.pension || 0) > 0.5) guar.push('pension ' + fmt$(r.pension) + '/yr');
  if ((r.ss || 0) > 0.5) guar.push('Social Security ' + fmt$(r.ss) + '/yr');
  if ((r.annuity || 0) > 0.5) guar.push('annuity ' + fmt$(r.annuity) + '/yr');
  const pnote = guar.length
    ? 'Investable accounts only — your guaranteed income (' + guar.join(', ') + ') pays out as income (see the Income breakdown) and has no account balance, so it isn’t part of the portfolio value.'
    : 'Investable accounts only — guaranteed income (pension, Social Security, annuities) shows in the Income breakdown, not here; real estate sits in net worth.';
  return { title: 'Portfolio composition', note: pnote, items: [
    { label: 'Taxable', value: r.bTax || 0, color: 'var(--gold)', drill: acctDrill(['cash', 'taxable', 'other'], r.bTax) },
    { label: 'Tax-deferred', value: r.bDef || 0, color: 'var(--ink)', drill: acctDrill(['traditional'], r.bDef) },
    { label: 'Roth', value: r.bRoth || 0, color: 'var(--gold-deep)', drill: acctDrill(['roth'], r.bRoth) }
  ] };
}
function cfBreakdownHTML(r, metric) {
  if (metric === 'leftover') {                                         // waterfall: income − taxes − spending − savings (− draws) = leftover
    const saved = r.phase === 'work' ? (r.savedToAccounts || 0) : 0, draw = r.phase === 'work' ? 0 : (r.withdrawal || 0);
    const wf = [{ l: 'Income', v: r.income || 0 }, { l: '− Taxes', v: -(r.taxes || 0) }, { l: '− Spending', v: -(r.need || 0) }];
    if (saved > 0.5) wf.push({ l: '− Saved to accounts', v: -saved });
    if (draw > 0.5) wf.push({ l: '+ Portfolio withdrawals', v: draw });
    const list = wf.map(x => `<div class="cf-bd-row"><span>${x.l}</span><b class="amount">${x.v < 0 ? '−' : ''}${fmt$(Math.abs(x.v))}</b></div>`).join('');
    const note = (r.leftover || 0) < 1 ? 'Income is fully used by spending, taxes and savings this year.' : (r.surplusInvested ? 'Your setting invests this surplus as extra taxable savings.' : 'Discretionary — free to use or spend (not invested).');
    return `<div class="cf-bd"><div class="cf-bd-head">Left over · <b class="amount">${fmt$(r.leftover || 0)}</b> <span class="cf-bd-year">in ${r.year} (age ${r.age})</span></div>
      <div class="cf-bd-list">${list}<div class="cf-bd-row cf-bd-total"><span><b>= Left over</b></span><b class="amount">${fmt$(r.leftover || 0)}</b></div></div>
      <p class="budget-note" style="margin-top:.4rem">${note}</p></div>`;
  }
  const d = cfBreakdown(r, metric);
  const items = d.items.filter(x => x.value > 0.5);
  const total = items.reduce((s, x) => s + x.value, 0) || 1;
  const bar = items.length
    ? items.map(x => `<i style="width:${(x.value / total * 100).toFixed(1)}%;background:${x.color}" title="${escapeAttr(x.label)}"></i>`).join('')
    : '<i style="width:100%;background:var(--ivory-2)"></i>';
  const list = items.map(x => {
    const rowHtml = `<div class="cf-bd-row"><span><i class="dot" style="background:${x.color}"></i>${x.label}${x.drill ? '<span class="cf-more" aria-hidden="true">›</span>' : ''}</span><b class="amount">${fmt$(x.value)} · ${pct(x.value / total * 100, 0)}</b></div>`;
    return x.drill ? `<div class="cf-drill-host" tabindex="0" title="Hover or tap for the detail">${rowHtml}<div class="cf-drill">${x.drill}</div></div>` : rowHtml;
  }).join('') || '<span style="color:var(--faint)">No components this year.</span>';
  return `<div class="cf-bd">
    <div class="cf-bd-head">${d.title} · <b class="amount">${fmt$(total)}</b> <span class="cf-bd-year">in ${r.year} (age ${r.age})</span></div>
    <div class="compbar">${bar}</div>
    <div class="cf-bd-list">${list}</div>${d.note ? `<p class="budget-note" style="margin-top:.4rem">${d.note}</p>` : ''}</div>`;
}
function toggleCfBreakdown(el) {
  const tr = el.closest('tr'); if (!tr) return;
  const metric = el.getAttribute('data-cf-break'), age = +el.getAttribute('data-cf-age');
  const next = tr.nextElementSibling, openHere = next && next.classList.contains('cf-detail');
  const sameCell = openHere && next.getAttribute('data-cf-metric') === metric;
  if (openHere) next.remove();
  tr.querySelectorAll('.cf-cell.on').forEach(b => { b.classList.remove('on'); b.setAttribute('aria-expanded', 'false'); });
  if (sameCell) return;
  const r = (RESULTS.rows || []).find(x => x.age === age); if (!r) return;
  const detail = document.createElement('tr');
  detail.className = 'cf-detail'; detail.setAttribute('data-cf-metric', metric); detail.setAttribute('data-cf-age', String(age));
  detail.innerHTML = `<td colspan="${tr.children.length}">${cfBreakdownHTML(r, metric)}</td>`;
  tr.insertAdjacentElement('afterend', detail);
  el.classList.add('on'); el.setAttribute('aria-expanded', 'true');
}
function cashflowTable(R) {
  const rows = CF_GRANULARITY === 'five'
    ? R.rows.filter(r => r.t % 5 === 0 || r.age === R.retAge || r.age === R.endAge)
    : R.rows;
  const body = rows.map(r => {
    const flow = r.phase === 'work' ? (r.savedToAccounts || 0) : -(r.withdrawal || 0);
    return `<tr><td>${r.age}</td><td style="text-align:left"><span class="badge ${r.phase === 'work' ? 'gold' : 'ink'}">${r.phase === 'work' ? 'Working' : 'Retired'}</span></td>
      <td class="amount">${cfCell(r.age, 'income', fmtK(r.income))}</td>
      <td class="amount">${cfCell(r.age, 'spending', fmtK(r.need))}</td>
      <td class="amount">${cfCell(r.age, 'taxes', fmtK(r.taxes))}</td>
      <td class="amount ${flow >= 0 ? 'pos' : 'neg'}">${cfCell(r.age, 'flow', (flow >= 0 ? '+' : '−') + fmtK(Math.abs(flow)))}</td>
      <td class="amount ${(r.leftover || 0) > 0 ? 'pos' : ''}">${cfCell(r.age, 'leftover', fmtK(r.leftover || 0))}</td>
      <td class="amount">${cfCell(r.age, 'portfolio', fmtK(r.end))}</td></tr>`;
  }).join('');
  return `<div class="tbl-scroll"><table class="tbl cf-tbl"><thead><tr><th>Age</th><th style="text-align:left">Phase</th><th>Income</th><th>Spending</th><th>Taxes</th><th>Saved / Drawn</th><th>Leftover</th><th>Portfolio</th></tr></thead><tbody>${body}</tbody></table>
    <p class="cf-hint">Income − Spending − Taxes − Saved = Leftover. Tap any amount to see how it breaks down ↓</p></div>`;
}
function liveCashflow() {
  const R = RESULTS, el = $('#res-cashflow'); if (!el) return;
  const reqList = R.goals.filter(g => g.reqMonthly > 0);
  const totalRequired = reqList.reduce((s, g) => s + g.reqMonthly, 0);
  const reqHTML = reqList.length
    ? `<div class="section-label">Required monthly to fully fund</div>` + reqList.map(g => `<div class="progress-label"><span>${escapeHtml(g.name)}</span><b class="amount">${fmt$(g.reqMonthly)}/mo</b></div>`).join('')
    : `<p class="i-action" style="margin-top:.6rem">✓ All goals on track at current savings.</p>`;
  el.innerHTML =
    `<div class="grid cols-3" style="margin-bottom:1rem">
      ${statCard('Net Worth', fmt$(R.netWorth), { tone: R.netWorth >= 0 ? 'good' : 'bad' })}
      ${statCard('Retirement Funded', pct(R.fundedRatio * 100, 0), { raw: true, tone: tone(R.fundedRatio), valClass: 'val-' + tone(R.fundedRatio) })}
      ${statCard('To fully fund goals', fmt$(totalRequired) + '/mo', { raw: true, note: 'additional savings' })}
    </div>` +
    panel('Goal Funding', goalProgressList(R) + reqHTML, { hideKey: 'cf-goals' }) +
    `<div style="height:1.1rem"></div>` +
    panel('Cash Flow Projection', lineChart([portfolioSeries(R)], { markers: [{ x: R.retAge, label: 'Retire' }] }) + cashflowTable(R), { sub: `Ages ${R.curAge}–${R.endAge}`, hideKey: 'cf-table', headExtra: cfGranularityToggle() });
}

/* ----------------------------- FOUNDATIONAL ------------------------------- */
function mcPanel() {
  const R = RESULTS;
  const mc = mcAsync(() => { if (currentView === 'foundational') (presentMode ? showPresentView('foundational') : renderFoundational()); });
  if (!mc) return panel('Monte Carlo — Probability of Success', '<div class="empty"><div class="e-ico">◷</div>Running 600 randomized market simulations…</div>', { sub: 'Confidence', hideKey: 'found-mc' });
  const pctV = Math.round(mc.success * 100);
  const t3 = pctV >= 80 ? 'good' : pctV >= 60 ? 'warn' : 'bad';
  const band = pctV >= 80 ? 'Highly confident' : pctV >= 60 ? 'On track' : pctV >= 40 ? 'Needs attention' : 'At risk';
  return panel('Monte Carlo — Probability of Success', `
    <div class="split" style="grid-template-columns:270px 1fr;align-items:center;gap:1.4rem">
      <div style="text-align:center">${gauge(pctV)}
        <div style="margin-top:.2rem">${badge(band, t3)}</div>
        <p class="i-action" style="margin-top:.6rem">Across <b>${mc.trials}</b> randomized market simulations, the plan funds the full lifestyle through age ${R.life} in <b>${pctV}%</b> of outcomes.</p></div>
      <div>${bandChart(mc.ages, mc.p10, mc.p50, mc.p90, { markers: [{ x: R.retAge, label: 'Retire' }], h: 226 })}
        <div class="legend"><span><i class="dot" style="background:var(--gold)"></i>Range of outcomes (10th–90th percentile)</span><span><i class="dot" style="background:var(--gold-deep)"></i>Median path</span></div>
        <div class="grid cols-3" style="gap:.7rem;margin-top:.85rem">
          ${statCard('Downside · 10th', fmtK(mc.endP10), { small: true, tone: mc.endP10 > 0 ? 'warn' : 'bad' })}
          ${statCard('Median · 50th', fmtK(mc.endP50), { small: true, tone: 'good' })}
          ${statCard('Upside · 90th', fmtK(mc.endP90), { small: true })}</div></div>
    </div>`, { hideKey: 'found-mc', sub: 'Confidence' });
}
function methodologyPanel() {
  const A = STATE.assumptions, SV = STATE.savings, R = RESULTS;
  const li = (t, d) => `<div class="cf-bd-row" style="align-items:flex-start;padding:.18rem 0"><span style="flex:0 0 168px;font-weight:600;color:var(--ink-2)">${t}</span><span style="text-align:left;flex:1">${d}</span></div>`;
  return panel('Assumptions & Methodology', `
    <div class="section-label" style="margin-top:0">Key assumptions in this plan</div>
    <div class="rr-grid" style="margin:.2rem 0 .6rem">
      ${[['Inflation', pct(A.inflation, 1) + '/yr'], ['Return before retirement', pct(A.preReturn, 1) + (SV.mode === 'accounts' ? ' (blended by account)' : '')], ['Return in retirement', pct(A.postReturn, 1)], ['Salary growth', pct(STATE.income.salaryGrowth, 1) + '/yr'], ['SS COLA', pct(A.ssCola, 1) + '/yr'], ['Education inflation', pct(A.eduInflation, 1) + '/yr'], ['State tax', pct(A.stateTaxRate, 1) + ' flat'], ['RMDs begin', 'age ' + (A.rmdStartAge || 73)]].map(([k, v]) => `<div class="rr-cell"><label>${k}</label><div style="font-weight:600">${v}</div></div>`).join('')}
    </div>
    <div class="section-label">How every number is calculated</div>
    ${li('Income taxes', `Federal tax uses the ${TAX.baseYear} brackets and standard deduction (filers 65+ get the extra standard deduction), indexed with inflation each projection year. Qualified dividends and realized gains stack on top of ordinary income at capital-gains rates. Social Security is taxed by the provisional-income rules. FICA applies per earner while working, each with their own wage-base cap. State tax is a flat rate on AGI less the deduction.`)}
    ${li('Social Security', `You enter the benefit at full retirement age (67). Claiming earlier or later scales it — roughly 70% at 62 up to 124% at 70 — then it grows with COLA. If a spouse passes, the survivor keeps the larger of the two benefits.`)}
    ${li('Withdrawals & RMDs', `Retirement spending draws taxable accounts first, then tax-deferred, then Roth; the engine iterates so withdrawals also cover the taxes they create. Required minimum distributions follow the IRS Uniform Lifetime table from age ${A.rmdStartAge || 73} — even in years a younger spouse is still working — and qualified charitable distributions satisfy RMDs tax-free.`)}
    ${li('Savings', `Savings follow your chosen mode ($ / % of income / by account) and route to pre-tax, Roth, or taxable. The employer match is modeled on 401(k) contributions up to your plan limit. Leftover income after expenses, taxes and planned savings is ${SV.surplusMode === 'discretionary' ? 'treated as discretionary spending (not invested)' : 'invested as additional taxable savings'}.`)}
    ${li('Education (529)', `Education balances grow with the market and tuition is paid from them first; only the uncovered share hits household cash flow.`)}
    ${li('Goals & events', `Goals flagged onto the timeline create real cash flows: home and financed purchases spend the down payment and amortize a loan at your term and rate; long-term care applies the net-of-insurance cost over the care window; recurring goals (travel, gifting, charitable, custom) flow over their start–end ages at their own inflation. Each goal also shows the savings required to fund it.`)}
    ${li('Debts', `Each liability amortizes at its rate and payment (or the payment derived from its term). The payoff accelerator applies extra payments avalanche (highest rate) or snowball (smallest balance) first.`)}
    ${li('Guaranteed income', `Pensions and income annuities pay as income, not balances (an annuity purchase converts a premium to lifetime income at roughly 5% at 60 + 0.25% per year of age, capped at 9%). A joint-and-survivor pension election reduces the benefit ~15% × the continuation share and keeps it paying to the survivor.`)}
    ${li('Monte Carlo', `${(mcAsync(() => {}) || { trials: 600 }).trials} trials with normally distributed annual returns (${pct(A.volatilityPre != null ? A.volatilityPre : 12, 0)} volatility before retirement, ${pct(A.volatilityPost != null ? A.volatilityPost : 9, 0)} after) around your expected returns; success = never depleting through age ${R.life}.`)}
    ${li('What-ifs', `Decision-Center levers and scenarios (survivor, disability, market downturn) re-run this same engine with the change applied — nothing is a side calculation.`)}
    <p class="rp-disclaimer" style="margin-top:.55rem">All figures are hypothetical estimates for planning conversation — not tax, legal, or investment advice. Tax rules are simplified (notably: portfolio draws that cover working-year shortfalls are not taxed, and account-level future balances are estimates within their tax bucket).</p>
  `, { sub: 'How this plan works', hideKey: 'found-method', cls: 'advisor-only' });
}
/* The first retirement year, spelled out — spending − guaranteed income + taxes = the real withdrawal.
   This is the line that answers "why doesn't 6% just work?" in the meeting. */
function withdrawalExplainer(R) {
  const r1 = (R.rows || []).find(r => r.phase === 'retire'); if (!r1) return '';
  const startBal = r1.t > 0 ? (R.rows[r1.t - 1].end || 0) : R.investable;
  const guaranteed = (r1.ss || 0) + (r1.pension || 0) + (r1.annuity || 0);
  const spend = (r1.need || 0);
  const gross = (r1.withdrawal || 0) + (r1.rmdW || 0);
  const wRate = startBal > 0 ? gross / startBal : 0;
  if (spend <= 0) return '';
  const line = (l, v, cls) => `<div class="cf-bd-row"><span>${l}</span><b class="amount ${cls || ''}">${v}</b></div>`;
  return `<div class="section-label">First year of retirement — the real withdrawal</div>
    ${line('Spending need (incl. debts & goals)', fmt$(spend))}
    ${line('Guaranteed income (SS · pension · annuity)', '− ' + fmt$(guaranteed))}
    ${line('Estimated taxes that year', '+ ' + fmt$(r1.taxes || 0))}
    ${line('<b>Portfolio withdrawal</b>', fmt$(gross), wRate > 0.055 ? 'neg' : 'pos')}
    <p class="budget-note" style="margin-top:.45rem">That’s <b>${pct(wRate * 100, 1)}</b> of the portfolio in year one, growing with inflation — at the plan’s ${pct(+STATE.assumptions.postReturn || 0, 1)} in-retirement return. Taxes are the piece most people forget: the gap between spending and guaranteed income must be grossed up to cover them.</p>`;
}
function renderFoundational() {
  const R = RESULTS;
  const sources = [
    { label: 'Social Security / Pension', value: R.guaranteedAtRet, color: 'var(--ink)' },
    { label: 'Portfolio withdrawals', value: Math.max(0, R.needAtRet - R.guaranteedAtRet), color: 'var(--gold)' }
  ];
  getViewEl('foundational').innerHTML = headBlock('Holistic', 'Foundational Planning',
    'The full picture — net worth, retirement outlook, and goal funding in one confident view.') +
    `<div class="grid cols-4" style="margin-bottom:1.1rem">
      ${statCard('Net Worth', fmt$(R.netWorth), { tone: R.netWorth >= 0 ? 'good' : 'bad' })}
      ${statCard('Investable Assets', fmt$(R.investable))}
      ${statCard('Retirement Funded', pct(R.fundedRatio * 100, 0), { raw: true, tone: tone(R.fundedRatio), valClass: 'val-' + tone(R.fundedRatio) })}
      ${R.alreadyRetired
        ? statCard('In retirement', 'Retired at ' + R.retAge, { raw: true })
        : statCard('Years to Retirement', R.yearsToRet + ' yrs', { raw: true })}
    </div>
    ${mcPanel()}
    <div style="height:1.1rem"></div>
    <div class="split" style="grid-template-columns:1fr 1fr;align-items:start">
      ${panel('Net Worth & Allocation', (R.alloc.length ? donut(R.alloc) : '') + '<div style="height:.8rem"></div>' + netWorthTable(R), { hideKey: 'found-nw' })}
      ${panel('Retirement Outlook',
        lineChart([portfolioSeries(R)], { markers: [{ x: R.retAge, label: 'Retire ' + R.retAge }], h: 220 }) +
        `<div class="grid cols-2" style="gap:.7rem;margin:.8rem 0">
          ${statCard('Capital Needed', fmt$(R.capitalNeeded), { small: true, note: R.alreadyRetired ? 'remaining lifetime' : undefined })}
          ${statCard(R.alreadyRetired ? 'Current Portfolio' : 'Projected at Retire', fmt$(R.projAtRet), { small: true, tone: tone(R.fundedRatio) })}</div>
        ${progressBar('Funded ratio', R.fundedRatio, {})}
        ${withdrawalExplainer(R)}
        <div class="section-label">Retirement income sources (first year)</div>${donut(sources, { size: 160 })}`, { hideKey: 'found-ret' })}
    </div>
    <div style="height:1.1rem"></div>
    ${panel('Goal Funding', goalProgressList(R), { hideKey: 'found-goals' })}
    <div style="height:1.1rem"></div>
    ${methodologyPanel()}`;
}

/* ----------------------------- DECISION CENTER ---------------------------- */
let SCENARIO = { retireDelta: 0, savingsMult: 1, returnDelta: 0, spendDelta: 0, ssDelta: 0, insuranceMult: 1, ltcCoverage: 0 };
function fmtScn(key, v) {
  if (key === 'savingsMult' || key === 'insuranceMult') return (+v).toFixed(2) + '×';
  if (key === 'returnDelta') return (v > 0 ? '+' : '') + (+v).toFixed(1) + '%';
  if (key === 'retireDelta') return (v > 0 ? '+' : '') + v + ' yrs';
  if (key === 'spendDelta') return (v > 0 ? '+' : '') + v + ' pts';
  if (key === 'ltcCoverage') return v + '% covered';
  return (v > 0 ? '+' : '') + v + '%';
}
function slider(key, label, min, max, step) {
  return `<div class="slider-field"><div class="sf-top"><span>${label}</span><span class="sf-val" id="scnv-${key}">${fmtScn(key, SCENARIO[key])}</span></div>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${SCENARIO[key]}" data-scn="${key}"></div>`;
}
function applyScenario(base) {
  const s = JSON.parse(JSON.stringify(base));
  s.household.client.retireAge = (+s.household.client.retireAge || 65) + SCENARIO.retireDelta;
  if (s.household.spouse.included) s.household.spouse.retireAge = (+s.household.spouse.retireAge || 65) + SCENARIO.retireDelta;
  if (s.savings.mode === 'percent') s.savings.savingsRatePct = (+s.savings.savingsRatePct || 0) * SCENARIO.savingsMult;
  else if (s.savings.mode === 'accounts') (s.assets || []).forEach(a => { if (+a.contribution > 0) a.contribution = (+a.contribution || 0) * SCENARIO.savingsMult; });
  else s.savings.annualSavings = (+s.savings.annualSavings || 0) * SCENARIO.savingsMult;
  s.assumptions.preReturn = (+s.assumptions.preReturn || 0) + SCENARIO.returnDelta;
  s.assumptions.postReturn = (+s.assumptions.postReturn || 0) + SCENARIO.returnDelta;
  s.expenses.retirementExpensePct = (+s.expenses.retirementExpensePct || 0) + SCENARIO.spendDelta;
  s.income.ssClient = (+s.income.ssClient || 0) * (1 + SCENARIO.ssDelta / 100);
  s.income.ssSpouse = (+s.income.ssSpouse || 0) * (1 + SCENARIO.ssDelta / 100);
  s.insurance.lifeClient = (+s.insurance.lifeClient || 0) * SCENARIO.insuranceMult;   // add / reduce life insurance
  s.insurance.lifeSpouse = (+s.insurance.lifeSpouse || 0) * SCENARIO.insuranceMult;
  if (SCENARIO.ltcCoverage > 0) (s.events || []).forEach(e => { if (e.type === 'ltc') e.amount = (+e.amount || 0) * (1 - SCENARIO.ltcCoverage / 100); });   // add LTC coverage
  return s;
}
let SURVIVOR = { on: false, who: 'spouse', atAge: 0 };   /* ephemeral Decision-Center survivor what-if */
function debtReadout() {
  const R = RESULTS, ds = STATE.debtStrategy || {};
  const totalDebtNow = (STATE.liabilities || []).reduce((s, l) => s + (+l.balance || 0), 0);
  if (totalDebtNow <= 0) return '<p class="i-action" style="margin-top:.5rem;color:var(--muted)">No liabilities entered — add debts on the Client Profile to model payoff.</p>';
  const freeRow = R.rows.find(r => r.debt <= 1), freeAge = freeRow ? freeRow.age : null;
  let html = `<p class="i-action" style="margin-top:.5rem">Total debt today <b>${fmt$(totalDebtNow)}</b> · ${freeAge ? `debt-free at <b>age ${freeAge}</b>` : 'not fully repaid within the plan'}.</p>`;
  if (ds.on && (+ds.extra || 0) > 0) {
    const off = compute(Object.assign({}, STATE, { debtStrategy: Object.assign({}, ds, { on: false }) }));
    const offFree = (off.rows.find(r => r.debt <= 1) || {}).age, dEnd = R.endingBalance - off.endingBalance;
    if (offFree && freeAge && offFree > freeAge) html += `<p class="i-action">→ Debt-free <b>${offFree - freeAge} yr${offFree - freeAge > 1 ? 's' : ''} sooner</b> than minimum payments; ending portfolio <b>${dEnd >= 0 ? '+' : '−'}${fmt$(Math.abs(dEnd))}</b>.</p>`;
    else html += `<p class="i-action">→ Accelerator active — extra payments applied in ${ds.method === 'snowball' ? 'snowball' : 'avalanche'} order.</p>`;
  }
  return html;
}
function survivorControls() {
  if (!STATE.household.spouse.included) return '';
  const c = STATE.household.client, sp = STATE.household.spouse;
  if (!SURVIVOR.atAge) SURVIVOR.atAge = (SURVIVOR.who === 'client' ? (+c.age || 55) : (+sp.age || 55)) + 15;
  return `<div class="switch-row"><label>Model an early death</label>
      <button class="switch" role="switch" aria-checked="${SURVIVOR.on}" data-surv-toggle></button></div>
    <div class="field-row">
      <div class="field"><label>Who passes</label><select data-surv="who" data-vtype="text"><option value="spouse" ${SURVIVOR.who === 'spouse' ? 'selected' : ''}>Spouse</option><option value="client" ${SURVIVOR.who === 'client' ? 'selected' : ''}>Client</option></select></div>
      <div class="field"><label>At age</label><input type="number" min="0" data-surv="atAge" value="${+SURVIVOR.atAge || 0}"></div>
    </div>`;
}
function survivorReadout() {
  if (!STATE.household.spouse.included) return '<p class="view-sub" style="margin:.4rem 0 0">Include a spouse/partner on the Client Profile to model a survivor scenario.</p>';
  if (!SURVIVOR.on) return '<p class="view-sub" style="margin:.4rem 0 0">Toggle on to model an early death — the survivor keeps the larger Social Security benefit, files as single, expenses adjust, and any life insurance pays out.</p>';
  const base = RESULTS, sv = compute(Object.assign({}, STATE, { survivor: { on: true, who: SURVIVOR.who, atAge: +SURVIVOR.atAge || 0 } }));
  const lastsB = base.depletionAge != null ? base.depletionAge : base.life + 1, lastsS = sv.depletionAge != null ? sv.depletionAge : sv.life + 1;
  const ageFmt = v => v > base.life ? `${base.life}+` : `age ${Math.round(v)}`;
  return `<table class="tbl" style="margin-top:.6rem"><thead><tr><th style="text-align:left">Metric</th><th>Current</th><th>Survivor</th><th>Change</th></tr></thead><tbody>
      ${cmpRow('Portfolio lasts to', lastsB, lastsS, ageFmt)}
      ${cmpRow('Ending balance (age ' + base.life + ')', base.endingBalance, sv.endingBalance, fmt$)}
      ${cmpRow('Lifetime taxes', base.lifetimeTax, sv.lifetimeTax, fmt$, false)}
    </tbody></table>
    <p class="rp-disclaimer" style="margin-top:.4rem">Assumes the ${SURVIVOR.who === 'client' ? 'client' : 'spouse'} passes at age ${+SURVIVOR.atAge || 0}: survivor spending set to ~75% of current, the larger Social Security benefit continues, filing becomes single, and entered life insurance is paid to the survivor.</p>`;
}
let DISABILITY = { on: false, who: 'client', atAge: 0, benefitPct: 60 };   /* ephemeral Decision-Center disability what-if */
function disabilityControls() {
  const c = STATE.household.client, sp = STATE.household.spouse;
  if (!DISABILITY.atAge) DISABILITY.atAge = (DISABILITY.who === 'spouse' ? (+sp.age || 45) : (+c.age || 45)) + 5;
  return `<div class="switch-row"><label>Model a disability</label>
      <button class="switch" role="switch" aria-checked="${DISABILITY.on}" data-dis-toggle></button></div>
    <div class="field-row three">
      <div class="field"><label>Who</label><select data-dis="who" data-vtype="text"><option value="client" ${DISABILITY.who === 'client' ? 'selected' : ''}>Client</option>${sp.included ? `<option value="spouse" ${DISABILITY.who === 'spouse' ? 'selected' : ''}>Spouse</option>` : ''}</select></div>
      <div class="field"><label>At age</label><input type="number" min="0" data-dis="atAge" value="${+DISABILITY.atAge || 0}"></div>
      <div class="field"><label>Income replaced</label><div class="control has-suffix"><input type="number" min="0" max="100" data-dis="benefitPct" value="${+DISABILITY.benefitPct || 0}"><span class="suffix">%</span></div></div>
    </div>`;
}
function disabilityReadout() {
  if (!DISABILITY.on) return '<p class="view-sub" style="margin:.4rem 0 0">Toggle on to model a disability before retirement — earned income stops and is replaced at the chosen level until retirement age.</p>';
  const base = RESULTS, dv = compute(Object.assign({}, STATE, { disability: { on: true, who: DISABILITY.who, atAge: +DISABILITY.atAge || 0, benefitPct: +DISABILITY.benefitPct || 0 } }));
  const lastsB = base.depletionAge != null ? base.depletionAge : base.life + 1, lastsD = dv.depletionAge != null ? dv.depletionAge : dv.life + 1;
  const ageFmt = v => v > base.life ? `${base.life}+` : `age ${Math.round(v)}`;
  return `<table class="tbl" style="margin-top:.6rem"><thead><tr><th style="text-align:left">Metric</th><th>Current</th><th>Disability</th><th>Change</th></tr></thead><tbody>
      ${cmpRow('Portfolio lasts to', lastsB, lastsD, ageFmt)}
      ${cmpRow('Ending balance (age ' + base.life + ')', base.endingBalance, dv.endingBalance, fmt$)}
    </tbody></table>
    <p class="rp-disclaimer" style="margin-top:.4rem">Assumes the ${DISABILITY.who} is disabled at age ${+DISABILITY.atAge || 0}: earned income stops and ${+DISABILITY.benefitPct || 0}% of salary is replaced (disability insurance) until retirement age.</p>`;
}
function buildDecision() {
  const addBtns = `<div class="btn-row" style="margin-top:.6rem">
    <button class="btn sm" data-action="add-event" data-type="child">＋ Child</button>
    <button class="btn sm" data-action="add-event" data-type="college">＋ College</button>
    <button class="btn sm" data-action="add-event" data-type="windfall">＋ Inheritance</button>
    <button class="btn sm" data-action="add-event" data-type="expense">＋ Major purchase</button>
    <button class="btn sm" data-action="add-event" data-type="income">＋ Extra income</button>
    <button class="btn sm" data-action="add-event" data-type="ltc">＋ Long-term care</button>
    <button class="btn sm" data-action="add-event" data-type="downturn">＋ Market downturn</button>
    <button class="btn sm" data-action="add-event" data-type="mortgagePayoff">＋ Pay off mortgage</button>
    <button class="btn sm" data-action="add-event" data-type="sellAsset">＋ Sell / downsize</button>
    <button class="btn sm" data-action="add-event" data-type="annuity">＋ Income annuity</button></div>`;
  getViewEl('decision').innerHTML = headBlock('Advanced', 'Decision Center',
    'Model life events and what-ifs live with your client. Add an event or move a lever and watch the plan respond — built for interactive, collaborative conversations.') +
    `<div class="panel pad" style="margin-bottom:1.1rem">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.7rem">
        <h3 style="font-family:var(--ff);font-size:1.3rem;font-weight:600">What-If Levers</h3>
        <button class="btn ghost sm" data-action="reset-scenario">↺ Reset levers</button></div>
      <div class="grid cols-3">
        ${slider('retireDelta', 'Retirement age', -5, 5, 1)}
        ${slider('savingsMult', 'Monthly savings', 0.5, 2, 0.05)}
        ${slider('returnDelta', 'Investment return', -2, 2, 0.1)}
        ${slider('spendDelta', 'Retirement spending', -20, 20, 1)}
        ${slider('ssDelta', 'Social Security benefit', -30, 30, 5)}
        ${slider('insuranceMult', 'Life insurance', 0, 3, 0.25)}
        ${slider('ltcCoverage', 'LTC coverage', 0, 100, 10)}
      </div></div>
    ${panel('Techniques', `
      <div class="section-label" style="margin-top:0">Debt payoff — accelerate or refinance</div>
      ${toggleField('debtStrategy.on', 'Redirect extra cash to debt')}
      ${fieldRow({ path: 'debtStrategy.extra', label: 'Extra payment', type: 'currency', suffix: '/mo' }, { path: 'debtStrategy.method', label: 'Payoff order', type: 'select', options: [{ value: 'avalanche', label: 'Avalanche — highest rate first' }, { value: 'snowball', label: 'Snowball — smallest balance first' }] })}
      <div id="res-debt"></div>
      <div class="section-label">Charitable — qualified charitable distribution</div>
      ${toggleField('charitableStrategy.on', 'Give RMDs directly to charity (QCD, tax-free)')}
      ${fieldRow({ path: 'charitableStrategy.qcd', label: 'Annual QCD', type: 'currency', suffix: '/yr' }, { path: 'pensionElection.survivorPct', label: 'Pension election', type: 'select', options: [{ value: '0', label: 'Single life — highest payment' }, { value: '50', label: '50% joint & survivor' }, { value: '75', label: '75% joint & survivor' }, { value: '100', label: '100% joint & survivor' }] })}
      <div class="section-label">Survivor — death of a spouse</div>
      ${survivorControls() || '<p class="view-sub" style="margin:.2rem 0 0">Include a spouse on the Client Profile to model this.</p>'}
      <div id="res-survivor"></div>
      <div class="section-label">Disability — loss of earned income</div>
      ${disabilityControls()}
      <div id="res-disability"></div>`, { sub: 'Strategy levers', hideKey: 'dec-tech', cls: 'advisor-only' })}
    <div style="height:1.1rem"></div>
    <div id="res-decision"></div>
    <div style="height:1.1rem"></div>
    ${panel('Sequence-of-Returns Risk', `<p class="view-sub" style="margin-top:0;margin-bottom:.7rem">Two portfolios earning the <b>same average return</b> can end up worlds apart if a bad year lands at the wrong time — the danger is greatest just as withdrawals begin. Drop a down year anywhere on the timeline and show the client what the <b>order</b> of returns does.</p>
      <div id="seq-controls">${seqControlsHTML()}</div>
      <div id="res-seqrisk">${seqResultsHTML()}</div>`, { sub: 'When a loss lands', hideKey: 'dec-seq' })}
    <div style="height:1.1rem"></div>
    <div class="advisor-only">${panel('Life Events', `<p class="view-sub" style="margin-top:0;margin-bottom:.6rem">Events are built into the plan and flow through every projection, chart, and the cash-flow timeline.</p>
      <div id="eventsList">${(STATE.events || []).map(eventRow).join('')}</div>${addBtns}`, { sub: 'Planned' })}</div>`;
}
function cmpRow(label, b, a, fmt, higherBetter = true) {
  const diff = a - b, improved = higherBetter ? diff > 0 : diff < 0;
  const same = Math.abs(diff) < 1e-6;
  return `<tr><td style="text-align:left">${label}</td><td class="amount">${fmt(b)}</td><td class="amount">${fmt(a)}</td>
    <td class="delta ${same ? '' : improved ? 'up' : 'down'}">${same ? '—' : (diff > 0 ? '▲' : '▼') + ' ' + fmt(Math.abs(diff))}</td></tr>`;
}
function liveDecision() {
  const base = RESULTS, alt = compute(applyScenario(STATE)), el = $('#res-decision'); if (!el) return;
  const xMax = Math.max(base.endAge, alt.endAge);
  const lastsB = base.depletionAge != null ? base.depletionAge : base.life + 1;
  const lastsA = alt.depletionAge != null ? alt.depletionAge : alt.life + 1;
  const ageFmt = v => v > base.life ? `${base.life}+` : `age ${Math.round(v)}`;
  el.innerHTML =
    panel('Scenario vs. Current Plan',
      lineChart([
        { name: 'Current', color: 'var(--ink)', points: base.rows.map(r => ({ x: r.age, y: r.end })) },
        { name: 'Scenario', color: 'var(--gold)', dash: true, points: alt.rows.map(r => ({ x: r.age, y: r.end })) }
      ], { xMax, markers: [{ x: base.retAge, label: 'Now ' + base.retAge }] }) +
      `<div class="legend"><span><i class="dot" style="background:var(--ink)"></i>Current plan</span><span><i class="dot" style="background:var(--gold)"></i>Scenario</span></div>
      <table class="tbl" style="margin-top:1rem"><thead><tr><th style="text-align:left">Metric</th><th>Current</th><th>Scenario</th><th>Change</th></tr></thead><tbody>
        ${cmpRow('Retirement funded', base.fundedRatio, alt.fundedRatio, v => pct(v * 100, 0))}
        ${cmpRow('Surplus / (gap) at retire', base.surplus, alt.surplus, fmt$)}
        ${cmpRow('Portfolio lasts to', lastsB, lastsA, ageFmt)}
        ${cmpRow('Ending balance (age ' + base.life + ')', base.endingBalance, alt.endingBalance, fmt$)}
        ${cmpRow('Annual savings', base.annualSavings, alt.annualSavings, fmt$)}
      </tbody></table>`, { sub: 'Live what-if' })
    + `<div style="height:1.1rem"></div>` + ssOptimizerPanel();
  const dEl = $('#res-debt'); if (dEl) dEl.innerHTML = debtReadout();
  const sEl = $('#res-survivor'); if (sEl) sEl.innerHTML = survivorReadout();
  const xEl = $('#res-disability'); if (xEl) xEl.innerHTML = disabilityReadout();
}
function ssOptimizerBlock(name, key, pia, curAge, life, claimNow, cola) {
  if (!(pia > 0)) return '';
  const o = ssOptimize(pia, curAge, life, cola);
  const rows = o.rows.map(r => {
    const best = r.claim === o.best.claim;
    return `<tr class="${best ? 'ss-best' : ''}"><td style="text-align:left">${r.claim === 67 ? '67 · FRA' : 'Age ' + r.claim}${best ? '  ' + badge('Best', 'good') : ''}</td><td class="amount">${fmt$(r.annual)}</td><td class="amount">${fmtK(r.lifetime)}</td></tr>`;
  }).join('');
  return `<div style="margin-bottom:1.1rem">
    <div class="progress-label" style="margin-bottom:.45rem"><b>${escapeHtml(name)}</b><span>Plan currently claims at ${claimNow}</span></div>
    <table class="tbl"><thead><tr><th style="text-align:left">Claim age</th><th>Annual benefit</th><th>Lifetime total</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="i-action" style="margin-top:.45rem">Claiming at <b>age ${o.best.claim}</b> maximizes lifetime benefits through age ${life} (${fmt$(o.best.lifetime)}).
      ${claimNow != o.best.claim ? `<button class="btn sm advisor-only" data-action="apply-ss" data-key="${key}" data-age="${o.best.claim}">Apply age ${o.best.claim}</button>` : ''}</p></div>`;
}
function ssOptimizerPanel() {
  const I = STATE.income, c = STATE.household.client, sp = STATE.household.spouse, R = RESULTS, cola = STATE.assumptions.ssCola / 100;
  const spAgeNow = +sp.age || R.curAge;
  const body = ssOptimizerBlock(c.name || 'Client', 'ssClaimClient', +I.ssClient || 0, R.curAge, R.life, +I.ssClaimClient || 67, cola)
    + (R.spOn ? ssOptimizerBlock(sp.name || 'Spouse', 'ssClaimSpouse', +I.ssSpouse || 0, spAgeNow, +sp.lifeExpectancy || R.life, +I.ssClaimSpouse || 67, cola) : '');
  return panel('Social Security Timing', (body || '<div class="empty">Enter a Social Security benefit on the Client Profile to compare claiming ages.</div>') +
    `<p class="rp-disclaimer" style="margin-top:.4rem">Benefits estimated from the entered full-retirement-age (67) amount: roughly 70% at 62 and 124% at 70, grown by ${pct(STATE.assumptions.ssCola, 1)} COLA. Lifetime totals assume benefits through life expectancy; the optimal age depends on longevity, taxes, and spousal strategy — confirm with the client. The plan projection applies these same claiming-age factors.</p>`,
    { sub: 'Claiming strategy', hideKey: 'dec-ss' });
}

/* ------------------ Sequence-of-returns risk (Decision Center) ------------- */
let SEQ = null;                                                        // ephemeral what-if, seeded from the plan
function seqDefaults() {
  const R = RESULTS, A = STATE.assumptions, c = STATE.household.client;
  const retAge = Math.round(+c.retireAge || R.retAge || 65);
  const life = Math.round(+c.lifeExpectancy || R.life || 92);
  const raw = Math.max(5, Math.min(40, (life - retAge) || 30));
  const years = [10, 15, 20, 25, 30, 35, 40].reduce((a, o) => Math.abs(o - raw) < Math.abs(a - raw) ? o : a, 25);   // snap to a dropdown option
  const start = Math.max(0, Math.round((R.investable || 500000) / 1000) * 1000);
  const wd = Math.max(0, Math.round(start * 0.04 / 1000) * 1000);      // 4% first-year draw, editable
  return { _planId: currentPlanId, startAge: retAge, years, start, wd, avg: +A.postReturn || 5, infl: +A.inflation || 2.5, severity: -20, holdAvg: true, downYears: [1] };
}
function seqEnsure() {
  if (!SEQ || SEQ._planId !== currentPlanId) SEQ = seqDefaults();
  SEQ.downYears = (SEQ.downYears || []).filter(y => y >= 1 && y <= SEQ.years);
  return SEQ;
}
function seqSim(s, downYears) {
  const A = s.avg / 100, d = s.severity / 100, infl = s.infl / 100, N = s.years, down = new Set(downYears);
  let other = A;                                                       // return in the non-down years
  if (s.holdAvg && down.size < N) other = (N * A - down.size * d) / (N - down.size);   // solved so the arithmetic average stays A
  const run = returns => {
    let bal = s.start, depAge = null; const path = [{ x: s.startAge, y: bal }];
    for (let i = 1; i <= N; i++) {
      const w = s.wd * Math.pow(1 + infl, i - 1);                      // inflation-adjusted withdrawal, taken at the start of the year
      bal = Math.max(0, (bal - w) * (1 + returns[i - 1]));
      if (bal <= 0 && depAge == null) depAge = s.startAge + i;
      path.push({ x: s.startAge + i, y: bal });
    }
    return { path, ending: bal, depAge, avg: returns.reduce((a, b) => a + b, 0) / N * 100 };
  };
  const baseR = [], scenR = [];
  for (let i = 1; i <= N; i++) { baseR.push(A); scenR.push(down.has(i) ? d : (s.holdAvg ? other : A)); }
  return { base: run(baseR), scen: run(scenR), other: other * 100 };
}
const seqAgeFmt = (v, endAge) => v >= endAge ? `${endAge}+` : `age ${Math.round(v)}`;
function seqPlacement(s) {
  const y = (s.downYears || []).slice().sort((a, b) => a - b);
  if (!y.length) return 'no down year';
  if (y.length === 1) return `a ${s.severity}% year in year ${y[0]}`;
  if (y.length === 2) return `${s.severity}% years in years ${y[0]} & ${y[1]}`;
  return `${s.severity}% years (${y.length} of them)`;
}
function seqControlsHTML() {
  const s = seqEnsure();
  const sevOpts = [[-10, '−10% · mild dip'], [-20, '−20% · bear market'], [-35, '−35% · severe (2008)'], [-50, '−50% · crash']];
  const yearOpts = [10, 15, 20, 25, 30, 35, 40].map(v => `<option value="${v}" ${s.years === v ? 'selected' : ''}>${v} years</option>`).join('');
  const chips = Array.from({ length: s.years }, (_, i) => i + 1).map(y =>
    `<button class="seq-chip ${s.downYears.includes(y) ? 'on' : ''}" data-action="seq-year" data-y="${y}" title="Toggle a market drop in year ${y}">${y}</button>`).join('');
  return `<div class="grid cols-4" style="margin-bottom:.5rem">
      <div class="field"><label>Starting portfolio</label><div class="control has-prefix"><span class="prefix">$</span><input type="text" inputmode="decimal" data-money data-seq="start" value="${moneyDisplay(s.start)}"></div></div>
      <div class="field"><label>Annual withdrawal <span class="lbl-note">grows with inflation</span></label><div class="control has-prefix has-suffix"><span class="prefix">$</span><input type="text" inputmode="decimal" data-money data-seq="wd" value="${moneyDisplay(s.wd)}"><span class="suffix">/yr</span></div></div>
      <div class="field"><label>Average return</label><div class="control has-suffix"><input type="number" step="0.1" data-seq="avg" value="${s.avg}"><span class="suffix">%</span></div></div>
      <div class="field"><label>Years in retirement</label><select data-seq="years">${yearOpts}</select></div>
    </div>
    <div class="grid cols-2" style="margin-bottom:.6rem;align-items:end">
      <div class="field"><label>How bad is the down year?</label><select data-seq="severity">${sevOpts.map(o => `<option value="${o[0]}" ${s.severity === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select></div>
      <button class="seq-toggle ${s.holdAvg ? 'on' : ''}" data-action="seq-holdavg" role="switch" aria-checked="${s.holdAvg}"><span class="seq-knob"></span><span>Keep the <b>average return identical</b> — offset the down year with slightly stronger years, isolating pure timing</span></button>
    </div>
    <div class="seq-picklab">Click the year(s) the market drops: <button class="btn ghost sm" data-action="seq-reset" style="margin-left:.4rem;padding:.1rem .5rem">↺ Reset to plan</button></div>
    <div class="seq-chips" id="seq-chips">${chips}</div>`;
}
function seqResultsHTML() {
  const s = seqEnsure();
  if (!(s.start > 0)) return '<div class="empty">Enter a starting portfolio to model sequence risk.</div>';
  const sim = seqSim(s, s.downYears), b = sim.base, c = sim.scen, endAge = s.startAge + s.years;
  const diff = b.ending - c.ending;
  const markers = (s.downYears || []).slice(0, 3).map(y => ({ x: s.startAge + y, label: '▼' }));
  const chart = lineChart([
    { name: 'Steady', color: 'var(--ink)', points: b.path },
    { name: 'Shock', color: 'var(--danger, #c0392b)', dash: true, points: c.path }
  ], { markers, xticks: Math.min(8, s.years) });
  // headline insight
  let insight;
  if (!s.downYears.length) insight = 'Pick a year above to drop the market and watch what happens.';
  else {
    let clause = '';
    if (c.depAge && !b.depAge) clause = ` and <b>drains the portfolio by ${seqAgeFmt(c.depAge, endAge)}</b> — money that otherwise lasted the full ${s.years} years`;
    else if (c.depAge && b.depAge && c.depAge < b.depAge) clause = ` and empties it <b>${b.depAge - c.depAge} year${b.depAge - c.depAge === 1 ? '' : 's'} sooner</b>`;
    else clause = ` — <b>${fmt$(Math.abs(diff))} ${diff >= 0 ? 'less' : 'more'}</b> at ${seqAgeFmt(endAge, endAge)}`;
    insight = `${s.holdAvg ? 'Same <b>' + pct(s.avg, 1) + ' average return</b> either way' : 'Assuming ' + pct(s.avg, 1) + ' in every other year'} — but ${seqPlacement(s)}${clause}.`;
  }
  const otherNote = (s.holdAvg && s.downYears.length && s.downYears.length < s.years)
    ? `<p class="seq-note">To hold the ${pct(s.avg, 1)} average, the other years earn <b>${pct(sim.other, 1)}</b> each. ${sim.other > 25 ? '⚠ That’s unrealistically high — try fewer or milder down years.' : ''}</p>` : '';
  // timing table: the SAME single down year placed early / mid / late (average held constant)
  let timing = '';
  if (s.wd > 0 && s.years >= 4) {
    const held = Object.assign({}, s, { holdAvg: true });
    const spots = [{ y: 1, k: 'Early (year 1)' }, { y: Math.round(s.years / 2), k: `Midway (year ${Math.round(s.years / 2)})` }, { y: s.years, k: `Late (year ${s.years})` }];
    const rows = spots.map(sp => { const r = seqSim(held, [sp.y]).scen; return `<tr><td style="text-align:left">${sp.k}</td><td class="amount">${fmt$(r.ending)}</td><td class="amount">${r.depAge ? seqAgeFmt(r.depAge, endAge) : `${endAge}+`}</td></tr>`; }).join('');
    timing = `<div class="section-label">Same down year, same average — only the timing moves</div>
      <table class="tbl"><thead><tr><th style="text-align:left">${s.severity}% year lands…</th><th>Ending at ${seqAgeFmt(endAge, endAge)}</th><th>Lasts to</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="seq-note">Identical average return in all three — an early loss hurts most because it comes out of the largest balance while withdrawals are still being taken.</p>`;
  }
  return `<div class="seq-insight">${insight}</div>
    ${chart}
    <div class="legend"><span><i class="dot" style="background:var(--ink)"></i>Steady ${pct(s.avg, 1)} every year</span><span><i class="dot" style="background:var(--danger,#c0392b)"></i>With the down year(s)</span>${markers.length ? '<span>▼ down year</span>' : ''}</div>
    <table class="tbl" style="margin-top:1rem"><thead><tr><th style="text-align:left">Metric</th><th>Steady</th><th>With down year</th><th>Difference</th></tr></thead><tbody>
      ${cmpRow('Average annual return', b.avg, c.avg, v => pct(v, 1))}
      ${cmpRow('Ending balance at ' + seqAgeFmt(endAge, endAge), b.ending, c.ending, fmt$)}
      ${(() => { const lb = b.depAge || endAge, lc = c.depAge || endAge, gap = Math.round(lb - lc);
        return `<tr><td style="text-align:left">Portfolio lasts to</td><td class="amount">${seqAgeFmt(lb, endAge)}</td><td class="amount">${seqAgeFmt(lc, endAge)}</td><td class="delta ${gap > 0 ? 'down' : ''}">${gap > 0 ? '▼ ' + gap + ' yr' + (gap === 1 ? '' : 's') + ' sooner' : '—'}</td></tr>`; })()}
    </tbody></table>${otherNote}${timing}
    <p class="rp-disclaimer" style="margin-top:.5rem">A teaching illustration, not a projection: withdrawals are taken at the start of each year and grown with inflation; every non-down year earns the same return. Real markets move every year — this isolates the effect of <b>when</b> a loss lands.</p>`;
}
function renderSeqControls() { const el = $('#seq-controls'); if (el) el.innerHTML = seqControlsHTML(); }
function renderSeqResults() { const el = $('#res-seqrisk'); if (el) el.innerHTML = seqResultsHTML(); }
function renderSeqRisk() { renderSeqControls(); renderSeqResults(); }

/* ----------------------------- COPLANNER ---------------------------------- */
function renderCoplanner() {
  const R = RESULTS, ins = buildInsights(R), score = readinessScore(R);
  const band = score >= 75 ? ['Strong', 'good'] : score >= 50 ? ['Developing', 'warn'] : ['Needs attention', 'bad'];
  getViewEl('coplanner').innerHTML = headBlock('Accelerate', 'CoPlanner',
    'Automated insights that turn client data into ready-to-use planning actions — so you plan faster and lead the conversation.') +
    `<div class="split" style="grid-template-columns:300px 1fr;align-items:start">
      <div>${panel('Plan Readiness', `<div style="text-align:center">${gauge(score)}<div style="margin-top:.4rem">${badge(band[0], band[1])}</div></div>
        <div class="section-label">Key metrics</div>
        ${miniMetric('Retirement funded', pct(R.fundedRatio * 100, 0), tone(R.fundedRatio))}
        ${miniMetric('Savings rate', pct(R.savingsRate * 100, 0), R.savingsRate >= 0.15 ? 'good' : R.savingsRate >= 0.1 ? 'warn' : 'bad')}
        ${miniMetric('Emergency fund', R.emergencyMonths.toFixed(1) + ' mo', R.emergencyMonths >= 6 ? 'good' : R.emergencyMonths >= 3 ? 'warn' : 'bad')}
        ${miniMetric('Protection', R.protGap > 0 ? 'Gap ' + fmtK(R.protGap) : 'Covered', R.protGap > 0 ? 'warn' : 'good')}`, { hideKey: 'cop-score' })}</div>
      <div>${panel('Insights & Actions', ins.map(insightHTML).join('') || '<div class="empty">Enter client data to generate insights.</div>', { hideKey: 'cop-insights', headExtra: badge(ins.length + ' findings', 'ink') })}</div>
    </div>`;
}
function miniMetric(label, val, t) {
  return `<div style="display:flex;justify-content:space-between;align-items:center;padding:.4rem 0;border-bottom:1px solid var(--line)">
    <span style="font-size:.84rem;color:var(--muted)">${escapeHtml(label)}</span><b class="amount val-${t}">${val}</b></div>`;
}

/* ----------------------------- TAX PLANNING ------------------------------- */
function taxBracketBar(income, brackets) {
  let idx = 0; for (let i = 0; i < brackets.length; i++) if (income >= brackets[i][0]) idx = i;
  const showTop = idx + 1 < brackets.length ? brackets[idx + 1][0] * 1.05 : Math.max(income * 1.3, 1);
  const W = 760, H = 118, x0 = 10, x1 = W - 10, top = 60, barH = 30;
  const sc = v => x0 + Math.min(v, showTop) / showTop * (x1 - x0);
  const colors = ['#e1ebe4', '#d2e1d7', '#efddb8', '#e7cf9c', '#dcb67d', '#cea05a', '#b58236'];
  let segs = '', ticks = '';
  for (let i = 0; i < brackets.length; i++) {
    const lo = brackets[i][0], hi = i + 1 < brackets.length ? brackets[i + 1][0] : showTop;
    if (lo >= showTop) break;
    const a = sc(lo), b = sc(hi), w = b - a, cur = i === idx;
    segs += `<rect x="${a.toFixed(1)}" y="${top}" width="${w.toFixed(1)}" height="${barH}" rx="2" fill="${colors[i]}"${cur ? ' stroke="var(--gold-deep)" stroke-width="1.6"' : ''}/>`;
    if (w > 24) segs += `<text x="${(a + w / 2).toFixed(1)}" y="${top + barH / 2 + 4}" text-anchor="middle" style="font-size:11px;font-weight:700;fill:var(--ink-2)">${Math.round(brackets[i][1] * 100)}%</text>`;
    if (i > 0) ticks += `<text x="${a.toFixed(1)}" y="${top + barH + 16}" text-anchor="middle" class="lbl">${fmtK(lo)}</text>`;
  }
  const fx = sc(income), cx = clamp(fx, 70, W - 70);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}">${segs}
    <rect x="${x0}" y="${top}" width="${(fx - x0).toFixed(1)}" height="${barH}" rx="2" fill="rgba(15,26,43,.13)"/>
    <line x1="${fx.toFixed(1)}" y1="${top - 8}" x2="${fx.toFixed(1)}" y2="${top + barH + 6}" stroke="var(--ink)" stroke-width="2"/>
    <circle cx="${fx.toFixed(1)}" cy="${top - 8}" r="3.5" fill="var(--ink)"/>
    <text x="${cx.toFixed(1)}" y="${top - 30}" text-anchor="middle" style="font-size:10px;letter-spacing:.06em;font-weight:700;fill:var(--gold-deep)">YOUR TAXABLE INCOME</text>
    <text x="${cx.toFixed(1)}" y="${top - 15}" text-anchor="middle" class="amount" style="font-size:14px;font-weight:700;fill:var(--ink)">${fmt$(income)}</text>${ticks}</svg>`;
}
const WD_NAMES = { taxable: 'Taxable / brokerage', traditional: 'Tax-deferred · 401(k)/IRA', roth: 'Roth · tax-free' };
function withdrawalOrderControls() {
  const ws = STATE.withdrawalStrategy || {}, mode = ws.mode === 'proportional' ? 'proportional' : 'sequential';
  const order = (ws.order && ws.order.length === 3) ? ws.order : ['taxable', 'traditional', 'roth'];
  const list = order.map((k, i) => `<div class="wd-item">
      <span class="wd-pos">${i + 1}</span><span class="wd-name">${WD_NAMES[k]}</span>
      <span class="wd-move">
        <button class="wd-btn" data-action="wd-move" data-key="${k}" data-dir="-1" ${i === 0 ? 'disabled' : ''} title="Draw earlier" aria-label="Move ${WD_NAMES[k]} earlier">▲</button>
        <button class="wd-btn" data-action="wd-move" data-key="${k}" data-dir="1" ${i === 2 ? 'disabled' : ''} title="Draw later" aria-label="Move ${WD_NAMES[k]} later">▼</button>
      </span></div>`).join('');
  return field({ path: 'withdrawalStrategy.mode', label: 'Drawdown method', type: 'select', options: [{ value: 'sequential', label: 'In order — deplete one, then the next' }, { value: 'proportional', label: 'Proportional — pro-rata across all' }] })
    + (mode === 'sequential'
      ? `<div class="section-label">Draw from accounts in this order</div><div class="wd-list">${list}</div>`
      : `<p class="budget-note" style="margin-top:.4rem">Each year's income is drawn pro-rata across taxable, tax-deferred and Roth in proportion to their balances.</p>`)
    + `<p class="budget-note">Required minimum distributions always come out of tax-deferred first; this order then funds the <b>remaining</b> income need.</p>`;
}
function withdrawalReadout(R) {
  const ws = STATE.withdrawalStrategy || {}, mode = ws.mode === 'proportional' ? 'proportional' : 'sequential';
  const ret = R.rows.filter(r => r.age >= R.retAge);
  const depAge = key => { const hit = ret.find(r => (r[key] || 0) < 1 && (ret[0] && (ret[0][key] || 0) > 1)); return hit ? hit.age : null; };
  const buckets = [['bTax', 'Taxable / brokerage', 'taxable'], ['bDef', 'Tax-deferred · 401(k)/IRA', 'traditional'], ['bRoth', 'Roth · tax-free', 'roth']];
  const order = (ws.order && ws.order.length === 3) ? ws.order : ['taxable', 'traditional', 'roth'];
  const rows = buckets.sort((a, b) => order.indexOf(a[2]) - order.indexOf(b[2])).map(([k, label]) => {
    const d = depAge(k), start = ret[0] ? ret[0][k] || 0 : 0;
    return `<div class="cf-bd-row"><span><i class="dot" style="background:${k === 'bTax' ? 'var(--gold)' : k === 'bDef' ? 'var(--ink)' : 'var(--gold-deep)'}"></i>${label}</span><b class="amount">${start < 1 ? 'empty' : d ? 'depletes ~age ' + d : 'lasts the plan'}</b></div>`;
  }).join('');
  return panel('Drawdown Sequence', `
    <p class="i-action" style="margin-top:0">${mode === 'proportional' ? 'Income is drawn pro-rata across all accounts each year.' : 'Income draws from <b>' + WD_NAMES[order[0]] + '</b> first; as each account empties, the plan automatically rolls to the next.'}</p>
    <div class="section-label">When each account is projected to deplete (in retirement)</div>
    ${rows}
    <p class="rp-disclaimer" style="margin-top:.4rem">Order changes which accounts are taxed when, so lifetime taxes and how long the portfolio lasts can shift. RMDs still come from tax-deferred first.</p>`, { hideKey: 'tax-wd', sub: 'Income sequencing' });
}
function buildTax() {
  const rothControls =
    toggleField('rothStrategy.on', 'Apply Roth conversion strategy to the plan') +
    fieldRow(
      { path: 'rothStrategy.mode', label: 'Method', type: 'select', options: [{ value: 'fill', label: 'Fill up to a bracket' }, { value: 'amount', label: 'Fixed amount / year' }] },
      { path: 'rothStrategy.toRate', label: 'Target bracket', type: 'select', options: [{ value: 0.12, label: '12%' }, { value: 0.22, label: '22%' }, { value: 0.24, label: '24%' }, { value: 0.32, label: '32%' }] }
    ) +
    fieldRow({ path: 'rothStrategy.startAge', label: 'Convert from age', type: 'age' }, { path: 'rothStrategy.endAge', label: 'through age', type: 'age' }) +
    field({ path: 'rothStrategy.amount', label: 'Amount / year (fixed mode)', type: 'currency' });
  const taxAssumptions =
    fieldRow(
      { path: 'household.filing', label: 'Filing status', type: 'select', options: [{ value: 'married', label: 'Married jointly' }, { value: 'single', label: 'Single' }, { value: 'hoh', label: 'Head of household' }] },
      { path: 'assumptions.stateTaxRate', label: 'State income tax', type: 'percent' }
    ) +
    fieldRow({ path: 'savingsSplit.pretax', label: 'Savings to pre-tax', type: 'percent' }, { path: 'savingsSplit.roth', label: 'to Roth', type: 'percent' }) +
    fieldRow({ path: 'income.ssClaimClient', label: 'SS claim age — client', type: 'age' }, STATE.household.spouse.included ? { path: 'income.ssClaimSpouse', label: 'SS claim — spouse', type: 'age' } : { path: 'assumptions.rmdStartAge', label: 'RMD start age', type: 'age' });
  getViewEl('tax').innerHTML = headBlock('Tax Strategy', 'Tax Planning',
    'See the tax impact of the plan in real time — current brackets, lifetime taxes, RMDs, and bracket-based Roth conversions. Estimates to guide the conversation and the client’s CPA.', collapseBtn()) +
    `<div class="split io-split"><div class="advisor-only io-inputs">
      ${panel('Tax Inputs', taxAssumptions, { sub: 'Drives every projection' })}
      ${panel('Roth Conversion Analyzer', rothControls, { sub: 'What-if' })}
      ${panel('Withdrawal Sequencing', withdrawalOrderControls(), { sub: 'Which account funds retirement income' })}
    </div><div id="res-tax"></div></div>`;
}
function liveTax() {
  const el = $('#res-tax'); if (!el) return;
  const R = RESULTS, A = STATE.assumptions, filing = filingOf(STATE.household.filing);
  const infl = A.inflation / 100, curYear = new Date().getFullYear();
  const inflFac0 = pow(1 + infl, Math.max(0, curYear - TAX.baseYear));
  const brackets0 = TAX.brackets[filing].map(([lo, r]) => [lo * inflFac0, r]);
  const now = R.taxNow || {};
  const ordTaxable = now.ordinaryTaxable || 0;
  let idx = 0; for (let i = 0; i < brackets0.length; i++) if (ordTaxable >= brackets0[i][0]) idx = i;
  const nextTop = idx + 1 < brackets0.length ? brackets0[idx + 1][0] : Infinity;
  const room = isFinite(nextTop) ? nextTop - ordTaxable : 0;
  const grossNow = (now.wages || 0) + (now.ss || 0) + (now.pension || 0) + (now.rmd || 0);
  // Roth comparison (always show the impact of the configured strategy)
  const offPlan = JSON.parse(JSON.stringify(STATE)); offPlan.rothStrategy = Object.assign({}, STATE.rothStrategy, { on: false });
  const onPlan = JSON.parse(JSON.stringify(STATE)); onPlan.rothStrategy = Object.assign({}, STATE.rothStrategy, { on: true });
  const baseSim = simulate(offPlan), stratSim = simulate(onPlan);
  const taxSaved = baseSim.lifetimeTax - stratSim.lifetimeTax;
  const endDelta = stratSim.endingBalance - baseSim.endingBalance;
  const convTotal = stratSim.rows.reduce((s, r) => s + (r.conversion || 0), 0);
  // lifetime + RMD series
  const taxSeries = { name: 'Annual taxes', color: 'var(--gold)', fill: 'var(--gold)', points: R.rows.map(r => ({ x: r.age, y: r.taxes })) };
  const rmdRows = R.rows.filter(r => r.rmd > 0);
  const rmdSeries = { name: 'RMD', color: 'var(--ink)', fill: 'var(--ink)', points: rmdRows.map(r => ({ x: r.age, y: r.rmd })) };

  el.innerHTML =
    `<div class="grid cols-4" style="margin-bottom:1rem">
      ${statCard('Tax This Year', fmt$(now.taxes || 0), { tone: 'warn', note: `${money(now.fed || 0)} fed · ${money(now.state || 0)} state · ${money(now.fica || 0)} FICA` })}
      ${statCard('Effective Rate', pct(grossNow > 0 ? (now.taxes / grossNow) * 100 : 0, 1), { raw: true, note: 'of gross income' })}
      ${statCard('Marginal Bracket', pct((now.marginal || 0) * 100, 0), { raw: true, valClass: 'val-gold', note: `${money(room)} room in bracket` })}
      ${statCard('Lifetime Taxes', fmtK(R.lifetimeTax), { tone: 'bad', note: 'projected total, all years' })}
    </div>
    ${panel('Federal Tax Bracket — This Year', taxBracketBar(ordTaxable, brackets0, now.marginal) +
      `<p class="i-action">You are in the <b>${pct((now.marginal || 0) * 100, 0)}</b> marginal bracket with about <b class="amount">${fmt$(room)}</b> of room before the next bracket — useful headroom for Roth conversions or realizing gains. <span class="advisor-flag" style="margin-left:.4rem">${STATE.household.filing} · ${curYear}</span></p>`, { hideKey: 'tax-bracket' })}
    <div style="height:1.1rem"></div>
    <div class="split" style="grid-template-columns:1fr 1fr;align-items:start">
      ${panel('Lifetime Tax Projection', lineChart([taxSeries], { markers: [{ x: R.retAge, label: 'Retire' }], h: 220 }) +
        `<div class="legend"><span><i class="dot" style="background:var(--gold)"></i>Annual taxes paid</span><span>Cumulative: <b class="amount">${fmt$(R.lifetimeTax)}</b></span></div>`, { hideKey: 'tax-life' })}
      ${panel('Required Minimum Distributions', rmdRows.length ? lineChart([rmdSeries], { h: 220 }) +
        `<p class="i-action">RMDs begin at age <b>${A.rmdStartAge}</b> from tax-deferred accounts — forced taxable income of about <b class="amount">${fmt$(rmdRows[0].rmd)}</b> in year one, rising with age.</p>`
        : '<div class="empty">No RMDs projected (limited tax-deferred balances).</div>', { hideKey: 'tax-rmd' })}
    </div>
    <div style="height:1.1rem"></div>
    ${panel('Roth Conversion Analyzer', `
      <p class="view-sub" style="margin-top:0">Converting tax-deferred dollars to Roth now — filling up the ${STATE.rothStrategy.mode === 'fill' ? pct(parseFloat(STATE.rothStrategy.toRate) * 100, 0) + ' bracket' : 'fixed amount'} from age ${STATE.rothStrategy.startAge}–${STATE.rothStrategy.endAge} — trades tax today for lower RMDs and tax-free growth later.</p>
      <div class="grid cols-3" style="margin:.9rem 0">
        ${statCard('Total Converted', fmtK(convTotal), { note: 'over the strategy window' })}
        ${statCard('Lifetime Tax Change', (taxSaved >= 0 ? '−' : '+') + fmtK(Math.abs(taxSaved)), { raw: true, tone: taxSaved >= 0 ? 'good' : 'bad', valClass: taxSaved >= 0 ? 'val-good' : 'val-bad', note: taxSaved >= 0 ? 'projected lifetime savings' : 'additional lifetime tax' })}
        ${statCard('Ending Estate Change', (endDelta >= 0 ? '+' : '−') + fmtK(Math.abs(endDelta)), { raw: true, tone: endDelta >= 0 ? 'good' : 'bad', valClass: endDelta >= 0 ? 'val-good' : 'val-bad', note: 'projected portfolio at plan end' })}
      </div>
      <p class="rp-disclaimer" style="font-size:.78rem">${STATE.rothStrategy.on ? '✓ This strategy is currently applied to the plan.' : 'Toggle “Apply to the plan” on the left to build this into the projection.'} Roth conversion suitability depends on future tax rates, IRMAA, state taxes, and estate goals — review with the client’s CPA.</p>
      `, { hideKey: 'tax-roth' })}
    <div style="height:1.1rem"></div>
    ${withdrawalReadout(R)}
    <p class="rp-disclaimer" style="margin-top:1rem">Tax figures are simplified estimates using ${curYear} federal brackets (inflated forward), a flat ${pct(A.stateTaxRate, 1)} state rate, and standard deductions. They exclude credits, AMT, NIIT, IRMAA, and many deductions. For tax preparation or advice, the client should consult their CPA.</p>`;
}

/* ----------------------------- view switching ----------------------------- */
/* ----------------------------- NEW CLIENT INTAKE -------------------------- */
const INTAKE_SECTIONS = ['ih-household', 'ih-income', 'ih-expenses', 'ih-assets', 'ih-liabilities', 'ih-insurance', 'ih-retirement', 'ih-tax', 'ih-estate', 'ih-goals'];
let intakeSeeded = false;
function buildIntake() {
  if (!intakeSeeded) { INTAKE_SECTIONS.forEach(id => OPEN_SECTIONS.add(id)); intakeSeeded = true; }   /* all sections open by default */
  const spOn = STATE.household.spouse.included;
  const filingOpts = [{ value: 'married', label: 'Married filing jointly' }, { value: 'single', label: 'Single' }, { value: 'hoh', label: 'Head of household' }];
  const body =
    collapsiblePanel('ih-household', '1 · Client & Household', `
      ${fieldRow({ path: 'household.client.name', label: 'Client name', type: 'text', ph: 'Full name' }, { path: 'household.client.age', label: 'Age', type: 'age' })}
      ${toggleField('household.spouse.included', 'Include spouse / partner', true)}
      ${spOn ? fieldRow({ path: 'household.spouse.name', label: 'Spouse name', type: 'text' }, { path: 'household.spouse.age', label: 'Age', type: 'age' }) : ''}`) +
    collapsiblePanel('ih-income', '2 · Income', `
      ${fieldRow({ path: 'income.clientSalary', label: 'Client salary', type: 'currency' }, spOn ? { path: 'income.spouseSalary', label: 'Spouse salary', type: 'currency' } : { path: 'income.otherIncome', label: 'Other income', type: 'currency' })}
      ${spOn ? fieldRow({ path: 'income.otherIncome', label: 'Other income', type: 'currency' }, { path: 'income.salaryGrowth', label: 'Salary growth', type: 'percent' }) : field({ path: 'income.salaryGrowth', label: 'Salary growth', type: 'percent' })}`) +
    collapsiblePanel('ih-expenses', '3 · Expenses & Savings', `
      ${expensesBlock()}
      <div class="block-divider"></div>
      ${savingsBlock()}`) +
    collapsiblePanel('ih-assets', '4 · Accounts & Assets', `<div id="assetsList">${(STATE.assets || []).map(assetRow).join('')}</div>
      <button class="add-row" data-action="add-asset">＋ Add account</button>`, { sub: 'Investable, education & property' }) +
    collapsiblePanel('ih-liabilities', '5 · Liabilities', `<div id="liabList">${(STATE.liabilities || []).map(liabRow).join('')}</div>
      <button class="add-row" data-action="add-liab">＋ Add liability</button>`) +
    collapsiblePanel('ih-insurance', '6 · Insurance & Protection', `
      ${fieldRow({ path: 'insurance.lifeClient', label: 'Life insurance — client', type: 'currency' }, spOn ? { path: 'insurance.lifeSpouse', label: 'Life insurance — spouse', type: 'currency' } : { path: 'protection.finalExpenses', label: 'Final expenses', type: 'currency' })}
      ${fieldRow({ path: 'protection.replacePct', label: 'Income replacement', type: 'percent' }, { path: 'protection.replaceYears', label: 'Years', type: 'number' })}
      ${spOn ? field({ path: 'protection.finalExpenses', label: 'Final expenses', type: 'currency' }) : ''}
      ${toggleField('protection.includeDebt', 'Cover outstanding debts')}
      ${toggleField('protection.includeEducation', 'Cover education funding')}`) +
    collapsiblePanel('ih-retirement', '7 · Retirement Goals', `
      ${fieldRow({ path: 'household.client.retireAge', label: 'Retirement age', type: 'age' }, { path: 'household.client.lifeExpectancy', label: 'Life expectancy', type: 'age' })}
      ${spOn ? fieldRow({ path: 'household.spouse.retireAge', label: 'Spouse retirement age', type: 'age' }, { path: 'household.spouse.lifeExpectancy', label: 'Spouse life expectancy', type: 'age' }) : ''}
      ${field({ path: 'expenses.retirementExpensePct', label: 'Retirement spending', hint: '% of today', type: 'percent' })}
      ${sectionLabel('Guaranteed retirement income — enter monthly amounts')}
      ${fieldRow({ path: 'income.ssClient', label: 'Social Security — client', hint: 'per month', type: 'monthly' }, { path: 'income.ssClaimClient', label: 'SS claim age — client', hint: 'if already receiving, their current age', type: 'age' })}
      ${spOn ? fieldRow({ path: 'income.ssSpouse', label: 'Social Security — spouse', hint: 'per month', type: 'monthly' }, { path: 'income.ssClaimSpouse', label: 'SS claim age — spouse', type: 'age' }) : ''}
      ${fieldRow({ path: 'income.pension', label: 'Pension', hint: 'per month', type: 'monthly' }, { path: 'income.pensionCola', label: 'Pension COLA', hint: '0 = level payment', type: 'percent' })}
      <p class="budget-note">Not claiming yet? Enter the <b>ssa.gov estimate at full retirement age (67)</b>. Already receiving? Enter <b>what arrives each month</b> and set the claim age to when they started.</p>`) +
    collapsiblePanel('ih-tax', '8 · Tax Assumptions', `
      ${fieldRow({ path: 'household.filing', label: 'Tax filing', type: 'select', options: filingOpts }, { path: 'household.state', label: 'State', type: 'text', ph: 'e.g. NY' })}
      ${fieldRow({ path: 'assumptions.stateTaxRate', label: 'State income tax', type: 'percent' }, { path: 'assumptions.inflation', label: 'Inflation', type: 'percent' })}
      ${fieldRow({ path: 'assumptions.preReturn', label: 'Return — pre-retire', type: 'percent' }, { path: 'assumptions.postReturn', label: 'Return — in retire', type: 'percent' })}`) +
    collapsiblePanel('ih-estate', '9 · Estate Goals', `
      ${fieldRow({ path: 'estate.legacyTarget', label: 'Legacy / estate target', type: 'currency' }, { path: 'estate.annualGifting', label: 'Annual gifting', type: 'currency' })}
      ${field({ path: 'estate.charitableGoal', label: 'Charitable goal', type: 'currency' })}
      ${sectionLabel('Estate documents in place')}
      ${toggleField('estate.hasWill', 'Will')}
      ${toggleField('estate.hasTrust', 'Living trust')}
      ${toggleField('estate.hasPOA', 'Financial power of attorney')}
      ${toggleField('estate.hasHealthDirective', 'Healthcare directive')}
      ${toggleField('estate.beneficiariesConfirmed', 'Beneficiaries confirmed')}
      ${field({ path: 'estate.estateNote', label: 'Estate notes', type: 'textarea', rows: 3, ph: 'Trustees, special wishes, follow-ups…' })}`) +
    collapsiblePanel('ih-goals', '10 · Other Goals', `<div id="goalsList">${(STATE.goals || []).map(goalRow).join('')}</div>
      <button class="add-row" data-action="add-goal">＋ Add goal</button>`, { sub: 'Education, purchases, custom' });

  getViewEl('intake').innerHTML = headBlock('Begin', 'New Client Intake',
    'Capture the household’s full picture in meeting order. Every field flows straight into the plan and every module — no re-entry.') +
    `<div class="profile-layout"><div class="acc-stack">${body}
       <button class="btn gold intake-cta" data-action="build-plan">Build the Plan →</button></div>
     <aside class="rail"><div id="res-intake"></div>
       <div style="height:1rem"></div>
       <button class="btn gold" style="width:100%;justify-content:center" data-action="build-plan">Build the Plan →</button></aside></div>`;
}
function liveIntake() {
  const el = $('#res-intake'); if (!el) return;
  const R = RESULTS;
  const mc = mcAsync(() => { if (currentView === 'intake') liveIntake(); });
  const sPct = mc ? Math.round(mc.success * 100) : null;
  const t3 = sPct == null ? '' : sPct >= 80 ? 'good' : sPct >= 60 ? 'warn' : 'bad';
  el.innerHTML = panel('Plan Snapshot', `
    <div class="grid cols-2" style="gap:.7rem;margin-bottom:.9rem">
      ${statCard('Net Worth', fmt$(R.netWorth), { small: true, tone: R.netWorth >= 0 ? 'good' : 'bad' })}
      ${statCard('Retirement Funded', pct(R.fundedRatio * 100, 0), { small: true, raw: true, valClass: 'val-' + tone(R.fundedRatio) })}
      ${statCard('Probability of Success', sPct == null ? '…' : sPct + '%', { small: true, raw: true, valClass: t3 ? 'val-' + t3 : '' })}
      ${statCard('Investable', fmt$(R.investable), { small: true })}
    </div>
    ${R.alloc.length ? donut(R.alloc, { size: 160 }) : '<div class="empty">Add accounts to see allocation.</div>'}`,
    { sub: 'Live' });
}
/* ----------------------------- PORTFOLIO LAB (UI) ------------------------- */
let PL_TAB = 'current';                                                 // which holdings editor is open
/* Holdings with an effective weight, regardless of entry mode — $ amounts become proportional weights. */
function plHoldings(pf) {
  const P = STATE.portfolios[pf] || {};
  if (P.entryMode !== 'dollar') return P.holdings || [];
  return (P.holdings || []).map(h => ({ ...h, weight: +h.amount || 0 }));   // portfolioStats normalizes by the total
}
const plDollarTotal = pf => ((STATE.portfolios[pf] || {}).holdings || []).reduce((s, h) => s + (+h.amount || 0), 0);
function plHoldingRow(pf, h, i) {
  const r = resolveHolding(h);
  const dollar = (STATE.portfolios[pf] || {}).entryMode === 'dollar';
  const clsOpts = Object.keys(ASSET_CLASSES).map(k => `<option value="${k}" ${(h.cls || r.cls) === k ? 'selected' : ''}>${ASSET_CLASSES[k].label}</option>`).join('');
  const nameTxt = r.known ? r.name : (r.ticker ? 'Unknown — pick a class' : '');
  const basis = (STATE.portfolios.settings && STATE.portfolios.settings.retBasis) || 'forward';
  let histTag = '';                                                    // show whether this row is backed by real history
  if (basis !== 'forward' && r.ticker) {
    if (r.usedHist) histTag = ` <span class="pl-htag" title="Real ${basis === 'hlife' ? 'since-inception' : 'trailing'} history">${r.histYrs}y real</span>`;
    else if (!r.histAvail) histTag = ` <span class="pl-htag warn" title="No price history on file — using the asset-class assumption">class est.</span>`;
  }
  const tot = dollar ? plDollarTotal(pf) : 0;
  const sizeCell = dollar
    ? `<div><div class="control has-prefix"><span class="prefix">$</span><input type="text" inputmode="decimal" data-pf="${pf}" data-hidx="${i}" data-hkey="amount" data-money value="${moneyDisplay(h.amount || '')}" placeholder="0"></div>
       <div class="pl-wpct" data-plw="${pf}-${i}">${tot > 0 ? pct((+h.amount || 0) / tot * 100, 1) : '&nbsp;'}</div></div>`
    : `<div class="control has-suffix"><input type="number" step="0.1" min="0" max="100" data-pf="${pf}" data-hidx="${i}" data-hkey="weight" data-vtype="percent" value="${h.weight != null && h.weight !== '' ? h.weight : ''}" placeholder="0"><span class="suffix">%</span></div>`;
  return `<div class="pl-row">
    <input type="text" style="text-transform:uppercase" list="tickerList" data-pf="${pf}" data-hidx="${i}" data-hkey="ticker" value="${escapeAttr(h.ticker || '')}" placeholder="Ticker" autocomplete="off">
    <div class="pl-name" data-pl-name="${pf}-${i}">${escapeHtml(nameTxt)}${histTag}</div>
    <select data-pf="${pf}" data-hidx="${i}" data-hkey="cls" data-vtype="text">${clsOpts}</select>
    ${sizeCell}
    <div class="control has-suffix"><input type="number" step="0.1" data-pf="${pf}" data-hidx="${i}" data-hkey="ret" data-vtype="percent" value="${h.ret != null && h.ret !== '' ? h.ret : ''}" placeholder="${r.ret}"><span class="suffix">%</span></div>
    <div class="control has-suffix"><input type="number" step="0.5" min="0" data-pf="${pf}" data-hidx="${i}" data-hkey="vol" data-vtype="percent" value="${h.vol != null && h.vol !== '' ? h.vol : ''}" placeholder="${r.vol}"><span class="suffix">%</span></div>
    <button class="rr-del" data-action="pl-del" data-pf="${pf}" data-idx="${i}" title="Remove">×</button>
  </div>`;
}
/* Live-refresh the derived % under each $ amount (and the header total) without rebuilding the rows. */
function plRefreshWeights(pf) {
  const P = STATE.portfolios[pf]; if (!P) return;
  if (P.entryMode === 'dollar') {
    const tot = plDollarTotal(pf);
    (P.holdings || []).forEach((h, i) => $$(`[data-plw="${pf}-${i}"]`).forEach(el => el.innerHTML = tot > 0 ? pct((+h.amount || 0) / tot * 100, 1) : '&nbsp;'));
    $$(`[data-pl-total="${pf}"]`).forEach(el => el.innerHTML = 'Total ' + badge(fmt$(tot), tot > 0 ? 'good' : 'warn'));
  } else {
    const totW = (P.holdings || []).reduce((s, h) => s + (+h.weight || 0), 0);
    $$(`[data-pl-total="${pf}"]`).forEach(el => el.innerHTML = 'Total ' + (Math.abs(totW - 100) < 0.05 ? badge(totW.toFixed(0) + '%', 'good') : badge(totW.toFixed(1) + '%', 'warn')));
  }
}
function plEditor(pf) {
  const P = STATE.portfolios[pf], dollar = P.entryMode === 'dollar';
  const stats = portfolioStats(plHoldings(pf));
  let totBadge;
  if (dollar) { const tot = plDollarTotal(pf); totBadge = badge(fmt$(tot), tot > 0 ? 'good' : 'warn'); }
  else { const totW = (P.holdings || []).reduce((s, h) => s + (+h.weight || 0), 0); totBadge = Math.abs(totW - 100) < 0.05 ? badge(totW.toFixed(0) + '%', 'good') : badge(totW.toFixed(1) + '%', 'warn'); }
  const segBtn = (v, l) => `<button type="button" class="seg-btn ${(dollar ? 'dollar' : 'pct') === v ? 'on' : ''}" data-action="pl-entry" data-pf="${pf}" data-mode="${v}">${l}</button>`;
  return `<div class="panel">
    <div class="panel-head" style="flex-wrap:wrap;gap:.7rem">
      <div style="display:flex;align-items:center;gap:.7rem;flex:1;min-width:260px">
        <h3 style="white-space:nowrap">${pf === 'current' ? 'Current Holdings' : 'Proposed Holdings'}</h3>
        <input type="text" data-path="portfolios.${pf}.name" data-vtype="text" value="${escapeAttr(P.name || '')}" style="max-width:240px" title="Label on charts & report">
      </div>
      <div class="btn-row" style="align-items:center">
        <span class="seg mode-seg" role="group" title="How the statement gives you the holdings">${segBtn('pct', '% weights')}${segBtn('dollar', '$ amounts')}</span>
        <span style="font-size:.74rem;color:var(--muted)" data-pl-total="${pf}">Total ${totBadge}</span>
        ${dollar ? '' : `<button class="btn sm" data-action="pl-normalize" data-pf="${pf}">Normalize to 100%</button>`}
        <button class="btn sm" data-action="pl-paste-toggle" data-pf="${pf}">📋 Paste from statement</button>
      </div>
    </div>
    <div class="panel-body" style="padding-top: .9rem">
      <div class="pl-paste" id="plPaste-${pf}" hidden>
        <textarea id="plPasteText-${pf}" rows="6" placeholder="Paste holdings straight from a statement or proposal — one per line. Percents or dollars both work:&#10;SPDR MSCI USA StrategicFactors ETF (QUS)   12.40%&#10;Vanguard Total World Bond ETF (BNDW)   9.00&#10;Apple Inc (AAPL)   $45,230.12"></textarea>
        <div class="btn-row" style="margin-top:.5rem">
          <button class="btn gold sm" data-action="pl-paste-import" data-pf="${pf}">Import — replaces this list</button>
          <button class="btn ghost sm" data-action="pl-paste-toggle" data-pf="${pf}">Cancel</button>
          <span style="font-size:.72rem;color:var(--muted);align-self:center">Reads the (TICKER) and the trailing number — % or $ detected automatically.</span>
        </div>
      </div>
      <div class="pl-colhead"><span>Ticker</span><span>Fund / security</span><span>Asset class</span><span>${dollar ? 'Amount' : 'Weight'}</span><span>Exp. ret</span><span>Volatility</span><span></span></div>
      <div id="plList-${pf}">${(P.holdings || []).map((h, i) => plHoldingRow(pf, h, i)).join('')}</div>
      <div class="btn-row" style="align-items:center;margin-top:.4rem">
        <button class="add-row" data-action="pl-add" data-pf="${pf}">＋ Add holding</button>
        ${stats ? `<span style="margin-left:auto;font-size:.76rem;color:var(--muted)">Portfolio: expected <b>${pct(stats.mean * 100, 1)}</b> · volatility <b>±${pct(stats.vol * 100, 1)}</b></span>` : ''}
      </div>
    </div></div>`;
}
function ensureTickerDatalist() {                                       // one shared autocomplete list for every ticker input
  if ($('#tickerList')) return;
  const dl = document.createElement('datalist'); dl.id = 'tickerList';
  dl.innerHTML = Object.keys(TICKERS).map(k => `<option value="${escapeAttr(k)}" label="${escapeAttr(TICKERS[k][1])}"></option>`).join('');
  document.body.appendChild(dl);
}
/* Parse statement lines like "Fund Name (TICKER)  12.40%" or "Apple (AAPL)  $45,230.12".
   Detects whether the numbers are percentages or dollars (majority vote) and returns {holdings, dollar}. */
function plParsePaste(text) {
  const rows = []; let dollarHits = 0, pctHits = 0;
  String(text || '').split(/\r?\n+/).forEach(line => {
    line = line.trim(); if (!line) return;
    let tk = null;
    const par = line.match(/\(([A-Za-z0-9.\-]{1,7})\)/);
    if (par) tk = par[1];
    if (!tk) { const first = line.split(/[\s,\t]+/)[0]; if (/^[A-Za-z][A-Za-z0-9.\-]{0,6}$/.test(first)) tk = first; }
    if (!tk) return;
    const rest = line.replace(/\([^)]*\)/g, '');                       // ignore anything inside the (TICKER) parens
    const hasPct = /%/.test(rest);
    const isDollar = !hasPct && (/\$/.test(rest) || /\d,\d{3}(?:\.\d+)?(?!\d)/.test(rest));   // a $ sign or thousands-grouped number
    const m = rest.replace(/\$/g, '').match(/(\d[\d,]*(?:\.\d+)?)\s*%?\s*$/);
    const val = m ? parseFloat(m[1].replace(/,/g, '')) : 0;
    if (isDollar) dollarHits++; else if (hasPct) pctHits++;
    rows.push({ tk: tk.toUpperCase(), val, dollarish: isDollar });
  });
  const dollar = dollarHits > pctHits;                                // whichever the statement mostly uses wins
  const holdings = rows.map(r => dollar ? { id: uid(), ticker: r.tk, amount: r.val } : { id: uid(), ticker: r.tk, weight: r.val });
  return { holdings, dollar };
}
function buildPortfolioLab() {
  ensureTickerDatalist();
  const st = STATE.portfolios.settings, mode = st.mode || 'plan';
  const investable = RESULTS.investable || 0;
  const retBasis = st.retBasis || 'forward';
  const basisNote = retBasis === 'forward'
    ? 'Forward-looking <b>capital-market planning assumptions</b> by asset class — deliberately conservative long-run estimates. Best for expectations you can defend to a client.'
    : `Real <b>dividend-adjusted returns</b> from each fund’s actual ${retBasis === 'hlife' ? 'since-inception' : 'trailing-20-year'} history (as of ${HIST_ASOF}) — a <b>benchmark, not a projection</b>, so it reflects the last ${retBasis === 'hlife' ? 'few decades' : '20 years'} of markets. <b>Past performance is no guarantee of future results.</b> Funds too young for the full window use what history they have; any without data fall back to their asset-class assumption.`;
  const modeNote = {
    plan: '<b>Through the plan</b> runs the client’s entire financial plan — spending, Social Security, pension, taxes, RMDs, events — under each portfolio’s return and risk. Success = the money lasts to life expectancy.',
    withdraw: '<b>Retirement withdrawals</b> draws an income from the portfolio each year (inflation-adjusted) with no other cash flows — the classic income stress test, plus the sustainable draw at 90% confidence.',
    growth: '<b>Grow a lump sum</b> compounds a starting amount under each portfolio — no withdrawals — and shows the range of outcomes.'
  }[mode];
  let modeFields = '';
  if (mode === 'plan') modeFields = `<div class="grid cols-4">${field({ path: 'portfolios.settings.trials', label: 'Simulations per portfolio', type: 'select', options: [{ value: 400, label: '400 — fast' }, { value: 800, label: '800 — standard' }, { value: 1500, label: '1,500 — fine' }] })}</div>`;
  else if (mode === 'withdraw') {
    const wdPctMode = (st.wdType || 'pct') === 'pct';
    modeFields = `<div class="grid cols-4">
      ${field({ path: 'portfolios.settings.start', label: 'Starting portfolio', type: 'currency', ph: investable ? String(investable) : '1,000,000' })}
      <div class="field"><label>Withdrawal ${modeSeg('pl-wdtype', wdPctMode ? 'pct' : 'dollar', [['pct', '% of start'], ['dollar', '$ / year']])}</label>
        ${wdPctMode
          ? `<div class="control has-suffix"><input type="number" step="0.1" min="0" max="20" data-path="portfolios.settings.wdPct" data-vtype="percent" value="${st.wdPct != null ? st.wdPct : 4}"><span class="suffix">% / yr</span></div>`
          : `<div class="control has-prefix has-suffix"><span class="prefix">$</span><input type="text" inputmode="decimal" data-path="portfolios.settings.wdAmount" data-money value="${moneyDisplay(st.wdAmount || 0)}"><span class="suffix">/yr</span></div>`}
      </div>
      ${field({ path: 'portfolios.settings.years', label: 'For how many years', type: 'number', min: 1, max: 60 })}
      ${field({ path: 'portfolios.settings.trials', label: 'Simulations', type: 'select', options: [{ value: 600, label: '600 — fast' }, { value: 1200, label: '1,200 — standard' }, { value: 2500, label: '2,500 — fine' }] })}
    </div>
    ${toggleField('portfolios.settings.inflateWd', 'Increase the withdrawal with inflation each year')}`;
  } else modeFields = `<div class="grid cols-4">
      ${field({ path: 'portfolios.settings.start', label: 'Starting amount', type: 'currency', ph: investable ? String(investable) : '100,000' })}
      ${field({ path: 'portfolios.settings.annual', label: 'Added each year', type: 'currency' })}
      ${field({ path: 'portfolios.settings.years', label: 'Years to grow', type: 'number', min: 1, max: 60 })}
    </div>`;
  const tabBtn = pf => {
    const P = STATE.portfolios[pf], n = (P.holdings || []).filter(h => (h.ticker || '').trim()).length;
    return `<button class="pl-tab ${PL_TAB === pf ? 'on' : ''}" data-action="pl-tab" data-pf="${pf}">${pf === 'current' ? 'Current portfolio' : 'Proposed portfolio'} <span class="pl-tab-n">${n}</span></button>`;
  };
  getViewEl('portfolio').innerHTML = headBlock('Analytics', 'Portfolio Lab',
    'Enter the tickers he owns and the portfolio you’d put him in — then stress-test both through hundreds of market simulations and compare outcomes side by side.') +
    `<div class="advisor-only">
      <div class="panel pad" style="margin-bottom:1.1rem">
        <div class="block-head"><span class="block-title">Scenario</span>${modeSeg('pl-mode', mode, [['plan', 'Through the plan'], ['withdraw', 'Retirement withdrawals'], ['growth', 'Grow a lump sum']])}</div>
        <p class="budget-note">${modeNote}</p>
        ${modeFields}
        <div class="block-head" style="margin-top:1rem"><span class="block-title">Return basis</span>${modeSeg('pl-retbasis', retBasis, [['forward', 'Planning (forward)'], ['h20', 'Historical 20-yr'], ['hlife', 'Since inception']])}</div>
        <p class="budget-note">${basisNote}</p>
      </div>
      <div class="pl-tabs">${tabBtn('current')}${tabBtn('proposed')}</div>
      ${plEditor(PL_TAB)}
    </div>
    <div style="height:1.2rem"></div>
    <div id="res-portfolio"></div>`;
}
function plCompareChart(xs, A, B, opts = {}) {
  const W = opts.w || 760, H = opts.h || 260, pad = { l: 56, r: 16, t: 16, b: 28 };
  const xMin = xs[0], xMax = xs[xs.length - 1];
  const hiAll = [...(A ? A.p90 : []), ...(B ? B.p90 : []), 1];
  const yMax = Math.max(...hiAll) * 1.06;
  const sx = x => pad.l + (x - xMin) / ((xMax - xMin) || 1) * (W - pad.l - pad.r);
  const sy = y => H - pad.b - y / yMax * (H - pad.t - pad.b);
  let grid = '', ylab = '';
  for (let i = 0; i <= 4; i++) { const v = yMax * i / 4, yy = sy(v); grid += `<line class="grid-line" x1="${pad.l}" y1="${yy}" x2="${W - pad.r}" y2="${yy}"/>`; ylab += `<text class="lbl amount" x="${pad.l - 8}" y="${yy + 3}" text-anchor="end">${fmtK(v)}</text>`; }
  let xlab = ''; for (let i = 0; i <= 6; i++) { const xv = xMin + (xMax - xMin) * i / 6; xlab += `<text class="lbl" x="${sx(xv)}" y="${H - 8}" text-anchor="middle">${Math.round(xv)}</text>`; }
  const band = (S2, color) => { if (!S2) return ''; const top = xs.map((x, i) => `${i ? 'L' : 'M'}${sx(x).toFixed(1)} ${sy(S2.p90[i]).toFixed(1)}`).join(' ');
    const bot = xs.map((x, i) => `L${sx(x).toFixed(1)} ${sy(S2.p10[i]).toFixed(1)}`).reverse().join(' ');
    return `<path d="${top} ${bot} Z" fill="${color}" opacity=".13"/><path class="line" d="${xs.map((x, i) => `${i ? 'L' : 'M'}${sx(x).toFixed(1)} ${sy(S2.p50[i]).toFixed(1)}`).join(' ')}" stroke="${color}"/>`; };
  let mk = ''; (opts.markers || []).forEach(m => { const mx = sx(m.x); mk += `<line class="marker-line" x1="${mx}" y1="${pad.t}" x2="${mx}" y2="${H - pad.b}"/><text class="lbl-strong" x="${mx}" y="${pad.t + 9}" text-anchor="middle">${escapeHtml(m.label)}</text>`; });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${grid}${mk}${band(A, 'var(--ink)')}${band(B, 'var(--gold-deep)')}<line class="axis" x1="${pad.l}" y1="${H - pad.b}" x2="${W - pad.r}" y2="${H - pad.b}"/>${ylab}${xlab}</svg>`;
}
function plAllocBar(stats) {
  if (!stats) return '';
  const order = Object.keys(ASSET_CLASSES);
  const colors = { usL: 'var(--gold)', usS: '#d9a84a', intl: '#7c8aa0', em: '#b08968', bond: 'var(--ink)', tsy: '#33425a', hy: '#8a6d3b', reit: '#4ba585', gold: '#c9a227', cmd: '#a67c52', cash: '#9fb0c2', bal: '#6b7f99', crypto: '#8757b2', custom: '#94a3b4' };
  const segs = order.filter(k => stats.byClass[k] > 0.001).map(k => `<i style="width:${(stats.byClass[k] * 100).toFixed(1)}%;background:${colors[k]}" title="${escapeAttr(ASSET_CLASSES[k].label)}"></i>`).join('');
  const leg = order.filter(k => stats.byClass[k] > 0.001).map(k => `<span><i class="dot" style="background:${colors[k]}"></i>${ASSET_CLASSES[k].label} ${pct(stats.byClass[k] * 100, 0)}</span>`).join('');
  return `<div class="compbar" style="height:12px">${segs}</div><div class="comp-legend">${leg}</div>`;
}
function livePortfolioLab() {
  const el = $('#res-portfolio'); if (!el) return;
  const st = STATE.portfolios.settings, mode = st.mode || 'plan';
  const res = plAsync(() => { if (currentView === 'portfolio') livePortfolioLab(); });
  const curStats = portfolioStats(plHoldings('current'));
  const proStats = portfolioStats(plHoldings('proposed'));
  if (!curStats && !proStats) { el.innerHTML = panel('Results', '<div class="empty">Add holdings with weights to either portfolio to run the analysis.</div>'); return; }
  if (!res) {
    const runNote = mode === 'plan' ? `${+st.trials || 800} full-plan simulations` : mode === 'withdraw' ? `${+st.trials || 1200} withdrawal simulations + sustainable-draw search` : '1,500 growth simulations';
    el.innerHTML = panel('Results', `<div class="empty"><div class="e-ico">◷</div>Running ${runNote} per portfolio…</div>`);
    return;
  }
  const A = res.current, B = res.proposed;
  const card = (label, r, colorVar) => {
    if (!r) return `<div class="panel pad"><div class="empty">No ${label.toLowerCase()} holdings yet.</div></div>`;
    const s = r.stats;
    const head = `<div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.4rem"><span class="dot" style="background:${colorVar};width:11px;height:11px"></span><b style="font-size:1.02rem">${escapeHtml(label)}</b></div>`;
    if (mode === 'plan') {
      const pctV = Math.round(r.mc.success * 100), t3 = pctV >= 80 ? 'good' : pctV >= 60 ? 'warn' : 'bad';
      return `<div class="panel pad" style="text-align:center">${head}${gauge(pctV, { size: 170 })}
        <div>${badge(pctV >= 80 ? 'Strong' : pctV >= 60 ? 'On track' : 'At risk', t3)}</div>
        <div class="tl-rows" style="text-align:left">
          <div class="tl-row"><span>Expected return / risk</span><b>${pct(s.mean * 100, 1)} / ±${pct(s.vol * 100, 1)}</b></div>
          <div class="tl-row"><span>Median ending estate</span><b class="amount">${fmtK(r.mc.endP50)}</b></div>
          <div class="tl-row"><span>Bad markets (10th pct.)</span><b class="amount">${r.mc.endP10 > 0 ? fmtK(r.mc.endP10) : 'lasts to ' + (r.mc.deplP10 > r.mc.lastAge ? r.mc.lastAge + '+' : r.mc.deplP10)}</b></div>
        </div>
        <div style="margin-top:.6rem">${plAllocBar(s)}</div></div>`;
    }
    if (mode === 'withdraw') {
      const pctV = Math.round(r.w.success * 100), t3 = pctV >= 85 ? 'good' : pctV >= 70 ? 'warn' : 'bad';
      return `<div class="panel pad" style="text-align:center">${head}${gauge(pctV, { size: 170 })}
        <div>${badge(pctV >= 85 ? 'Sustainable' : pctV >= 70 ? 'Watch closely' : 'At risk', t3)}</div>
        <div class="tl-rows" style="text-align:left">
          <div class="tl-row"><span>Drawing</span><b class="amount">${fmt$(r.w.wd0)}/yr (${pct(r.w.start > 0 ? r.w.wd0 / r.w.start * 100 : 0, 1)})</b></div>
          <div class="tl-row"><span>Expected return / risk</span><b>${pct(s.mean * 100, 1)} / ±${pct(s.vol * 100, 1)}</b></div>
          <div class="tl-row"><span>Median ending balance</span><b class="amount">${fmtK(r.w.endP50)}</b></div>
          <div class="tl-row"><span>Bad markets (10th pct.)</span><b class="amount">${r.w.endP10 > 0 ? fmtK(r.w.endP10) : 'lasts ~' + Math.min(r.w.lastYearsP10, r.w.years) + ' yrs'}</b></div>
        </div>
        <p class="i-action" style="text-align:left;margin-top:.5rem">Sustains ≈ <b class="amount">${fmt$(r.swr || 0)}/yr</b> (${pct(r.w.start > 0 ? (r.swr || 0) / r.w.start * 100 : 0, 1)} of the start) at <b>90% confidence</b> over ${r.w.years} years.</p>
        <div style="margin-top:.6rem">${plAllocBar(s)}</div></div>`;
    }
    return `<div class="panel pad">${head}
      <div class="tl-rows">
        <div class="tl-row"><span>Expected return / risk</span><b>${pct(s.mean * 100, 1)} / ±${pct(s.vol * 100, 1)}</b></div>
        <div class="tl-row"><span>Median outcome</span><b class="amount">${fmtK(r.g.endP50)}</b></div>
        <div class="tl-row"><span>Range (10th–90th)</span><b class="amount">${fmtK(r.g.endP10)} – ${fmtK(r.g.endP90)}</b></div>
        <div class="tl-row"><span>Chance of ending below invested</span><b>${pct(r.g.lossProb * 100, 0)}</b></div>
      </div>
      <div style="margin-top:.6rem">${plAllocBar(s)}</div></div>`;
  };
  const pick = r => r ? (mode === 'plan' ? r.mc : mode === 'withdraw' ? r.w : r.g) : null;
  const chA = pick(A), chB = pick(B);
  const xs = mode === 'plan' ? (A ? A.mc.ages : B.mc.ages) : Array.from({ length: (+st.years || 30) + 1 }, (_, i) => i);
  const cmp = (label, a, b, fmt, higherBetter = true) => (a == null || b == null) ? '' : cmpRow(label, a, b, fmt, higherBetter);
  const table = (A && B) ? `<table class="tbl" style="margin-top:1rem"><thead><tr><th style="text-align:left">Metric</th><th>${escapeHtml(STATE.portfolios.current.name || 'Current')}</th><th>${escapeHtml(STATE.portfolios.proposed.name || 'Proposed')}</th><th>Change</th></tr></thead><tbody>
      ${mode === 'plan' ? cmp('Probability of success', Math.round(A.mc.success * 100), Math.round(B.mc.success * 100), v => v + '%') : ''}
      ${mode === 'withdraw' ? cmp('Probability the income lasts', Math.round(A.w.success * 100), Math.round(B.w.success * 100), v => v + '%') : ''}
      ${mode === 'withdraw' ? cmp('Sustainable draw @90%', Math.round(A.swr || 0), Math.round(B.swr || 0), fmt$) : ''}
      ${mode === 'plan' ? cmp('Median ending estate', A.mc.endP50, B.mc.endP50, fmt$) : mode === 'withdraw' ? cmp('Median ending balance', A.w.endP50, B.w.endP50, fmt$) : cmp('Median outcome', A.g.endP50, B.g.endP50, fmt$)}
      ${mode === 'plan' ? cmp('Bad-market ending (10th)', A.mc.endP10, B.mc.endP10, fmt$) : mode === 'withdraw' ? cmp('Bad-market ending (10th)', A.w.endP10, B.w.endP10, fmt$) : cmp('10th percentile', A.g.endP10, B.g.endP10, fmt$)}
      ${cmp('Expected return', +(A.stats.mean * 100).toFixed(1), +(B.stats.mean * 100).toFixed(1), v => pct(v, 1))}
      ${cmp('Volatility (risk)', +(A.stats.vol * 100).toFixed(1), +(B.stats.vol * 100).toFixed(1), v => '±' + pct(v, 1), false)}
    </tbody></table>` : '';
  const chartTitle = mode === 'plan' ? 'Plan Outcomes Under Each Portfolio' : mode === 'withdraw' ? 'Portfolio Balance While Drawing Income' : 'Growth of the Money';
  el.innerHTML = `
    <div class="grid cols-2" style="margin-bottom:1.1rem;align-items:stretch">${card(STATE.portfolios.current.name || 'Current', A, 'var(--ink)')}${card(STATE.portfolios.proposed.name || 'Proposed', B, 'var(--gold-deep)')}</div>
    ${panel(chartTitle, plCompareChart(xs, chA, chB, { markers: mode === 'plan' && !RESULTS.alreadyRetired ? [{ x: RESULTS.retAge, label: 'Retire' }] : [] }) +
      `<div class="legend"><span><i class="dot" style="background:var(--ink)"></i>${escapeHtml(STATE.portfolios.current.name || 'Current')}</span><span><i class="dot" style="background:var(--gold-deep)"></i>${escapeHtml(STATE.portfolios.proposed.name || 'Proposed')}</span><span>Bands: 10th–90th percentile · lines: median</span></div>` + table,
      { sub: (mode === 'growth' ? '1,500 trials each' : `${+st.trials || (mode === 'withdraw' ? 1200 : 800)} trials each`) + ' · ' + ((st.retBasis || 'forward') === 'forward' ? 'planning returns' : (st.retBasis === 'hlife' ? 'historical since-inception' : 'historical 20-yr') + ' (as of ' + HIST_ASOF + ')'), hideKey: 'pl-results' })}
    <div class="btn-row advisor-only" style="margin-top:1rem">
      ${A ? `<button class="btn" data-action="pl-apply" data-pf="current">Use Current in plan assumptions</button>` : ''}
      ${B ? `<button class="btn gold" data-action="pl-apply" data-pf="proposed">Use Proposed in plan assumptions</button>` : ''}
    </div>
    <details class="pl-method advisor-only" style="margin-top:1rem">
      <summary>How these numbers work — methodology</summary>
      <ul>
        <li><b>Two return bases, your choice (top of the page).</b> <i>Planning (forward)</i> maps each ticker to its asset class and uses conservative long-run capital-market assumptions — best for expectations you can defend. <i>Historical 20-yr</i> and <i>Since inception</i> use each fund’s <b>real, dividend-adjusted total return</b> from its actual price history (as of ${HIST_ASOF}) — a benchmark that shows what the holdings actually did. Past performance is no guarantee; the two usually differ a lot because the last 20 years were an unusually strong market.</li>
        <li><b>Historical is real per-fund data.</b> ${Object.keys(HIST).length.toLocaleString()} symbols carry actual trailing-20-year and since-inception return and volatility. A fund too young for the full window uses the history it has (the years covered are noted on the row); a fund with no data falls back to its asset-class assumption. You can always override any row’s <i>Exp. ret</i> / <i>Volatility</i> cell — an override wins over both bases.</li>
        <li><b>Risk uses class volatilities and correlations.</b> A diversified mix shows less risk than the sum of its parts. A single stock keeps its return but carries concentrated (idiosyncratic) volatility, and leveraged or inverse funds carry very high volatility so the simulation reflects their decay rather than a headline number.</li>
        <li><b>“Through the plan” stands in for the plan’s return knobs.</b> In this scenario the portfolio’s own expected return and volatility <b>replace</b> the Client Profile’s pre- and in-retirement return assumptions — so changing those two knobs does not move this gauge. Click <b>Use in plan assumptions</b> to copy the portfolio’s return and risk into the plan itself (it sets both the pre- and in-retirement returns to this one number and clears any conflicting per-account growth rates), so the Dashboard, Foundational, and Tax pages all run on the same portfolio.</li>
      </ul>
    </details>
    <p class="rp-disclaimer" style="margin-top:.8rem">${(st.retBasis || 'forward') === 'forward'
      ? 'Ticker figures are long-run capital-market planning assumptions by asset class (editable above) — not live market data, past performance, or a guarantee.'
      : `Return and volatility figures are each fund’s real, dividend-adjusted <b>past performance</b> over its ${st.retBasis === 'hlife' ? 'since-inception' : 'trailing-20-year'} history (as of ${HIST_ASOF}) — a benchmark, <b>not a guarantee of future results</b>; funds without enough history use their asset-class assumption.`} Single securities carry concentrated risk. “Through the plan” runs the client’s actual cash flows — spending, guaranteed income, taxes, and RMDs — under randomized returns.</p>`;
}

const builders = { intake: buildIntake, profile: buildProfile, needs: buildNeeds, cashflow: buildCashflow, decision: buildDecision, tax: buildTax, portfolio: buildPortfolioLab };
const liveFns = { intake: liveIntake, dashboard: renderDashboard, profile: liveProfile, needs: liveNeeds, cashflow: liveCashflow, foundational: renderFoundational, decision: liveDecision, tax: liveTax, portfolio: livePortfolioLab, coplanner: renderCoplanner };
function showView(v) {
  if (presentMode) return showPresentView(v);
  currentView = v; document.body.dataset.view = v;
  $$('.navlink').forEach(n => n.classList.toggle('active', n.dataset.view === v));
  $$('.view').forEach(s => s.classList.toggle('active', s.dataset.view === v));
  if (builders[v]) { builders[v](); built[v] = true; }   /* rebuild input scaffolding so shared fields stay in sync across modules */
  const f = liveFns[v]; if (f) f();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ----------------------------- plan menu ---------------------------------- */
function renderPlanMenu() {
  const store = loadStore();
  const plans = Object.values(store.plans).sort((a, b) => b.updatedAt - a.updatedAt);
  $('#planMenu').innerHTML = `<h4>Client Plans</h4>` +
    (plans.length ? plans.map(p => `<div class="plan-item ${p.id === currentPlanId ? 'active' : ''}" data-action="open-plan" data-id="${p.id}">
      <span class="pi-name">${escapeHtml(p.name)}</span><span class="pi-meta">${new Date(p.updatedAt).toLocaleDateString()}</span>
      <button class="pi-del" data-action="del-plan" data-id="${p.id}" title="Delete plan">✕</button></div>`).join('')
      : '<div style="padding:.4rem .6rem;color:var(--faint);font-size:.82rem">No saved plans yet</div>') +
    `<div class="menu-sep"></div><div class="menu-act">
      <button class="btn sm" data-action="new-plan">＋ New</button>
      <button class="btn sm" data-action="new-sample">Load sample</button>
      <button class="btn sm" data-action="duplicate">Duplicate</button></div>
    <div class="menu-act">
      <button class="btn sm" data-action="export">⤓ Export JSON</button>
      <button class="btn sm" data-action="import">⤒ Import JSON</button></div>
    <div class="menu-sep"></div>${cloudMenuBlock()}`;
}
function cloudMenuBlock() {
  const s = Cloud.status, mail = Cloud.email ? escapeHtml(Cloud.email) : '';
  const dot = s === 'ready' ? 'good' : s === 'locked' ? 'warn' : 'faint';
  const label = s === 'off' ? 'Cloud sync — off'
    : s === 'signedout' ? 'Cloud sync — set up, not signed in'
    : s === 'locked' ? `Cloud — ${mail} · locked`
    : Cloud.lastError ? `Cloud — ${mail} · sync error`
    : `Cloud — ${mail} · ${Cloud.lastSync ? 'synced ' + timeAgo(Cloud.lastSync) : 'signed in'}`;
  const btn = s === 'off' ? 'Set up cloud sync'
    : s === 'signedout' ? 'Sign in'
    : s === 'locked' ? 'Unlock' : 'Manage sync';
  return `<div class="cloud-menu">
      <div class="cloud-row"><span class="cloud-dot ${dot}"></span><span class="cloud-lbl">${label}</span></div>
      <div class="menu-act">
        <button class="btn sm gold" data-action="cloud-open">☁ ${btn}</button>
        ${s === 'ready' ? '<button class="btn sm" data-action="cloud-sync">Sync now</button>' : ''}
      </div>
    </div>`;
}
function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago';
}
function renderCloudStatus() { if ($('#planMenu') && !$('#planMenu').hidden) renderPlanMenu(); if ($('#cloudModal') && !$('#cloudModal').hidden) renderCloudModal(); }

const CLOUD_SETUP_SQL =
`create table if not exists public.vault (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data text not null,
  updated_at timestamptz not null default now()
);
alter table public.vault enable row level security;
grant select, insert, update, delete on public.vault to authenticated;
create policy "own vault" on public.vault
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);`;

function ensureCloudModal() {
  if ($('#cloudModal')) return;
  const d = document.createElement('div'); d.id = 'cloudModal'; d.hidden = true;
  d.innerHTML = `<div class="report-dialog cloud-dialog">
    <header class="rd-head"><h2>☁ Cloud sync</h2><button class="icon-btn ghost" data-action="cloud-close">Close ✕</button></header>
    <div class="rd-body" id="cloudBody"></div></div>`;
  document.body.appendChild(d);
  d.addEventListener('click', e => { if (e.target === d) closeCloudModal(); });
}
function openCloudModal() { ensureCloudModal(); $('#cloudModal').hidden = false; renderCloudModal(); }
function closeCloudModal() { const m = $('#cloudModal'); if (m) m.hidden = true; }
function renderCloudModal() {
  const body = $('#cloudBody'); if (!body) return;
  const cfg = cloudCfg();
  const warn = `<p class="cloud-warn">🔒 <b>End-to-end encrypted.</b> Your plans are scrambled on this device with your master password before they’re uploaded — the server can never read them. <b>If you forget the master password, the encrypted data can’t be recovered</b>, so store it somewhere safe.</p>`;
  if (Cloud.status === 'off' || !cfg) {
    body.innerHTML = `
      <p class="cloud-lead">Set this up once to reach your plans from any device — for free. Your client data is encrypted on your device first, so the cloud only ever holds unreadable ciphertext.</p>
      <ol class="cloud-steps">
        <li>Create a free project at <b>supabase.com</b> → <i>New project</i> (pick any name; wait ~2 min for it to finish).</li>
        <li>Open the project’s <b>SQL Editor</b>, paste the snippet below, and click <b>Run</b>. It creates one private table locked to your account.
          <div class="cloud-sql"><pre id="cloudSql">${escapeHtml(CLOUD_SETUP_SQL)}</pre><button class="btn sm" data-action="cloud-copy-sql">Copy SQL</button></div></li>
        <li>Go to <b>Project Settings → API</b> and copy your <b>Project URL</b> and the <b>anon public</b> key into the two boxes here.</li>
      </ol>
      <div class="cloud-field"><label>Project URL</label><input type="text" id="cloudUrl" placeholder="https://xxxxx.supabase.co" value="${escapeAttr(cfg ? cfg.url : '')}"></div>
      <div class="cloud-field"><label>anon public key</label><input type="text" id="cloudAnon" placeholder="eyJhbGciOi…" value="${escapeAttr(cfg ? cfg.anon : '')}"></div>
      <p class="cloud-hint">The anon key is meant to be public — it only permits the encrypted, per-user access the SQL above defines.</p>
      <div class="rd-foot" style="padding:0;border:none"><button class="btn gold" data-action="cloud-save-cfg">Save & continue →</button></div>`;
    return;
  }
  if (Cloud.status === 'signedout') {
    body.innerHTML = `
      <p class="cloud-lead">Sign in to sync. <b>First time?</b> Create your account with any email and a <b>master password</b> — that password both signs you in and encrypts your data.</p>
      ${warn}
      <div class="cloud-field"><label>Email</label><input type="email" id="cloudEmail" placeholder="you@practice.com" autocomplete="username"></div>
      <div class="cloud-field"><label>Master password</label><input type="password" id="cloudPass" placeholder="Choose a strong one you’ll remember" autocomplete="current-password"></div>
      <div class="cloud-actrow">
        <button class="btn gold" data-action="cloud-login">Log in</button>
        <button class="btn" data-action="cloud-signup">Create account</button>
        <button class="btn ghost sm" data-action="cloud-reset-cfg">Change project</button>
      </div>
      <div id="cloudMsg" class="cloud-msg"></div>`;
    return;
  }
  if (Cloud.status === 'locked') {
    body.innerHTML = `
      <p class="cloud-lead">Welcome back, <b>${escapeHtml(Cloud.email)}</b>. Enter your master password to unlock and sync on this device.</p>
      <div class="cloud-field"><label>Master password</label><input type="password" id="cloudPass" placeholder="Master password" autocomplete="current-password"></div>
      <div class="cloud-actrow">
        <button class="btn gold" data-action="cloud-unlock">Unlock & sync</button>
        <button class="btn ghost sm" data-action="cloud-logout">Sign out</button>
      </div>
      <div id="cloudMsg" class="cloud-msg"></div>`;
    return;
  }
  // ready
  body.innerHTML = `
    <p class="cloud-lead">Signed in as <b>${escapeHtml(Cloud.email)}</b>. Your plans sync automatically as you work.</p>
    <div class="cloud-status-card">
      <div><span class="cloud-dot good"></span> ${Cloud.lastError ? 'Last sync failed: ' + escapeHtml(Cloud.lastError) : (Cloud.lastSync ? 'Last synced ' + timeAgo(Cloud.lastSync) : 'Signed in — no sync yet')}</div>
    </div>
    ${warn}
    <div class="cloud-actrow">
      <button class="btn gold" data-action="cloud-sync">Sync now</button>
      <button class="btn" data-action="cloud-logout">Sign out</button>
      <button class="btn ghost sm" data-action="cloud-reset-cfg">Change project</button>
    </div>
    <div id="cloudMsg" class="cloud-msg"></div>`;
}
function cloudMsg(text, kind) { const el = $('#cloudMsg'); if (el) el.innerHTML = `<span class="${kind || ''}">${escapeHtml(text)}</span>`; }
async function cloudAfterAuth() {                                        // reconcile, then show the account's data on this device
  cloudMsg('Syncing…');
  try {
    const r = await cloudReconcile();
    const store = loadStore(); const ids = Object.keys(store.plans);
    if (ids.length) {
      currentPlanId = (store.current && store.plans[store.current]) ? store.current
        : (store.plans[currentPlanId] ? currentPlanId : ids[0]);
      STATE = ensureDefaults(store.plans[currentPlanId].state);
      resetBuilt(); RESULTS = compute(STATE);
      document.body.classList.toggle('inputs-collapsed', !!(STATE.ui && STATE.ui.collapsed));
      updateHeader(); showView(currentView || 'dashboard'); refreshAll();
    } else { newPlan(); }
    toast(r.hadRemote ? 'Your plans are synced ☁' : 'Cloud sync is on — this device is backed up ☁');
  } catch (e) { cloudMsg(e.message, 'err'); return; }
  closeCloudModal(); renderPlanMenu();
}
function openPlanMenu() { renderPlanMenu(); $('#planMenu').hidden = false; $('#planMenuBtn').setAttribute('aria-expanded', 'true'); }
function closePlanMenu() { $('#planMenu').hidden = true; $('#planMenuBtn').setAttribute('aria-expanded', 'false'); }

/* ----------------------------- recompute ---------------------------------- */
function recompute() {
  RESULTS = compute(STATE);
  setStatus('Saving…', true);
  const f = liveFns[currentView]; if (f) f();
  scheduleSave();
}

/* ----------------------------- presentation ------------------------------- */
const PRESENT_VIEWS = [['dashboard', 'Overview'], ['foundational', 'The Plan'], ['needs', 'Needs'], ['cashflow', 'Goals & Cash Flow'], ['portfolio', 'Portfolios'], ['tax', 'Taxes'], ['decision', 'What-Ifs'], ['coplanner', 'Insights']];
function clientNames() {
  const c = STATE.household.client.name || '', s = STATE.household.spouse.name || '';
  if (STATE.household.spouse.included && s) return `${c || 'Client'} & ${s}`;
  return c || 'Your Family';
}
function buildPresentTabs() {
  $('#presentTabs').innerHTML = PRESENT_VIEWS.map(([v, l]) => `<button class="pt" data-view="${v}">${l}</button>`).join('');
}
function updateCover() { $('#coverClient').textContent = clientNames(); $('#coverDate').textContent = DATESTR; }
function enterPresent() {
  presentMode = true; document.body.classList.add('present');
  $('#presentBar').hidden = false; buildPresentTabs(); updateCover(); $('#coverSlide').hidden = false;
}
function exitPresent() {
  presentMode = false; document.body.classList.remove('present');
  $('#presentBar').hidden = true; $('#coverSlide').hidden = true;
  $$('.view').forEach(s => s.classList.remove('present-active'));
  showView(currentView);
}
function showPresentView(v) {
  currentView = v;
  if (builders[v]) { builders[v](); built[v] = true; }   /* rebuild input scaffolding so shared fields stay in sync across modules */
  const f = liveFns[v]; if (f) f();
  $$('.view').forEach(s => s.classList.toggle('present-active', s.dataset.view === v));
  $$('#presentTabs .pt').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  window.scrollTo(0, 0);
}

/* ----------------------------- privacy / safe ----------------------------- */
function togglePrivacy(force) {
  const on = force != null ? force : !document.body.classList.contains('privacy');
  document.body.classList.toggle('privacy', on);
  $('#privacyBtn').setAttribute('aria-pressed', String(on));
  const pb = $('#presentPrivacy'); if (pb) pb.classList.toggle('on', on);
}
const openSafe = () => { $('#safeScreen').hidden = false; };
const closeSafe = () => { $('#safeScreen').hidden = true; };

/* ----------------------------- report / print ----------------------------- */
function openReport() { $('#reportControls').innerHTML = reportControlsHTML(); $('#reportModal').hidden = false; }
function closeReport() { $('#reportModal').hidden = true; }
function reportControlsHTML() {
  const secs = [['summary', 'Plan summary & net worth'], ['retirement', 'Retirement outlook'], ['cashflow', 'Cash-flow projection'], ['portfolio', 'Portfolio comparison'], ['tax', 'Tax planning'], ['goals', 'Goals funding'], ['needs', 'Needs analysis'], ['insights', 'CoPlanner insights'], ['disclosures', 'Important disclosures']];
  return `<div class="rep-opt"><input type="radio" name="repcopy" value="client" id="rc-client" checked>
      <div class="ro-text"><strong>Client copy</strong><span>Polished deliverable — excludes private advisor notes.</span></div></div>
    <div class="rep-opt"><input type="radio" name="repcopy" value="advisor" id="rc-advisor">
      <div class="ro-text"><strong>Advisor copy</strong><span>Adds a confidential page with your private notes.</span></div></div>
    <div class="section-label" style="margin:.8rem 0 .2rem">Include sections</div>
    <label class="rep-opt"><input type="checkbox" data-sec="cover" checked><div class="ro-text"><strong>Cover page</strong></div></label>
    ${secs.map(([k, l]) => `<label class="rep-opt"><input type="checkbox" data-sec="${k}" checked><div class="ro-text"><strong>${l}</strong></div></label>`).join('')}
    <p class="i-action" style="margin-top:.7rem">Tip: in the print dialog choose <b>“Save as PDF”</b> to keep a copy, or print for the meeting. Privacy blur is automatically removed on the printed copy.</p>`;
}
const rpHead = title => `<div class="rp-head"><div class="rh-title">${title}</div><div class="rh-brand">Matthew Pindoley, SE-AWMA®<br>Wealth, Engineered for Generations</div></div>`;
const rpFoot = `<div class="rp-foot"><span>Prepared ${DATESTR} · Confidential — for discussion with your advisor</span><span>Matthew Pindoley, SE-AWMA®</span></div>`;
const rpStat = (l, v, n) => `<div class="rp-stat"><div class="rs-l">${l}</div><div class="rs-v amount">${v}</div>${n ? `<div class="rs-n">${n}</div>` : ''}</div>`;
function rpNetWorth(R) {
  const a = (STATE.assets || []).map(x => `<tr><td>${escapeHtml(x.name)}</td><td>${(ASSET_TYPES.find(t => t[0] === x.type) || [, x.type])[1]}</td><td class="amount">${fmt$(x.balance)}</td></tr>`).join('');
  const l = (STATE.liabilities || []).map(x => `<tr><td>${escapeHtml(x.name)}</td><td>${(LIAB_TYPES.find(t => t[0] === x.type) || [, x.type])[1]}</td><td class="amount">(${fmt$(x.balance)})</td></tr>`).join('');
  return `<table class="rp-tbl"><thead><tr><th style="text-align:left">Holding</th><th style="text-align:left">Type</th><th>Value</th></tr></thead>
    <tbody>${a}${l}</tbody><tfoot><tr><td style="text-align:left">Net Worth</td><td></td><td class="amount">${fmt$(R.netWorth)}</td></tr></tfoot></table>`;
}
function buildReport(opts) {
  const R = RESULTS, pages = [];
  if (opts.cover) pages.push(`<div class="report-page cover"><div class="rp-cover">
    <div class="rc-eyebrow">A Financial Plan Prepared For</div>
    <div class="rc-client">${escapeHtml(clientNames())}</div><div class="rc-rule"></div>
    <div class="rc-advisor">Matthew Pindoley, SE-AWMA®</div>
    <div class="rc-tag">Wealth, Engineered for Generations</div>
    <div class="rc-date">${DATESTR}</div></div></div>`);
  if (opts.summary) pages.push(`<div class="report-page">${rpHead('Plan Summary')}
    <div class="rp-grid">${rpStat('Net Worth', fmt$(R.netWorth))}${rpStat('Investable Assets', fmt$(R.investable))}${rpStat('Retirement Funded', pct(R.fundedRatio * 100, 0))}${rpStat('Protection', R.protGap > 0 ? 'Gap ' + fmtK(R.protGap) : 'Covered')}</div>
    <div class="rp-section-title">Net Worth</div>${rpNetWorth(R)}
    <div class="rp-section-title">Asset Allocation</div><div class="rp-chart">${R.alloc.length ? donut(R.alloc, { size: 180 }) : '<p class="rp-note">No investable assets entered.</p>'}</div>${rpFoot}</div>`);
  if (opts.retirement) {
    const sources = [{ label: 'Social Security / Pension', value: R.guaranteedAtRet, color: 'var(--ink)' }, { label: 'Portfolio withdrawals', value: Math.max(0, R.needAtRet - R.guaranteedAtRet), color: 'var(--gold)' }];
    const mc = getMonteCarlo(), sPct = Math.round(mc.success * 100);
    pages.push(`<div class="report-page">${rpHead('Retirement Outlook')}
      <div class="rp-grid">${rpStat('Probability of Success', sPct + '%', `${mc.trials} simulations`)}${rpStat('Capital Needed', fmt$(R.capitalNeeded), R.alreadyRetired ? 'remaining lifetime' : '')}${rpStat(R.alreadyRetired ? 'Current Portfolio' : 'Projected at Retirement', fmt$(R.projAtRet))}${rpStat(R.surplus >= 0 ? 'Surplus' : 'Shortfall', fmt$(Math.abs(R.surplus)))}</div>
      <div class="rp-chart">${bandChart(mc.ages, mc.p10, mc.p50, mc.p90, { markers: [{ x: R.retAge, label: 'Retire ' + R.retAge }], w: 760, h: 210 })}</div>
      <p class="rp-note">Across ${mc.trials} randomized market simulations, the plan funds the full lifestyle through age ${R.life} in <b>${sPct}%</b> of outcomes. The shaded band shows the 10th–90th percentile range of portfolio values; the line is the median. ${R.depletionAge != null ? `On the deterministic (average-return) path, assets deplete at age <b>${R.depletionAge}</b>.` : `On the deterministic path, the estimated ending balance is <b>${fmt$(R.endingBalance)}</b>.`}</p>
      <div class="rp-section-title">Projected First-Year Retirement Income</div><div class="rp-chart">${donut(sources, { size: 160 })}</div>${rpFoot}</div>`);
  }
  if (opts.cashflow) {
    const rows = CF_GRANULARITY === 'five'
      ? R.rows.filter(r => r.t % 5 === 0 || r.age === R.retAge || r.age === R.endAge)
      : R.rows;
    const PER_PAGE = 28, nPages = Math.ceil(rows.length / PER_PAGE) || 1;   // paginate every-year tables across sheets
    for (let pi = 0; pi < rows.length; pi += PER_PAGE) {
      const chunk = rows.slice(pi, pi + PER_PAGE), pageNo = Math.floor(pi / PER_PAGE) + 1, last = pi + PER_PAGE >= rows.length;
      pages.push(`<div class="report-page">${rpHead('Cash-Flow Projection' + (nPages > 1 ? ` · ${pageNo} of ${nPages}` : ''))}
      <table class="rp-tbl"><thead><tr><th style="text-align:left">Age</th><th style="text-align:left">Phase</th><th>Income</th><th>Spending</th><th>Taxes</th><th>Saved / Drawn</th><th>Portfolio</th></tr></thead><tbody>
      ${chunk.map(r => { const flow = r.phase === 'work' ? (r.savedToAccounts || 0) : -(r.withdrawal || 0); return `<tr><td style="text-align:left">${r.age}</td><td style="text-align:left">${r.phase === 'work' ? 'Working' : 'Retired'}</td><td class="amount">${fmtK(r.income)}</td><td class="amount">${fmtK(r.need)}</td><td class="amount">${fmtK(r.taxes)}</td><td class="amount">${flow >= 0 ? '+' : '−'}${fmtK(Math.abs(flow))}</td><td class="amount">${fmtK(r.end)}</td></tr>`; }).join('')}
      </tbody></table>${last ? `<p class="rp-note">Values are nominal (future dollars), reflecting ${pct(STATE.assumptions.inflation, 1)} assumed inflation.</p>` : ''}${rpFoot}</div>`);
    }
  }
  if (opts.tax) {
    const now = R.taxNow || {}, grossNow = (now.wages || 0) + (now.ss || 0) + (now.pension || 0) + (now.rmd || 0);
    const ages = new Set([R.curAge, R.retAge, +STATE.assumptions.rmdStartAge, R.life]);
    for (let a = R.curAge; a <= R.endAge; a += 10) ages.add(a);
    const taxRows = R.rows.filter(r => ages.has(r.age)).slice(0, 8);
    pages.push(`<div class="report-page">${rpHead('Tax Planning')}
      <div class="rp-grid">${rpStat('Tax This Year', fmt$(now.taxes || 0))}${rpStat('Effective Rate', pct(grossNow > 0 ? now.taxes / grossNow * 100 : 0, 1))}${rpStat('Marginal Bracket', pct((now.marginal || 0) * 100, 0))}${rpStat('Lifetime Taxes', fmtK(R.lifetimeTax))}</div>
      <div class="rp-chart">${lineChart([{ name: 'tax', color: 'var(--gold)', fill: 'var(--gold)', points: R.rows.map(r => ({ x: r.age, y: r.taxes })) }], { markers: [{ x: R.retAge, label: 'Retire' }], w: 760, h: 150 })}</div>
      <p class="rp-note">Projected lifetime taxes total <b>${fmt$(R.lifetimeTax)}</b> (${fmt$(R.lifetimeFedTax)} federal, ${fmt$(R.lifetimeStateTax)} state). RMDs begin at age ${STATE.assumptions.rmdStartAge}.</p>
      <table class="rp-tbl"><thead><tr><th style="text-align:left">Age</th><th>AGI</th><th>Taxable</th><th>RMD</th><th>Total Tax</th><th>Marginal</th></tr></thead><tbody>
      ${taxRows.map(r => `<tr><td style="text-align:left">${r.age}</td><td class="amount">${fmtK(r.agi)}</td><td class="amount">${fmtK(r.taxableIncome)}</td><td class="amount">${fmtK(r.rmd)}</td><td class="amount">${fmtK(r.taxes)}</td><td>${pct(r.marginal * 100, 0)}</td></tr>`).join('')}
      </tbody></table>
      <p class="rp-note" style="font-size:8pt">Simplified ${new Date().getFullYear()} estimates — not tax advice. See disclosures. Coordinate with the client’s CPA.</p>${rpFoot}</div>`);
  }
  if (opts.goals) pages.push(`<div class="report-page">${rpHead('Goals Funding')}
    ${R.goals.map(g => `<div style="margin-bottom:10pt"><div style="display:flex;justify-content:space-between;font-size:10pt;font-weight:600"><span>${escapeHtml(g.name)} — ${g.priority || ''} priority</span><span class="amount">${fmtK(g.projected)} / ${fmtK(g.target)} · ${pct(g.ratio * 100, 0)}</span></div>
      <div style="height:8px;background:#eee;border-radius:99px;overflow:hidden;margin-top:3pt"><div style="height:100%;width:${clamp(g.ratio, 0, 1) * 100}%;background:${g.ratio >= 1 ? 'var(--good)' : g.ratio >= 0.8 ? 'var(--warn)' : 'var(--gold)'}"></div></div>
      ${g.reqMonthly > 0 ? `<div class="rp-note">Requires about ${fmt$(g.reqMonthly)}/mo of additional savings to fully fund.</div>` : ''}</div>`).join('')}${rpFoot}</div>`);
  if (opts.needs) pages.push(`<div class="report-page">${rpHead('Needs Analysis')}
    <div class="rp-grid two">${rpStat('Education — Total Cost', fmt$(R.eduFuture))}${rpStat('Education — Projected', fmt$(R.eduProjected), R.eduGap > 0 ? 'Gap ' + fmt$(R.eduGap) : 'On track')}</div>
    <div class="rp-grid two">${rpStat('Protection — Total Need', fmt$(R.totalProtNeed))}${rpStat('Protection — Gap', R.protGap > 0 ? fmt$(R.protGap) : 'Covered')}</div>${rpFoot}</div>`);
  if (opts.portfolio) {
    const P = STATE.portfolios, res = plRunNow();                     // cached when the Lab was just open
    const pMode = P.settings.mode || 'plan';
    const one = (label, r) => {
      if (!r) return '';
      const s = r.stats, cls = Object.keys(s.byClass).map(k => `${ASSET_CLASSES[k].label} ${pct(s.byClass[k] * 100, 0)}`).join(' · ');
      const line = pMode === 'plan'
        ? `Probability of success <b>${Math.round(r.mc.success * 100)}%</b> · median ending estate <b>${fmtK(r.mc.endP50)}</b> · bad markets (10th pct.) ${r.mc.endP10 > 0 ? fmtK(r.mc.endP10) : 'funds to age ' + (r.mc.deplP10 > r.mc.lastAge ? r.mc.lastAge + '+' : r.mc.deplP10)}`
        : pMode === 'withdraw'
        ? `Drawing ${fmt$(r.w.wd0)}/yr from ${fmtK(r.w.start)}: income lasts the full ${r.w.years} years in <b>${Math.round(r.w.success * 100)}%</b> of markets · median ending ${fmtK(r.w.endP50)} · sustainable draw at 90% confidence ≈ <b>${fmt$(r.swr || 0)}/yr</b> (${pct(r.w.start > 0 ? (r.swr || 0) / r.w.start * 100 : 0, 1)})`
        : `Median outcome <b>${fmtK(r.g.endP50)}</b> · range ${fmtK(r.g.endP10)}–${fmtK(r.g.endP90)} · ${pct(r.g.lossProb * 100, 0)} chance below invested`;
      return `<div class="rp-insight"><h4>${escapeHtml(label)} — expected ${pct(s.mean * 100, 1)} / ±${pct(s.vol * 100, 1)}</h4>
        <div>${(s.holdings || []).map(h => `${h.ticker} ${pct(h.w * 100, 0)}`).join(' · ')}</div>
        <div style="margin-top:2pt;color:#555">${cls}</div>
        <div class="rpi-act" style="margin-top:3pt">${line}</div></div>`;
    };
    const noteBy = { plan: `Each portfolio was tested through the full financial plan — spending, guaranteed income, taxes, and required distributions — across ${+P.settings.trials || 800} randomized market simulations.`,
      withdraw: `Each portfolio funds an inflation-adjusted annual withdrawal across ${+P.settings.trials || 1200} randomized market simulations, with the sustainable draw found at 90% confidence.`,
      growth: 'Each portfolio compounds a starting amount across 1,500 randomized simulations (no plan cash flows).' };
    if (res.current || res.proposed) pages.push(`<div class="report-page">${rpHead('Portfolio Comparison')}
      <p class="rp-note">${noteBy[pMode]}</p>
      ${one(P.current.name || 'Current portfolio', res.current)}
      ${one(P.proposed.name || 'Proposed portfolio', res.proposed)}
      <p class="rp-disclaimer">Ticker figures are long-run capital-market planning assumptions by asset class — not live market data, past performance, or a guarantee. Single securities carry the asset class’s expected return with concentrated risk.</p>${rpFoot}</div>`);
  }
  if (opts.insights) pages.push(`<div class="report-page">${rpHead('CoPlanner Insights & Actions')}
    ${buildInsights(R).map(i => `<div class="rp-insight"><h4>${escapeHtml(i.title)}</h4><div>${i.detail}</div>${i.action ? `<div class="rpi-act">→ ${i.action}</div>` : ''}</div>`).join('')}${rpFoot}</div>`);
  if (opts.advisor && (STATE.advisorNotes || '').trim()) pages.push(`<div class="report-page">${rpHead('Advisor Notes — Confidential')}
    <p class="rp-note" style="white-space:pre-wrap;font-size:10pt">${escapeHtml(STATE.advisorNotes)}</p>${rpFoot}</div>`);
  if (opts.disclosures) pages.push(`<div class="report-page">${rpHead('Important Disclosures')}
    <p class="rp-disclaimer">This analysis is a hypothetical illustration based solely on the data and assumptions provided, prepared for discussion purposes. It is not a guarantee or projection of actual results. Investment returns, inflation, tax rates, life expectancy, and Social Security benefits are estimates that will vary, and actual results may differ materially. Taxes are estimated using ${new Date().getFullYear()} federal brackets (inflated forward), standard deductions, long-term capital-gains rates, Social Security taxation rules, and a flat state rate; they exclude credits, AMT, NIIT, IRMAA, and itemized deductions. This material does not constitute investment, tax, or legal advice. Please consult your advisor and qualified tax/legal professionals before acting. Assumptions used: inflation ${pct(STATE.assumptions.inflation, 1)}, pre-retirement return ${pct(STATE.assumptions.preReturn, 1)}, retirement return ${pct(STATE.assumptions.postReturn, 1)}, state income tax ${pct(STATE.assumptions.stateTaxRate, 1)}.</p>${rpFoot}</div>`);
  $('#reportRoot').innerHTML = pages.join('');
}
function doPrint() {
  const copy = ($('input[name="repcopy"]:checked') || {}).value || 'client';
  const opts = { advisor: copy === 'advisor' };
  $$('#reportControls [data-sec]').forEach(cb => opts[cb.getAttribute('data-sec')] = cb.checked);
  opts.cover = ($('#reportControls [data-sec="cover"]') || { checked: true }).checked;
  buildReport(opts); closeReport();
  setTimeout(() => window.print(), 80);
}

/* ----------------------------- list rebuilds ------------------------------ */
const rebuildAssets = () => $$('#assetsList').forEach(c => c.innerHTML = (STATE.assets || []).map(assetRow).join(''));
const rebuildPlList = pf => $$(`#plList-${pf}`).forEach(c => c.innerHTML = (STATE.portfolios[pf].holdings || []).map((h, i) => plHoldingRow(pf, h, i)).join(''));
const rebuildLiabs  = () => $$('#liabList').forEach(c => c.innerHTML = (STATE.liabilities || []).map(liabRow).join(''));
const rebuildGoals  = () => $$('#goalsList').forEach(c => c.innerHTML = (STATE.goals || []).map(goalRow).join(''));
const rebuildEvents = () => $$('#eventsList').forEach(c => c.innerHTML = (STATE.events || []).map(eventRow).join(''));

/* ----------------------------- actions ------------------------------------ */
function handleAction(action, el) {
  const idx = el.dataset.idx != null ? +el.dataset.idx : null;
  switch (action) {
    case 'toggle-plan-menu': $('#planMenu').hidden ? openPlanMenu() : closePlanMenu(); break;
    case 'open-plan': switchPlan(el.dataset.id); break;
    case 'del-plan': if (confirm('Delete this client plan? This cannot be undone.')) deletePlan(el.dataset.id); break;
    case 'new-plan': closePlanMenu(); newPlan(); toast('New plan created'); break;
    case 'new-sample': closePlanMenu(); newPlan(ensureDefaults(sampleState())); toast('Sample plan loaded'); break;
    case 'duplicate': closePlanMenu(); duplicatePlan(); break;
    case 'export': exportPlan(); break;
    case 'import': $('#importFile').click(); break;
    case 'cloud-open': closePlanMenu(); openCloudModal(); break;
    case 'cloud-close': closeCloudModal(); break;
    case 'cloud-copy-sql': navigator.clipboard && navigator.clipboard.writeText(CLOUD_SETUP_SQL).then(() => toast('SQL copied')).catch(() => toast('Select and copy the SQL manually')); break;
    case 'cloud-save-cfg': {
      const url = ($('#cloudUrl') || {}).value || '', anon = ($('#cloudAnon') || {}).value || '';
      if (!/^https:\/\/.+/.test(url.trim()) || anon.trim().length < 20) { toast('Enter a valid https Project URL and the anon key'); break; }
      setCloudCfg(url, anon); Cloud.status = 'signedout'; renderCloudModal(); renderPlanMenu(); break;
    }
    case 'cloud-signup': {
      const email = (($('#cloudEmail') || {}).value || '').trim(), pass = ($('#cloudPass') || {}).value || '';
      if (!email || pass.length < 8) { cloudMsg('Use a real email and a master password of at least 8 characters.', 'err'); break; }
      cloudMsg('Creating your account…');
      cloudSignup(email, pass).then(r => { if (r && r.needsConfirm) cloudMsg('Account created — click the link Supabase emailed you, then Log in.', 'ok'); else cloudAfterAuth(); })
        .catch(e => cloudMsg(e.message, 'err'));
      break;
    }
    case 'cloud-login': {
      const email = (($('#cloudEmail') || {}).value || '').trim(), pass = ($('#cloudPass') || {}).value || '';
      if (!email || !pass) { cloudMsg('Enter your email and master password.', 'err'); break; }
      cloudMsg('Signing in…');
      cloudLogin(email, pass).then(() => cloudAfterAuth()).catch(e => cloudMsg(e.message, 'err'));
      break;
    }
    case 'cloud-unlock': {
      const pass = ($('#cloudPass') || {}).value || '';
      if (!pass) { cloudMsg('Enter your master password.', 'err'); break; }
      cloudMsg('Unlocking…');
      cloudUnlock(pass).then(() => cloudAfterAuth()).catch(e => cloudMsg(e.message, 'err'));
      break;
    }
    case 'cloud-sync':
      if (Cloud.status !== 'ready') { openCloudModal(); break; }
      toast('Syncing…'); cloudAfterAuth();
      break;
    case 'cloud-logout': clearCloudSess(); Cloud.status = cloudCfg() ? 'signedout' : 'off'; renderCloudModal(); renderPlanMenu(); toast('Signed out of cloud sync'); break;
    case 'cloud-reset-cfg': if (confirm('Forget this Supabase project on this device? Your plans stay on this computer; you can set up sync again anytime.')) { localStorage.removeItem(CLOUD_CFG_KEY); clearCloudSess(); Cloud.status = 'off'; renderCloudModal(); renderPlanMenu(); } break;
    case 'add-asset': (STATE.assets = STATE.assets || []).push({ id: uid(), name: '', type: 'taxable', balance: 0, contribution: 0, growth: '' }); rebuildAssets(); recompute(); break;
    case 'del-asset': STATE.assets.splice(idx, 1); rebuildAssets(); recompute(); break;
    case 'add-liab': (STATE.liabilities = STATE.liabilities || []).push({ id: uid(), name: '', type: 'auto', balance: 0, rate: 6, payment: 0 }); rebuildLiabs(); recompute(); break;
    case 'del-liab': STATE.liabilities.splice(idx, 1); rebuildLiabs(); recompute(); break;
    case 'add-goal': (STATE.goals = STATE.goals || []).push({ id: uid(), name: 'New Goal', type: 'purchase', priority: 'Medium', amount: 50000, years: 5, buyAge: 0, funded: 0, monthly: 0, onPlan: true }); rebuildGoals(); recompute(); break;
    case 'del-goal': STATE.goals.splice(idx, 1); rebuildGoals(); recompute(); break;
    case 'add-event': (STATE.events = STATE.events || []).push({ id: uid(), type: el.dataset.type || 'expense', label: '', amount: 25000, atAge: (RESULTS.curAge || 50) + 5, startAge: (RESULTS.curAge || 50) + 5, years: 3 }); rebuildEvents(); recompute(); break;
    case 'del-event': STATE.events.splice(idx, 1); rebuildEvents(); recompute(); break;
    case 'goto': showView(el.dataset.view); break;
    case 'wd-move': {
      const ws = STATE.withdrawalStrategy = STATE.withdrawalStrategy || { mode: 'sequential', order: ['taxable', 'traditional', 'roth'] };
      if (!ws.order || ws.order.length !== 3) ws.order = ['taxable', 'traditional', 'roth'];
      const i = ws.order.indexOf(el.dataset.key), j = i + (+el.dataset.dir);
      if (i >= 0 && j >= 0 && j < 3) { const o = ws.order.slice(); [o[i], o[j]] = [o[j], o[i]]; ws.order = o; }
      built[currentView] = false; RESULTS = compute(STATE); showView(currentView); scheduleSave(); break;
    }
    case 'cf-granularity': CF_GRANULARITY = el.dataset.mode === 'five' ? 'five' : 'all'; liveCashflow(); break;
    case 'set-exp-mode': {
      const m = el.dataset.mode, E = STATE.expenses;
      if (m === 'detailed' && Object.values(E.budget || {}).reduce((s, v) => s + (+v || 0), 0) === 0 && (+E.annualExpenses || 0) > 0) {
        const mo = (+E.annualExpenses) / 12; Object.keys(BUDGET_TEMPLATE).forEach(k => E.budget[k] = Math.round(mo * BUDGET_TEMPLATE[k]));
      }
      if (m === 'simple') E.annualExpenses = livingExpenses(E);
      E.expenseMode = m; built[currentView] = false; RESULTS = compute(STATE); showView(currentView); scheduleSave(); break;
    }
    case 'set-sav-mode': {
      const m = el.dataset.mode, SV = STATE.savings, gi = RESULTS.grossIncome || 0;
      if (m === 'percent' && (+SV.savingsRatePct || 0) === 0 && (+SV.annualSavings || 0) > 0 && gi > 0) SV.savingsRatePct = +((+SV.annualSavings) / gi * 100).toFixed(1);
      if (m === 'dollar' && (+SV.annualSavings || 0) === 0 && (+SV.savingsRatePct || 0) > 0 && gi > 0) SV.annualSavings = Math.round((+SV.savingsRatePct) / 100 * gi);
      SV.mode = m; built[currentView] = false; RESULTS = compute(STATE); showView(currentView); scheduleSave(); break;
    }
    case 'pl-add': { const pf = el.dataset.pf; STATE.portfolios[pf].holdings.push({ id: uid(), ticker: '', weight: 0 }); rebuildPlList(pf); scheduleSave(); break; }
    case 'pl-del': { const pf = el.dataset.pf; STATE.portfolios[pf].holdings.splice(+el.dataset.idx, 1); built.portfolio = false; showView('portfolio'); scheduleSave(); break; }
    case 'pl-normalize': {                                             // scale weights so they total exactly 100
      const pf = el.dataset.pf, hs = STATE.portfolios[pf].holdings.filter(h => (+h.weight || 0) > 0);
      const tot = hs.reduce((s, h) => s + (+h.weight || 0), 0);
      if (tot > 0) hs.forEach(h => h.weight = +((+h.weight) / tot * 100).toFixed(1));
      built.portfolio = false; showView('portfolio'); scheduleSave(); break;
    }
    case 'pl-mode': {
      const st = STATE.portfolios.settings;
      st.mode = ['plan', 'withdraw', 'growth'].includes(el.dataset.mode) ? el.dataset.mode : 'plan';
      if (st.mode !== 'plan' && !(+st.start > 0)) st.start = RESULTS.investable || 0;   // seed with the client's investable so the field shows what runs
      built.portfolio = false; showView('portfolio'); scheduleSave(); break;
    }
    case 'pl-wdtype': STATE.portfolios.settings.wdType = el.dataset.mode === 'dollar' ? 'dollar' : 'pct'; built.portfolio = false; showView('portfolio'); scheduleSave(); break;
    case 'pl-retbasis': STATE.portfolios.settings.retBasis = ['forward', 'h20', 'hlife'].includes(el.dataset.mode) ? el.dataset.mode : 'forward'; built.portfolio = false; showView('portfolio'); scheduleSave(); break;
    case 'pl-tab': PL_TAB = el.dataset.pf === 'proposed' ? 'proposed' : 'current'; built.portfolio = false; showView('portfolio'); break;
    case 'pl-entry': {                                                 // toggle how a portfolio is entered: % weights ⇄ $ amounts
      const pf = el.dataset.pf, P = STATE.portfolios[pf]; if (!P) break;
      const to = el.dataset.mode === 'dollar' ? 'dollar' : 'pct', from = P.entryMode === 'dollar' ? 'dollar' : 'pct';
      if (to === from) break;
      const hs = P.holdings || [];
      if (to === 'dollar') {                                          // % → $ : spread a notional total across the current weights
        const base = +STATE.portfolios.settings.start > 0 ? +STATE.portfolios.settings.start : (RESULTS.investable || 1000000);
        const totW = hs.reduce((s, h) => s + (+h.weight || 0), 0) || 100;
        hs.forEach(h => h.amount = Math.round(base * (+h.weight || 0) / totW));
      } else {                                                        // $ → % : normalize amounts back to weights
        const tot = hs.reduce((s, h) => s + (+h.amount || 0), 0);
        if (tot > 0) hs.forEach(h => h.weight = +((+h.amount || 0) / tot * 100).toFixed(2));
      }
      P.entryMode = to; built.portfolio = false; showView('portfolio'); scheduleSave(); break;
    }
    case 'pl-paste-toggle': { const box = $(`#plPaste-${el.dataset.pf}`); if (box) { box.hidden = !box.hidden; if (!box.hidden) { const ta = $(`#plPasteText-${el.dataset.pf}`); if (ta) ta.focus(); } } break; }
    case 'pl-paste-import': {
      const pf = el.dataset.pf, ta = $(`#plPasteText-${pf}`);
      const parsed = plParsePaste(ta ? ta.value : '');
      if (!parsed.holdings.length) { toast('Nothing recognized — one holding per line, ticker in (parentheses) or first'); break; }
      STATE.portfolios[pf].holdings = parsed.holdings;
      STATE.portfolios[pf].entryMode = parsed.dollar ? 'dollar' : 'pct';
      const known = parsed.holdings.filter(h => tickerLookup(h.ticker)).length;
      built.portfolio = false; showView('portfolio'); scheduleSave();
      toast(`Imported <b>${parsed.holdings.length}</b> holdings as ${parsed.dollar ? '$ amounts' : '% weights'} (${known} recognized${known < parsed.holdings.length ? ', ' + (parsed.holdings.length - known) + ' need a class' : ''})`);
      break;
    }
    case 'pl-apply': {                                                 // adopt this portfolio's return & risk as the plan's assumptions
      const pf = el.dataset.pf, stats = portfolioStats(plHoldings(pf)); if (!stats) break;
      const A = STATE.assumptions, r = +(stats.mean * 100).toFixed(1), v = +(stats.vol * 100).toFixed(1);
      A.preReturn = r; A.postReturn = r;                              // one portfolio return now drives both phases of the plan
      A.volatilityPre = v; A.volatilityPost = v;
      let cleared = 0;                                                 // clear per-account growth overrides so none silently overrides the applied return
      if (STATE.savings && STATE.savings.mode === 'accounts') (STATE.assets || []).forEach(a => { if (a.growth != null && a.growth !== '') { delete a.growth; cleared++; } });
      recompute();
      toast(`Plan now runs on <b>${escapeHtml(STATE.portfolios[pf].name || pf)}</b> — ${pct(stats.mean * 100, 1)} return · ±${pct(stats.vol * 100, 1)} risk${cleared ? ` · ${cleared} account growth override${cleared > 1 ? 's' : ''} cleared` : ''}`);
      break;
    }
    case 'acct-contrib-mode': {                                        // per-account: contribute $/mo vs % of salary
      const a = (STATE.assets || [])[+el.dataset.idx]; if (!a) break;
      const m = el.dataset.mode, wages = ownerWagesNow(a.owner || (a.type === 'traditional' || a.type === 'roth' ? 'client' : 'household'));
      if (m === 'pct' && (+a.contribPct || 0) === 0 && (+a.contribution || 0) > 0 && wages > 0) a.contribPct = +(((+a.contribution) * 12) / wages * 100).toFixed(1);
      if (m === 'dollar' && (+a.contribution || 0) === 0 && (+a.contribPct || 0) > 0 && wages > 0) a.contribution = Math.round(wages * (+a.contribPct) / 100 / 12);
      a.contribMode = m; rebuildAssets(); recompute(); break;
    }
    case 'open-report': openReport(); break;
    case 'reset-scenario': SCENARIO = { retireDelta: 0, savingsMult: 1, returnDelta: 0, spendDelta: 0, ssDelta: 0, insuranceMult: 1, ltcCoverage: 0 }; built.decision = false; showView('decision'); break;
    case 'seq-year': { const y = +el.dataset.y, s = seqEnsure(), i = s.downYears.indexOf(y); if (i >= 0) s.downYears.splice(i, 1); else s.downYears.push(y); renderSeqRisk(); break; }
    case 'seq-holdavg': { const s = seqEnsure(); s.holdAvg = !s.holdAvg; renderSeqRisk(); break; }
    case 'seq-reset': SEQ = seqDefaults(); renderSeqRisk(); break;
    case 'hidesec': STATE.presentation.hidden[el.dataset.key] = el.checked; scheduleSave(); recompute(); break;
    case 'save-baseline': { const snap = JSON.parse(JSON.stringify(STATE)); delete snap.baseline; STATE.baseline = snap; scheduleSave(); recompute(); toast('Baseline saved — make a change to see the impact'); break; }
    case 'build-plan': { const snap = JSON.parse(JSON.stringify(STATE)); delete snap.baseline; STATE.baseline = snap; scheduleSave(); showView('dashboard'); toast('Plan built — here’s the dashboard'); break; }
    case 'clear-baseline': delete STATE.baseline; scheduleSave(); recompute(); toast('Baseline cleared'); break;
    case 'apply-ss': setPath(STATE, 'income.' + el.dataset.key, +el.dataset.age); recompute(); toast(`Applied claim age ${el.dataset.age}`); break;
    case 'toggle-inputs': STATE.ui = STATE.ui || {}; STATE.ui.collapsed = !STATE.ui.collapsed; document.body.classList.toggle('inputs-collapsed', STATE.ui.collapsed); el.textContent = STATE.ui.collapsed ? '› Show data entry' : '‹ Hide data entry'; scheduleSave(); break;
    case 'toggle-section': {
      const id = el.dataset.section, on = !OPEN_SECTIONS.has(id);
      on ? OPEN_SECTIONS.add(id) : OPEN_SECTIONS.delete(id);
      const p = $('#sec-' + id);
      if (p) { p.classList.toggle('collapsed', !on); const h = p.querySelector('.acc-head'); if (h) h.setAttribute('aria-expanded', String(on)); }
      const nav = $(`.sx-item[data-section="${id}"]`); if (nav) nav.classList.toggle('open', on);
      break;
    }
    case 'goto-section': {
      const id = el.dataset.section; OPEN_SECTIONS.add(id);
      const p = $('#sec-' + id);
      if (p) { p.classList.remove('collapsed'); const h = p.querySelector('.acc-head'); if (h) h.setAttribute('aria-expanded', 'true'); p.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      const nav = $(`.sx-item[data-section="${id}"]`); if (nav) nav.classList.add('open');
      break;
    }
  }
}

/* ----------------------------- event wiring ------------------------------- */
function onInput(e) {
  const t = e.target;
  const readVal = el => el.hasAttribute('data-money')
    ? parseMoney(el.value) * (el.hasAttribute('data-permonth') ? 12 : 1)   // monthly-first fields store the annual figure
    : (['number', 'currency', 'percent', 'age'].includes(el.getAttribute('data-vtype') || 'text')
        ? (el.value === '' ? 0 : (isNaN(parseFloat(el.value)) ? 0 : parseFloat(el.value))) : el.value);
  if (t.matches('[data-path]')) {
    const p = t.getAttribute('data-path');
    const val = readVal(t);
    setPath(STATE, p, val);
    if (t.hasAttribute('data-permonth')) $$(`[data-echo-for="${p}"]`).forEach(el => el.innerHTML = val > 0 ? '= ' + fmt$(val) + ' per year' : '&nbsp;');
    if (p === 'household.client.name') { updateHeader(); renderPlanMenu(); }
    recompute(); return;
  }
  if (t.matches('[data-arr]')) {
    const arr = t.getAttribute('data-arr'), i = +t.getAttribute('data-idx'), key = t.getAttribute('data-key');
    if (STATE[arr] && STATE[arr][i]) STATE[arr][i][key] = readVal(t);
    if (arr === 'liabilities' && key === 'term') {                    // term → derive the amortizing monthly payment, live
      const l = STATE.liabilities[i], p = Math.round(loanPayment(+l.balance || 0, +l.rate || 0, +l.term || 0));
      if (p > 0) { l.payment = p; $$(`[data-arr="liabilities"][data-idx="${i}"][data-key="payment"]`).forEach(el => el.value = moneyDisplay(p)); }
    }
    if (arr === 'assets' && key === 'contribPct') {                   // live "$/mo today" echo under the % field
      const a = STATE.assets[i], w = ownerWagesNow(a.owner || (a.type === 'traditional' || a.type === 'roth' ? 'client' : 'household'));
      $$(`[data-acct-echo="${i}"]`).forEach(el => el.innerHTML = w > 0 ? '= ' + fmt$(w * (+a.contribPct || 0) / 100 / 12) + '/mo today' : '&nbsp;');
    }
    if (arr === 'assets' && key === 'owner') rebuildAssets();         // owner drives the %-of-salary math shown on the row
    recompute();
    if (arr === 'goals' && key === 'type') rebuildGoals();
    if (arr === 'events' && key === 'type') rebuildEvents();
    return;
  }
  if (t.matches('[data-pf]')) {                                       // Portfolio Lab holding fields
    const pf = t.getAttribute('data-pf'), i = +t.getAttribute('data-hidx'), key = t.getAttribute('data-hkey');
    const h = ((STATE.portfolios[pf] || {}).holdings || [])[i]; if (!h) return;
    h[key] = readVal(t);
    if (key === 'ticker') {
      h.ticker = String(h.ticker || '').toUpperCase(); t.value = h.ticker;
      delete h.cls; delete h.ret; delete h.vol; delete h.name;        // fresh ticker → fresh library lookup
      const r = resolveHolding(h);
      $$(`[data-pl-name="${pf}-${i}"]`).forEach(el => el.textContent = r.known ? r.name : (r.ticker ? 'Unknown ticker — pick an asset class' : 'Type a ticker (SPY, VTI, AAPL…)'));
      $$(`select[data-pf="${pf}"][data-hidx="${i}"][data-hkey="cls"]`).forEach(el => el.value = r.cls);      // sync the row in place — no rebuild, no lost focus
      $$(`input[data-pf="${pf}"][data-hidx="${i}"][data-hkey="ret"]`).forEach(el => { el.value = ''; el.placeholder = r.ret; });
      $$(`input[data-pf="${pf}"][data-hidx="${i}"][data-hkey="vol"]`).forEach(el => { el.value = ''; el.placeholder = r.vol; });
    }
    if (key === 'amount' || key === 'weight') plRefreshWeights(pf);   // live-update the derived % and the running total
    if (currentView === 'portfolio') livePortfolioLab();
    scheduleSave();
    return;
  }
  if (t.matches('[data-scn]')) {
    const k = t.getAttribute('data-scn'); SCENARIO[k] = parseFloat(t.value);
    const lbl = $('#scnv-' + k); if (lbl) lbl.textContent = fmtScn(k, SCENARIO[k]);
    liveDecision(); return;
  }
  if (t.matches('[data-dis]')) {
    const k = t.getAttribute('data-dis'); DISABILITY[k] = k === 'who' ? t.value : (+t.value || 0);
    liveDecision(); return;
  }
  if (t.matches('[data-surv]')) {
    const k = t.getAttribute('data-surv'); SURVIVOR[k] = k === 'who' ? t.value : (+t.value || 0);
    liveDecision(); return;
  }
  if (t.matches('[data-seq]')) {
    const k = t.getAttribute('data-seq'), s = seqEnsure();
    s[k] = t.type === 'checkbox' ? t.checked : (t.hasAttribute('data-money') ? parseMoney(t.value) : (parseFloat(t.value) || 0));
    if (k === 'years') { s.years = Math.max(2, Math.min(40, Math.round(s.years) || 30)); s.downYears = s.downYears.filter(y => y <= s.years); if (!s.downYears.length) s.downYears = [1]; renderSeqControls(); }
    renderSeqResults(); return;
  }
  if (t.matches('[data-dashwin-from]') || t.matches('[data-dashwin-years]')) {
    const R = RESULTS;
    if (!dashWin) dashWin = { start: R.curAge, years: R.endAge - R.curAge };
    if (t.matches('[data-dashwin-from]')) dashWin.start = +t.value || R.curAge;
    else dashWin.years = Math.max(1, +t.value || 1);
    updateDashScrub(); return;
  }
  if (t.matches('[data-scrub]')) { dashAge = +t.value; updateDashScrub(); return; }
}
function onClick(e) {
  if (!$('#planMenu').hidden && !e.target.closest('.plan-switch')) closePlanMenu();
  const pt = e.target.closest('#presentTabs .pt'); if (pt) { showPresentView(pt.dataset.view); return; }
  const surv = e.target.closest('[data-surv-toggle]');
  if (surv) { SURVIVOR.on = !SURVIVOR.on; surv.setAttribute('aria-checked', String(SURVIVOR.on)); liveDecision(); return; }
  const dis = e.target.closest('[data-dis-toggle]');
  if (dis) { DISABILITY.on = !DISABILITY.on; dis.setAttribute('aria-checked', String(DISABILITY.on)); liveDecision(); return; }
  const cfb = e.target.closest('[data-cf-break]');
  if (cfb) { toggleCfBreakdown(cfb); return; }
  const gp = e.target.closest('[data-goalplan]');
  if (gp) {
    const idx = +gp.getAttribute('data-idx'), go = STATE.goals[idx];
    if (go) { go.onPlan = !go.onPlan; gp.setAttribute('aria-checked', String(go.onPlan)); rebuildGoals(); recompute(); }
    return;
  }
  const dw = e.target.closest('[data-dashwin]');
  if (dw) {
    const v = dw.getAttribute('data-dashwin'), R = RESULTS;
    if (v === 'full') dashWin = null;
    else { const start = dashWin ? dashWin.start : (R.retAge || R.curAge); dashWin = { start: clamp(+start || R.curAge, R.curAge, R.endAge - 1), years: +v }; }
    if (currentView === 'dashboard') (presentMode ? showPresentView('dashboard') : renderDashboard());
    return;
  }
  const toggle = e.target.closest('[data-toggle]');
  if (toggle) {
    const p = toggle.getAttribute('data-toggle'), nv = !getPath(STATE, p);
    setPath(STATE, p, nv); toggle.setAttribute('aria-checked', String(nv));
    if (toggle.hasAttribute('data-rebuild')) { built[currentView] = false; RESULTS = compute(STATE); showView(currentView); scheduleSave(); }
    else recompute();
    return;
  }
  const act = e.target.closest('[data-action]'); if (act) { handleAction(act.getAttribute('data-action'), act); return; }
  const nav = e.target.closest('.navlink'); if (nav) { showView(nav.getAttribute('data-view')); }
}
function onKey(e) {
  if (/^(input|textarea|select)$/i.test(e.target.tagName)) return;
  if (e.key === 'Escape') {
    if (!$('#reportModal').hidden) return closeReport();
    if (!$('#safeScreen').hidden) return closeSafe();
    if (presentMode) return exitPresent();
    return openSafe();
  }
  const k = e.key.toLowerCase();
  if (k === 'p') togglePrivacy();
  else if (k === 'f') presentMode ? exitPresent() : enterPresent();
}
function wireEvents() {
  document.addEventListener('input', onInput);
  document.addEventListener('change', e => { if (e.target.matches('select')) onInput(e); });
  document.addEventListener('focusout', e => {
    const t = e.target; if (!t || !t.hasAttribute) return;
    if (t.hasAttribute('data-money')) t.value = moneyDisplay(parseMoney(t.value));
  });
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  $('#planMenuBtn').addEventListener('click', () => $('#planMenu').hidden ? openPlanMenu() : closePlanMenu());
  $('#privacyBtn').addEventListener('click', () => togglePrivacy());
  $('#presentBtn').addEventListener('click', enterPresent);
  $('#reportBtn').addEventListener('click', openReport);
  $('#safeBtn').addEventListener('click', openSafe);
  $('#safeResume').addEventListener('click', closeSafe);
  $('#coverGo').addEventListener('click', () => { $('#coverSlide').hidden = true; showPresentView('dashboard'); });
  $('#presentExit').addEventListener('click', exitPresent);
  $('#presentPrivacy').addEventListener('click', () => togglePrivacy());
  $('#reportClose').addEventListener('click', closeReport);
  $('#reportClose2').addEventListener('click', closeReport);
  $('#reportPrint').addEventListener('click', doPrint);
  $('#importFile').addEventListener('change', e => { const f = e.target.files[0]; if (f) importPlan(f); e.target.value = ''; });
}

/* ----------------------------- init --------------------------------------- */
function init() {
  const store = loadStore();
  const ids = Object.keys(store.plans);
  if (store.current && store.plans[store.current]) { currentPlanId = store.current; STATE = ensureDefaults(store.plans[store.current].state); }
  else if (ids.length) { currentPlanId = ids[0]; STATE = ensureDefaults(store.plans[ids[0]].state); }
  else { currentPlanId = uid(); STATE = ensureDefaults(sampleState()); }
  RESULTS = compute(STATE);
  initCloudSession();                                                   // restore cloud session (locked until passphrase re-entered)
  wireEvents();
  saveCurrent();
  document.body.classList.toggle('inputs-collapsed', !!(STATE.ui && STATE.ui.collapsed));
  updateHeader(); renderPlanMenu();
  showView('dashboard');
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

/* === END PART 5 === */
