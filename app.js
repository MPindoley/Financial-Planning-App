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
              ssClient: 0, ssSpouse: 0, ssClaimClient: 67, ssClaimSpouse: 67, pension: 0 },
    expenses: { annualExpenses: 0, retirementExpensePct: 80, expenseMode: 'simple', budget: { housing: 0, utilities: 0, food: 0, transportation: 0, healthcare: 0, insurance: 0, personal: 0, other: 0 } },
    savings:  { annualSavings: 0, employerMatch: 0, mode: 'dollar', savingsRatePct: 0, matchPct: 0, matchLimitPct: 0, targetRatePct: 15, surplusMode: 'invest' },
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
    pensionElection: { survivorPct: 0 },
    charitableStrategy: { on: false, qcd: 0 },
    advisorNotes: '',
    estate: { legacyTarget: 0, annualGifting: 0, charitableGoal: 0, hasWill: false, hasTrust: false, hasPOA: false, hasHealthDirective: false, beneficiariesConfirmed: false, estateNote: '' },
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
  s.savings = { annualSavings: 14000, employerMatch: 5000 };
  s.savingsSplit = { pretax: 75, roth: 10, taxable: 15 };
  s.assumptions = { inflation: 2.7, preReturn: 6.5, postReturn: 4.8, eduInflation: 5, effectiveTaxRate: 22, ssCola: 2.3, stateTaxRate: 4.5, dividendYield: 1.8, taxableBasisPct: 60, rmdStartAge: 73 };
  s.events = [
    { id: uid(), type: 'college', label: 'Emma — College', startAge: 60, years: 4, amount: 35000 },
    { id: uid(), type: 'windfall', label: 'Inheritance', atAge: 70, amount: 100000 }
  ];
  s.assets = [
    { id: uid(), name: 'Cash Reserve',        type: 'cash',        balance: 35000 },
    { id: uid(), name: 'Joint Brokerage',     type: 'taxable',     balance: 90000 },
    { id: uid(), name: 'James 401(k)',        type: 'traditional', balance: 240000 },
    { id: uid(), name: 'Sarah 403(b)',        type: 'traditional', balance: 150000 },
    { id: uid(), name: 'Roth IRAs',           type: 'roth',        balance: 60000 },
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

/* ----------------------------- tax engine --------------------------------- */
/* 2026 federal parameters (IRS Rev. Proc. 2025-32), inflated forward each year. */
const TAX = {
  baseYear: 2026,
  std: { married: 32200, single: 16100, hoh: 24150 },
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
  const std = TAX.std[filing] * f;
  const wages = +o.wages || 0, pretax = +o.pretax || 0;
  const ordinaryGross = Math.max(0, wages - pretax) + (+o.pension || 0) + (+o.taxableInterest || 0) +
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
  if (o.isWorking && wages > 0) fica = Math.min(wages, TAX.ficaWageBase * f) * TAX.ficaSS + wages * TAX.ficaMed;
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
function sequenceWithdrawals(W, bTax, bDef, bRoth, basis) {
  let rem = Math.max(0, W);
  const wTax = Math.min(bTax, rem); rem -= wTax;
  const wDef = Math.min(bDef, rem); rem -= wDef;
  const wRoth = Math.min(bRoth, rem); rem -= wRoth;
  const gainFrac = bTax > 0 ? Math.max(0, bTax - basis) / bTax : 0;
  return { wTax, wDef, wRoth, gain: wTax * gainFrac, shortfall: rem };
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
  const ssClaimC = +I.ssClaimClient || clientRet, ssClaimS = +I.ssClaimSpouse || spRet;
  const curYear = new Date().getFullYear();

  const by = {}; (S.assets || []).forEach(a => by[a.type] = (by[a.type] || 0) + (+a.balance || 0));
  let bTax = (by.cash || 0) + (by.taxable || 0) + (by.other || 0);
  let bDef = (by.traditional || 0), bRoth = (by.roth || 0);
  let basis = ((A.taxableBasisPct != null ? +A.taxableBasisPct : 60) / 100) * bTax;
  let reStatic = by.realestate || 0; const eduStatic = by.education || 0;
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
    const growRate = opts.sampleReturn ? opts.sampleReturn(retired) : (retired ? post : pre);

    /* one-time balance/debt events */
    events.forEach(ev => {
      if (ev.type === 'downturn' && age === (+ev.atAge || 0)) { const k = 1 - (+ev.amount || 0) / 100; bTax *= k; bDef *= k; bRoth *= k; basis *= k; }
      if (ev.type === 'mortgagePayoff' && age === (+ev.atAge || 0)) { debts.forEach(d => { if (d.type === 'mortgage' && d.bal > 0) { bTax -= d.bal; d.bal = 0; } }); }
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
    const ssC = (age >= ssClaimC) ? (+I.ssClient || 0) * pow(1 + cola, t) : 0;
    const ssS = (spOn && spNow >= ssClaimS) ? (+I.ssSpouse || 0) * pow(1 + cola, t) : 0;
    ss = (deadClient || deadSpouse) ? Math.max(ssC, ssS) : ssC + ssS;   // survivor keeps the larger benefit
    let rowSsC = ssC, rowSsS = ssS;                                     // split that actually sums to ss (for the breakdown drill-down)
    if (deadClient || deadSpouse) { if (ssC >= ssS) { rowSsC = ss; rowSsS = 0; } else { rowSsC = 0; rowSsS = ss; } }
    let pension = retired ? (+I.pension || 0) * g * pensReduction : 0;   // pension election reduces the lifetime benefit
    if (pension > 0 && (deadClient || deadSpouse)) pension *= pensSurvPct; // survivor continuation per the election
    let disabilityInc = 0;                                              // disability income replacement (% of salary, pre-retirement)
    if (disClient) disabilityInc += (+I.clientSalary || 0) * pow(1 + salg, t) * disPct;
    if (disSpouse) disabilityInc += (+I.spouseSalary || 0) * pow(1 + salg, t) * disPct;
    const qualDiv = bTax * divYield;

    /* contributions */
    let cPretax = 0, cRoth = 0, cTaxable = 0, match = 0;
    if (anyWorking) {
      if (SV.mode === 'accounts') {                                      // per-account contributions, classified by account type
        (S.assets || []).forEach(a => {
          if (!CONTRIB_TYPES.includes(a.type)) return;
          const c = (+a.contribution || 0) * 12 * pow(1 + salg, t);
          if (a.type === 'roth') cRoth += c; else if (a.type === 'traditional') cPretax += c; else cTaxable += c;
        });
        if ((+SV.matchPct || 0) > 0 && wages > 0) {                      // employer match on 401(k)/pre-tax contributions
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
    const gOut = goalSpendYear(S.goals, age, infl, curAge, eduI);     // education / LTC / recurring goal spend on the timeline
    const need = Math.max(0, expenses - expenseCut) + debtPay + ev.out + gOut;

    let rmd = (age >= rmdAge && bDef > 0) ? bDef / rmdDivisor(age) : 0;
    const qcdAmt = (cs.on && retired && age >= rmdAge && bDef > 0) ? Math.min((+cs.qcd || 0) * g, rmd, bDef) : 0;   // QCD satisfies RMD tax-free
    const rmdHH = rmd - qcdAmt;                                          // household portion of the RMD (after charitable QCD)
    let conversion = rothConversionYear(S, { age, bDef, filing: filingY, inflFac, pension, ss, rmd: rmdHH });

    const row = { age, t, year, phase: anyWorking ? 'work' : 'retire', wages, ss, pension, rmd, conversion, expenses, need };
    let taxes, wT = 0, wD = 0, wR = 0, gain = 0, leftover = 0;

    if (anyWorking) {
      taxes = computeTax({ wages, pretax: cPretax, pension, taxableInterest: 0, qualDiv, ss, filing: filingY, stateRate, inflFac, isWorking: true });
      bDef += cPretax + match; bRoth += cRoth; bTax += cTaxable + qualDiv; basis += cTaxable + qualDiv;
      if (conversion > 0) { const cv = Math.min(conversion, bDef); bDef -= cv; bRoth += cv; conversion = cv; }
      const netCash = wages + otherInc + ss + pension + ev.in + annuityInc + disabilityInc - taxes.total - need - cPretax - cRoth - cTaxable;
      if (netCash >= 0) { leftover = netCash; if (sweepSurplus) { bTax += netCash; basis += netCash; } }   // leftover: invest it, or leave it discretionary
      else { const s = sequenceWithdrawals(-netCash, bTax, bDef, bRoth, basis); const before = bTax; bTax -= s.wTax; if (before > 0) basis *= bTax / before; bDef -= s.wDef; bRoth -= s.wRoth; wT = s.wTax; wD = s.wDef; wR = s.wRoth; }
      bTax *= 1 + growRate; bDef *= 1 + growRate; bRoth *= 1 + growRate;
    } else {
      bDef -= rmd;
      if (conversion > 0) { const cv = Math.min(conversion, bDef); bDef -= cv; bRoth += cv; conversion = cv; }
      const guaranteed = ss + pension + ev.in + annuityInc + disabilityInc;
      let W = Math.max(0, need - guaranteed - rmdHH), seq = sequenceWithdrawals(W, bTax, bDef, bRoth, basis);
      for (let i = 0; i < 8; i++) {
        const tx = computeTax({ pension, qualDiv, deferredWithdrawal: seq.wDef + rmdHH + conversion, ss, ltcgRealized: seq.gain, filing: filingY, stateRate, inflFac, isWorking: false });
        const newW = Math.max(0, need - guaranteed - rmdHH + tx.total);
        seq = sequenceWithdrawals(newW, bTax, bDef, bRoth, basis);
        if (Math.abs(newW - W) < 25) { W = newW; break; } W = newW;
      }
      taxes = computeTax({ pension, qualDiv, deferredWithdrawal: seq.wDef + rmdHH + conversion, ss, ltcgRealized: seq.gain, filing: filingY, stateRate, inflFac, isWorking: false });
      const before = bTax; bTax -= seq.wTax; if (before > 0) basis *= bTax / before; bDef -= seq.wDef; bRoth -= seq.wRoth;
      wT = seq.wTax + 0; wD = seq.wDef + rmdHH; wR = seq.wRoth; gain = seq.gain;
      bTax += qualDiv; basis += qualDiv;
      const surplus = guaranteed + rmdHH - need - taxes.total;
      if (surplus > 0) { leftover = surplus; if (sweepSurplus) { bTax += surplus; basis += surplus; } }   // guaranteed income beyond the need
      if (seq.shortfall > 1 && depletionAge === null) depletionAge = age;
      bTax *= 1 + growRate; bDef *= 1 + growRate; bRoth *= 1 + growRate;
    }
    if (bTax < 0) bTax = 0; if (bDef < 0) bDef = 0; if (bRoth < 0) bRoth = 0;
    if (basis < 0) basis = 0; if (basis > bTax) basis = bTax;
    const portfolio = bTax + bDef + bRoth, totalDebt = debts.reduce((s, d) => s + d.bal, 0);
    if (portfolio <= 1 && retired && depletionAge === null) depletionAge = age;
    lifetimeTax += taxes.total; lifetimeFedTax += taxes.fed; lifetimeStateTax += taxes.state;
    Object.assign(row, {
      taxes: taxes.total, fed: taxes.fed, state: taxes.state, fica: taxes.fica, agi: taxes.agi,
      taxableIncome: taxes.taxableIncome, ordinaryTaxable: taxes.ordinaryTaxable, marginal: taxes.marginal, ssTaxable: taxes.ssTaxable,
      contribution: cPretax + cRoth + cTaxable + match, withdrawal: wT + wD + wR,
      wTax: wT, wDef: wD, wRoth: wR, bTax, bDef, bRoth, end: portfolio, debt: totalDebt,
      reStatic, eduStatic, netWorth: portfolio + reStatic + eduStatic - totalDebt, income: wages + otherInc + ss + pension + annuityInc + disabilityInc + ev.in, annuity: annuityInc, disabilityInc, otherInc, evIn: ev.in, qcd: qcdAmt,
      cPretax, cRoth, cTaxable, match, debtPay, evOut: ev.out, goalOut: gOut,
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
function monteCarlo(S, trials) {
  trials = trials || 600;
  const A = S.assumptions;
  const pre = blendedPreReturn(S), post = A.postReturn / 100;
  const volPre = (A.volatilityPre != null ? +A.volatilityPre : 12) / 100;
  const volPost = (A.volatilityPost != null ? +A.volatilityPost : 9) / 100;
  const sampler = retired => Math.max(-0.6, randNormal(retired ? post : pre, retired ? volPost : volPre));
  const base = simulate(S);
  const ages = base.rows.map(r => r.age);
  const paths = []; let successes = 0;
  for (let i = 0; i < trials; i++) {
    const sim = simulate(S, { sampleReturn: sampler });
    if (sim.depletionAge == null) successes++;
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
  return { trials, success: successes / trials, ages,
    p10: bandAt(0.10), p50: bandAt(0.50), p90: bandAt(0.90),
    endP10: q(0.10), endP50: q(0.50), endP90: q(0.90) };
}
function mcSignature(S) {
  return JSON.stringify([S.assumptions, S.household, S.income, S.expenses, S.savings, S.savingsSplit, S.assets, S.liabilities, S.events, S.goals, S.rothStrategy, S.debtStrategy, S.survivor, S.disability, S.pensionElection, S.charitableStrategy]);
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
  const acctContrib = (S.assets || []).reduce((s, a) => s + (CONTRIB_TYPES.includes(a.type) ? (+a.contribution || 0) * 12 : 0), 0);
  const acctPretax = (S.assets || []).reduce((s, a) => s + (a.type === 'traditional' ? (+a.contribution || 0) * 12 : 0), 0);
  const baseContrib = SV.mode === 'percent' ? (+SV.savingsRatePct || 0) / 100 * grossIncome : SV.mode === 'accounts' ? acctContrib : (+SV.annualSavings || 0);
  const empMatch = SV.mode === 'percent' ? grossIncome * Math.min((+SV.savingsRatePct || 0) / 100, (+SV.matchLimitPct || 0) / 100) * ((+SV.matchPct || 0) / 100)
    : SV.mode === 'accounts' ? (grossIncome > 0 ? grossIncome * Math.min(acctPretax / grossIncome, (+SV.matchLimitPct || 0) / 100) * ((+SV.matchPct || 0) / 100) : 0)
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
  const fundedRatio = capitalNeeded > 0 ? projAtRet / capitalNeeded : (projAtRet > 0 ? 2 : 1);
  const surplus = projAtRet - capitalNeeded;
  const shortfallFV = Math.max(0, capitalNeeded - projAtRet);

  /* year-by-year simulation (taxes, three tax buckets, debt amortization, RMDs, events) */
  const sim = simulate(S);
  const rows = sim.rows;
  const endingBalance = sim.endingBalance;
  const depletionAge = sim.depletionAge;

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
  const isCur = f.type === 'currency', isPct = f.type === 'percent', isText = f.type === 'text';
  const pre = isCur ? '<span class="prefix">$</span>' : '';
  const suf = isPct ? '<span class="suffix">%</span>' : (f.suffix ? `<span class="suffix">${escapeHtml(f.suffix)}</span>` : '');
  const cls = `control ${isCur ? 'has-prefix' : ''} ${(isPct || f.suffix) ? 'has-suffix' : ''}`.trim();
  let input;
  if (isCur) {
    input = `<input type="text" inputmode="decimal" data-path="${f.path}" data-money value="${escapeAttr(moneyDisplay(v))}" placeholder="${escapeAttr(f.ph || '0')}">`;
  } else {
    const vtype = isText ? 'text' : (f.type || 'number');
    const step = isPct ? (f.step || 0.1) : (f.step || 1);
    const attrs = isText ? '' : `step="${step}" min="${f.min != null ? f.min : 0}" ${f.max != null ? `max="${f.max}"` : ''}`;
    input = `<input type="${isText ? 'text' : 'number'}" data-path="${f.path}" data-vtype="${vtype}" value="${escapeAttr(v ?? '')}" ${attrs} placeholder="${escapeAttr(f.ph || '')}">`;
  }
  return `<div class="field"><label>${escapeHtml(f.label)}${hint}</label><div class="${cls}">${pre}${input}${suf}</div></div>`;
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
    expenses: (livingExpenses(E) > 0 && (pos(SV.savingsRatePct) || pos(SV.annualSavings) || pos(SV.employerMatch))) ? 'ok' : 'todo',
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
    : field({ path: 'expenses.annualExpenses', label: 'Annual living expenses', type: 'currency' });
  return `<div class="block-head"><span class="block-title">Living expenses</span>${modeSeg('set-exp-mode', E.expenseMode || 'simple', [['simple', 'Single total'], ['detailed', 'Monthly budget']])}</div>
    <p class="budget-note">Living costs only — <b>loan &amp; mortgage payments are added automatically</b> from the Liabilities section, so don’t enter them here.</p>
    ${inputs}
    ${field({ path: 'expenses.retirementExpensePct', label: 'Retirement spending', hint: '% of today’s expenses', type: 'percent' })}`;
}
function savingsBlock() {
  const SV = STATE.savings, mode = SV.mode || 'dollar';
  const matchRow = sectionLabel('Employer 401(k) match') + fieldRow({ path: 'savings.matchPct', label: 'Match', hint: '% of your contribution', type: 'percent' }, { path: 'savings.matchLimitPct', label: 'Up to', hint: '% of pay', type: 'percent' });
  const split = sectionLabel('Where new savings go (tax treatment)') + fieldRow({ path: 'savingsSplit.pretax', label: 'Pre-tax', hint: '401k / IRA', type: 'percent' }, { path: 'savingsSplit.roth', label: 'Roth', type: 'percent' }, { path: 'savingsSplit.taxable', label: 'Taxable', type: 'percent' });
  let inputs;
  if (mode === 'percent') inputs = field({ path: 'savings.savingsRatePct', label: 'You save', hint: 'of gross income — scales as pay grows', type: 'percent' }) + matchRow + split;
  else if (mode === 'accounts') inputs = field({ path: 'savings.targetRatePct', label: 'Target savings rate', hint: '% of gross income — the goal to hit', type: 'percent' }) + matchRow
    + `<p class="budget-note">Enter the <b>monthly contribution and growth for each account</b> in the Accounts section below — totals, tax treatment, and progress to your target appear in the live panel on the right.</p>`;
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
  const contribRow = byAccount ? `<div class="rr-grid" style="grid-column:1/-1;margin-top:.5rem">
      ${canContribute
        ? `<div class="rr-cell"><label>Saving / month ($)</label><div class="control has-prefix"><span class="prefix">$</span><input type="text" inputmode="decimal" data-arr="assets" data-idx="${i}" data-key="contribution" data-money value="${moneyDisplay(a.contribution || 0)}"></div></div>
           <div class="rr-cell"><label>Growth / yr</label><div class="control has-suffix"><input type="number" step="0.1" min="0" data-arr="assets" data-idx="${i}" data-key="growth" data-vtype="percent" value="${a.growth != null && a.growth !== '' ? a.growth : ''}" placeholder="${defGrowth}"><span class="suffix">%</span></div></div>`
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
  ['meta', 'income', 'expenses', 'savings', 'savingsSplit', 'insurance', 'protection', 'assumptions', 'quickEducation', 'rothStrategy', 'debtStrategy', 'pensionElection', 'charitableStrategy', 'estate'].forEach(k => S[k] = Object.assign({}, d[k], S[k]));
  S.expenses.budget = Object.assign({}, d.expenses.budget, S.expenses.budget);   // deep-merge budget categories for older plans
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
    { label: 'RMD', value: row.rmd || 0, color: '#b08968' },
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
      ${sectionLabel('Guaranteed retirement income (annual, today’s $)')}
      ${fieldRow({ path: 'income.ssClient', label: 'Social Security — client', type: 'currency' }, spOn ? { path: 'income.ssSpouse', label: 'Social Security — spouse', type: 'currency' } : { path: 'income.pension', label: 'Pension', type: 'currency' })}
      ${fieldRow({ path: 'income.ssClaimClient', label: 'SS claim age — client', type: 'age' }, spOn ? { path: 'income.ssClaimSpouse', label: 'SS claim age — spouse', type: 'age' } : { path: 'income.pension', label: 'Pension', type: 'currency' })}
      ${spOn ? field({ path: 'income.pension', label: 'Pension', type: 'currency' }) : ''}`, { status: st.income }) +
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
  const mSave = (SV.mode === 'percent' ? (+SV.savingsRatePct || 0) / 100 * R.grossIncome : (+SV.annualSavings || 0)) / 12;
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
function savingsByAccountPanel(R) {
  if ((STATE.savings || {}).mode !== 'accounts') return '';
  const accts = (STATE.assets || []).filter(a => CONTRIB_TYPES.includes(a.type) && (+a.contribution || 0) > 0);
  if (!accts.length) return `<div style="height:1rem"></div>` + panel('Savings by Account', '<div class="empty">Switch an account on and enter a monthly contribution to see your savings broken out here.</div>', { sub: 'By account', hideKey: 'prof-sba' });
  const cls = t => t === 'roth' ? ['Roth · tax-free', 'good'] : t === 'traditional' ? ['Tax-deferred', 'gold'] : ['Taxable', 'ink'];
  const grp = { free: 0, def: 0, tax: 0 };
  accts.forEach(a => { const c = +a.contribution || 0; if (a.type === 'roth') grp.free += c; else if (a.type === 'traditional') grp.def += c; else grp.tax += c; });
  const totMo = grp.free + grp.def + grp.tax, rate = R.grossIncome > 0 ? (totMo * 12) / R.grossIncome : 0;
  const target = (+STATE.savings.targetRatePct || 0) / 100;
  const rows = accts.map(a => { const [l, t] = cls(a.type); return `<div class="cf-bd-row"><span>${escapeHtml(a.name || 'Account')} ${badge(l, t)}</span><b class="amount">${fmt$(+a.contribution || 0)}/mo</b></div>`; }).join('');
  const taxRow = (label, v, color) => v > 0 ? `<div class="cf-bd-row"><span><i class="dot" style="background:${color}"></i>${label}</span><b class="amount">${fmt$(v)}/mo</b></div>` : '';
  const msg = target > 0
    ? (rate >= target ? `✓ Hitting your ${pct(target * 100, 0)} target — saving ${fmt$(totMo)}/mo (${fmt$(totMo * 12)}/yr).`
      : `▲ ${pct((target - rate) * 100, 1)} below your ${pct(target * 100, 0)} target — about <b>${fmt$(Math.max(0, (target - rate) * R.grossIncome / 12))}/mo</b> more gets you there.`)
    : `Saving ${fmt$(totMo)}/mo (${pct(rate * 100, 1)} of income). Set a target rate in the Savings section.`;
  return `<div style="height:1rem"></div>` + panel('Savings by Account', `
    ${rows}
    <div class="section-label">By tax treatment</div>
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
    { label: 'Windfall / one-off', value: r.evIn || 0, color: 'var(--gold-2)' }
  ] };
  if (metric === 'spending') {
    const detailed = STATE.expenses.expenseMode === 'detailed';
    const livingDrill = detailed ? dl(EXP_CATS.map(([k, lab]) => ({ l: lab, v: (+STATE.expenses.budget[k] || 0) * 12 * g }))) : '<div class="cf-drill-row"><span style="color:var(--faint)">Single annual figure — switch Expenses to a budget to itemize</span></div>';
    const debtDrill = dl((STATE.liabilities || []).map(l => ({ l: escapeHtml(l.name || l.type || 'Loan') + ' (' + l.type + ')', v: (+l.payment || 0) * 12 })));
    const goalDrill = dl((STATE.goals || []).map(go => ({ l: escapeHtml(go.name || go.type), v: goalSpendYear([go], r.age, infl, curAge, (+A.eduInflation || 5) / 100) })));
    const evDrill = dl((STATE.events || []).map(e => ({ l: escapeHtml(e.label || e.type), v: applyEventsYear([e], r.age, r.t || 0, infl).out })));
    return { title: 'Spending this year', items: [
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
  return { title: 'Portfolio composition', items: [
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
    <div class="cf-bd-list">${list}</div></div>`;
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
        <div class="section-label">Retirement income sources (first year)</div>${donut(sources, { size: 160 })}`, { hideKey: 'found-ret' })}
    </div>
    <div style="height:1.1rem"></div>
    ${panel('Goal Funding', goalProgressList(R), { hideKey: 'found-goals' })}`;
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
  s.savings.annualSavings = (+s.savings.annualSavings || 0) * SCENARIO.savingsMult;
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
    `<p class="rp-disclaimer" style="margin-top:.4rem">Benefits estimated from the entered full-retirement-age (67) amount: roughly 70% at 62 and 124% at 70, grown by ${pct(STATE.assumptions.ssCola, 1)} COLA. Lifetime totals assume benefits through life expectancy; the optimal age depends on longevity, taxes, and spousal strategy — confirm with the client.</p>`,
    { sub: 'Claiming strategy', hideKey: 'dec-ss' });
}

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
      ${sectionLabel('Desired guaranteed income (annual, today’s $)')}
      ${fieldRow({ path: 'income.ssClient', label: 'Social Security — client', type: 'currency' }, { path: 'income.ssClaimClient', label: 'SS claim age — client', type: 'age' })}
      ${spOn ? fieldRow({ path: 'income.ssSpouse', label: 'Social Security — spouse', type: 'currency' }, { path: 'income.ssClaimSpouse', label: 'SS claim age — spouse', type: 'age' }) : ''}
      ${field({ path: 'income.pension', label: 'Pension', type: 'currency' })}`) +
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
const builders = { intake: buildIntake, profile: buildProfile, needs: buildNeeds, cashflow: buildCashflow, decision: buildDecision, tax: buildTax };
const liveFns = { intake: liveIntake, dashboard: renderDashboard, profile: liveProfile, needs: liveNeeds, cashflow: liveCashflow, foundational: renderFoundational, decision: liveDecision, tax: liveTax, coplanner: renderCoplanner };
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
      <button class="btn sm" data-action="import">⤒ Import JSON</button></div>`;
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
const PRESENT_VIEWS = [['dashboard', 'Overview'], ['foundational', 'The Plan'], ['needs', 'Needs'], ['cashflow', 'Goals & Cash Flow'], ['tax', 'Taxes'], ['decision', 'What-Ifs'], ['coplanner', 'Insights']];
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
  const secs = [['summary', 'Plan summary & net worth'], ['retirement', 'Retirement outlook'], ['cashflow', 'Cash-flow projection'], ['tax', 'Tax planning'], ['goals', 'Goals funding'], ['needs', 'Needs analysis'], ['insights', 'CoPlanner insights'], ['disclosures', 'Important disclosures']];
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
    pages.push(`<div class="report-page">${rpHead('Cash-Flow Projection')}
      <table class="rp-tbl"><thead><tr><th style="text-align:left">Age</th><th style="text-align:left">Phase</th><th>Income</th><th>Expenses</th><th>Save / Draw</th><th>Portfolio</th></tr></thead><tbody>
      ${rows.map(r => { const flow = r.phase === 'work' ? r.contribution : -r.withdrawal; return `<tr><td style="text-align:left">${r.age}</td><td style="text-align:left">${r.phase === 'work' ? 'Working' : 'Retired'}</td><td class="amount">${fmtK(r.income)}</td><td class="amount">${fmtK(r.expenses)}</td><td class="amount">${flow >= 0 ? '+' : '−'}${fmtK(Math.abs(flow))}</td><td class="amount">${fmtK(r.end)}</td></tr>`; }).join('')}
      </tbody></table><p class="rp-note">Values are nominal (future dollars), reflecting ${pct(STATE.assumptions.inflation, 1)} assumed inflation.</p>${rpFoot}</div>`);
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
    case 'add-asset': (STATE.assets = STATE.assets || []).push({ id: uid(), name: '', type: 'taxable', balance: 0, contribution: 0, growth: '' }); rebuildAssets(); recompute(); break;
    case 'del-asset': STATE.assets.splice(idx, 1); rebuildAssets(); recompute(); break;
    case 'add-liab': (STATE.liabilities = STATE.liabilities || []).push({ id: uid(), name: '', type: 'auto', balance: 0, rate: 6, payment: 0 }); rebuildLiabs(); recompute(); break;
    case 'del-liab': STATE.liabilities.splice(idx, 1); rebuildLiabs(); recompute(); break;
    case 'add-goal': (STATE.goals = STATE.goals || []).push({ id: uid(), name: 'New Goal', type: 'purchase', priority: 'Medium', amount: 50000, years: 5, buyAge: 0, funded: 0, monthly: 0, onPlan: true }); rebuildGoals(); recompute(); break;
    case 'del-goal': STATE.goals.splice(idx, 1); rebuildGoals(); recompute(); break;
    case 'add-event': (STATE.events = STATE.events || []).push({ id: uid(), type: el.dataset.type || 'expense', label: '', amount: 25000, atAge: (RESULTS.curAge || 50) + 5, startAge: (RESULTS.curAge || 50) + 5, years: 3 }); rebuildEvents(); recompute(); break;
    case 'del-event': STATE.events.splice(idx, 1); rebuildEvents(); recompute(); break;
    case 'goto': showView(el.dataset.view); break;
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
    case 'open-report': openReport(); break;
    case 'reset-scenario': SCENARIO = { retireDelta: 0, savingsMult: 1, returnDelta: 0, spendDelta: 0, ssDelta: 0, insuranceMult: 1, ltcCoverage: 0 }; built.decision = false; showView('decision'); break;
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
    ? parseMoney(el.value)
    : (['number', 'currency', 'percent', 'age'].includes(el.getAttribute('data-vtype') || 'text')
        ? (el.value === '' ? 0 : (isNaN(parseFloat(el.value)) ? 0 : parseFloat(el.value))) : el.value);
  if (t.matches('[data-path]')) {
    const p = t.getAttribute('data-path');
    setPath(STATE, p, readVal(t));
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
    recompute();
    if (arr === 'goals' && key === 'type') rebuildGoals();
    if (arr === 'events' && key === 'type') rebuildEvents();
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
  document.addEventListener('focusout', e => { const t = e.target; if (t && t.hasAttribute && t.hasAttribute('data-money')) t.value = moneyDisplay(parseMoney(t.value)); });
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
  wireEvents();
  saveCurrent();
  document.body.classList.toggle('inputs-collapsed', !!(STATE.ui && STATE.ui.collapsed));
  updateHeader(); renderPlanMenu();
  showView('dashboard');
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

/* === END PART 5 === */
