/* Digital Fasting tracker: Alpine.js component.
   Storage: Dexie (IndexedDB). Charts: Chart.js. Motion: anime.js. Celebrations: canvas-confetti. */
function app() {
  'use strict';
  const S = window.Scoring, SEED = window.Seed;
  const VERSION = '1.0.0';
  const db = new Dexie('digital-fasting');
  db.version(1).stores({ days: 'date', settings: 'key' });

  const reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const RING_C = 2 * Math.PI * 84;
  const PIN_RE = /^\d{4,8}$/;
  const PRIVATE_KEYS = ['pinHash', 'pinSalt', 'recoveryHash', 'seeded'];
  let charts = {};          // Chart.js instances (kept outside the reactive proxy)
  let pendingCb = null;     // action waiting for a successful PIN
  let installEvt = null;
  let failedPins = 0, lockedUntil = 0;

  const cv = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const pad2 = (n) => String(n).padStart(2, '0');

  async function hashStr(pin, salt) {
    const text = salt + ':' + pin;
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, '0')).join('');
    }
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57; // cyrb53 fallback for non-secure contexts
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 'f' + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  }
  function randomSalt() {
    const a = new Uint8Array(12); crypto.getRandomValues(a);
    return Array.from(a).map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  function newRecoveryCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const a = new Uint8Array(8); crypto.getRandomValues(a);
    const s = Array.from(a).map((x) => alphabet[x % alphabet.length]).join('');
    return s.slice(0, 4) + '-' + s.slice(4);
  }
  const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  function download(name, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function cleanEntry(raw) {
    if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date || '')) return null;
    const scores = {};
    for (const c of S.CATEGORIES) {
      let v = Number(raw.scores && raw.scores[c.key]);
      if (!isFinite(v)) return null;
      scores[c.key] = Math.min(c.max, Math.max(0, Math.round(v * 2) / 2));
    }
    const bonus = (Array.isArray(raw.bonus) ? raw.bonus : [])
      .map((b) => ({ points: Math.max(0, Number(b.points) || 0), reason: String(b.reason || '').slice(0, 80) }))
      .filter((b) => b.points > 0);
    return { date: raw.date, scores, bonus, notes: String(raw.notes || '').slice(0, 300) };
  }

  return {
    version: VERSION,
    tabs: [
      { id: 'dashboard', label: 'Home', icon: '📊' },
      { id: 'today', label: 'Today', icon: '✅' },
      { id: 'history', label: 'History', icon: '🗂️' },
      { id: 'insights', label: 'Insights', icon: '📈' },
      { id: 'settings', label: 'Settings', icon: '⚙️' }
    ],
    cats: S.CATEGORIES,
    corrections: SEED.CORRECTIONS,
    tab: 'dashboard',
    ready: false,
    settings: Object.assign({}, SEED.DEFAULTS),
    entries: [],
    rows: [],
    today: S.todayStr(),
    st: S.stats([], SEED.DEFAULTS, S.todayStr()),
    shownTotal: 0,
    toast: '',
    newRule: '',
    // parent mode
    parent: false, parentUntil: 0, lockCountdown: '',
    pin: { open: false, mode: 'enter', value: '', confirm: '', code: '', error: '', recovery: '' },
    // editor + import
    editor: null,
    importPreview: null,
    canInstall: false,

    /* ============ lifecycle ============ */
    async init() {
      if (reduced) Chart.defaults.animation = false;
      Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
      await this.loadAll();
      const t = new URLSearchParams(location.search).get('tab');
      if (t && this.tabs.some((x) => x.id === t)) this.tab = t;
      this.ready = true;
      this.$watch('tab', () => this.$nextTick(() => this.onTab()));
      this.$nextTick(() => this.onTab());
      setInterval(() => this.tick(), 1000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) this.tick(); });
      window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; this.canInstall = true; });
      window.addEventListener('appinstalled', () => { this.canInstall = false; this.say('Installed!'); });
      this.registerSW();
    },
    registerSW() {
      if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
      const had = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.register('sw.js').catch(() => {});
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (had && !reloaded) { reloaded = true; location.reload(); }
      });
    },
    async install() {
      if (!installEvt) return;
      installEvt.prompt();
      await installEvt.userChoice;
      installEvt = null; this.canInstall = false;
    },

    async loadAll() {
      let kv = await db.settings.toArray();
      if (!kv.find((r) => r.key === 'seeded')) {
        await db.transaction('rw', db.days, db.settings, async () => {
          await db.days.bulkPut(SEED.seedEntries());
          await db.settings.put({ key: 'seeded', value: true });
        });
        kv = await db.settings.toArray();
      }
      const s = Object.assign({}, SEED.DEFAULTS);
      kv.forEach((r) => { s[r.key] = r.value; });
      this.settings = s;
      await this.recompute();
    },
    async recompute() {
      this.entries = await db.days.toArray();
      this.today = S.todayStr();
      this.rows = S.ledger(this.entries, this.settings.openingBalance);
      this.st = S.stats(this.rows, this.settings, this.today);
    },
    tick() {
      if (S.todayStr() !== this.today) { this.recompute().then(() => this.onTab()); }
      if (this.parent) {
        const left = this.parentUntil - Date.now();
        if (left <= 0) { this.lockParent(true); return; }
        const s = Math.ceil(left / 1000);
        this.lockCountdown = Math.floor(s / 60) + ':' + pad2(s % 60);
      }
    },

    /* ============ navigation / animation ============ */
    go(id) { this.tab = id; window.scrollTo({ top: 0 }); try { history.replaceState(null, '', '?tab=' + id); } catch (e) {} },
    onTab() {
      if (!this.ready) return;
      if (this.tab === 'dashboard') this.animateDashboard();
      if (this.tab === 'insights') this.renderCharts();
      if (!reduced) {
        const cards = document.querySelectorAll('[data-view="' + this.tab + '"] .card');
        if (cards.length) anime.animate(cards, { opacity: [0, 1], translateY: [14, 0], delay: anime.stagger(55), duration: 500, ease: 'outQuad' });
      }
    },
    animateDashboard() {
      const el = document.getElementById('ringBar');
      const target = RING_C * (1 - Math.min(100, this.st.pct) / 100);
      const to = this.st.total;
      if (reduced || !el) {
        if (el) el.style.strokeDashoffset = target;
        this.shownTotal = to; return;
      }
      anime.animate(el, { strokeDashoffset: [RING_C, target], duration: 1400, ease: 'outExpo' });
      const o = { v: 0 };
      anime.animate(o, {
        v: to, duration: 1400, ease: 'outExpo',
        onUpdate: () => { this.shownTotal = Math.round(o.v * 2) / 2; },
        onComplete: () => { this.shownTotal = to; }
      });
    },
    refreshViews() {
      this.$nextTick(() => {
        if (this.tab === 'dashboard') this.animateDashboard();
        else this.shownTotal = this.st.total;
        if (this.tab === 'insights') this.renderCharts();
      });
    },
    say(msg) {
      this.toast = msg;
      clearTimeout(this._tt);
      this._tt = setTimeout(() => { this.toast = ''; }, 2600);
    },
    celebrate(before, after, entry) {
      if (typeof confetti !== 'function') return;
      const crossed = this.settings.milestones.find((m) => before < m && after >= m);
      const opts = { disableForReducedMotion: true, zIndex: 100 };
      if (crossed) {
        this.say('🏆 Milestone reached: ' + this.fmt(crossed) + ' points!');
        const fire = (r, o) => confetti(Object.assign({ origin: { y: 0.7 }, particleCount: Math.floor(220 * r) }, opts, o));
        fire(.25, { spread: 26, startVelocity: 55 }); fire(.2, { spread: 60 });
        fire(.35, { spread: 100, decay: .91, scalar: .8 }); fire(.1, { spread: 120, startVelocity: 25, decay: .92, scalar: 1.2 });
      } else if (S.baseTotal(entry) >= S.BASE_MAX) {
        confetti(Object.assign({ particleCount: 120, spread: 80, origin: { y: 0.7 } }, opts));
      } else if (S.dayTotal(entry) >= this.settings.goodDay) {
        confetti(Object.assign({ particleCount: 45, spread: 55, origin: { y: 0.8 } }, opts));
      }
    },

    /* ============ formatting helpers ============ */
    fmt(n) { return Number(n || 0).toLocaleString('en-GB', { maximumFractionDigits: 1 }); },
    longDate(d) { return S.parseYmd(d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); },
    shortDate(d) { return S.parseYmd(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); },
    tone(v, max) { const r = Number(v) / max; return r >= 0.85 ? 'good' : r >= 0.6 ? 'okay' : 'low'; },
    dayNumOf(d) { return S.dayNumber(d, this.settings.startDate); },
    get dayNo() { return Math.max(1, S.dayNumber(this.today, this.settings.startDate)); },

    /* ============ derived data ============ */
    get heroMessage() {
      const s = this.st;
      if (s.total >= s.goal) return '🎉 Goal reached! Amazing discipline.';
      if (!s.today) return 'Today is not scored yet. Finish the day strong!';
      if (s.pct >= 75) return 'Final stretch: ' + this.fmt(s.remaining) + ' points to go.';
      if (s.pct >= 50) return 'Past halfway. Keep the streak alive!';
      return this.fmt(s.remaining) + ' points to go. One good day at a time.';
    },
    get last7() {
      const by = {}; this.rows.forEach((r) => { by[r.date] = r; });
      const out = [];
      for (let i = 6; i >= 0; i--) {
        const date = S.addDays(this.today, -i);
        out.push({ date, row: by[date], label: S.parseYmd(date).toLocaleDateString('en-GB', { weekday: 'short' }) });
      }
      return out;
    },
    get last7Avg() {
      const r = this.last7.filter((d) => d.row);
      return r.length ? this.fmt(r.reduce((s, d) => s + d.row.total, 0) / r.length) : '–';
    },
    get historyRows() {
      const by = {}; this.rows.forEach((r) => { by[r.date] = r; });
      const first = this.rows.length ? this.rows[0].date : this.settings.startDate;
      const out = [];
      let d = this.today, guard = 0;
      while (d >= first && guard++ < 900) {
        out.push({ date: d, n: S.dayNumber(d, this.settings.startDate), row: by[d] });
        d = S.addDays(d, -1);
      }
      return out;
    },
    get perfectDays() { return this.rows.filter((r) => r.base >= S.BASE_MAX).length; },
    get bonusSum() { return this.rows.reduce((s, r) => s + r.bonus, 0); },
    get weakNote() {
      if (!this.rows.length) return '';
      const w = S.categoryAverages(this.rows).sort((a, b) => a.pct - b.pct).slice(0, 2);
      return 'Needs most attention: ' + w.map((x) => x.label + ' (' + Math.round(x.pct) + '%)').join(' and ') + '.';
    },

    /* ============ charts ============ */
    renderCharts() {
      this.$nextTick(() => {
        Object.values(charts).forEach((c) => c.destroy());
        charts = {};
        if (!this.rows.length) return;
        const accent = cv('--accent'), accent2 = cv('--accent-2'), muted = cv('--muted'), line = cv('--line');
        const good = cv('--good'), ok = cv('--ok'), bad = cv('--bad');
        Chart.defaults.color = muted; Chart.defaults.borderColor = line;
        const labels = this.rows.map((r) => 'D' + this.dayNumOf(r.date));
        const base = { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } };

        charts.daily = new Chart(document.getElementById('chDaily'), {
          type: 'line',
          data: { labels, datasets: [
            { data: this.rows.map((r) => r.total), borderColor: accent, backgroundColor: accent + '26', fill: true, tension: .3, pointRadius: 3, pointBackgroundColor: accent },
            { data: this.rows.map(() => S.BASE_MAX), borderColor: muted, borderDash: [5, 5], pointRadius: 0, borderWidth: 1 }
          ] },
          options: Object.assign({}, base, { scales: { y: { min: 0, suggestedMax: 75 } } })
        });
        charts.run = new Chart(document.getElementById('chRun'), {
          type: 'line',
          data: { labels, datasets: [{ data: this.rows.map((r) => r.running), borderColor: accent2, backgroundColor: accent2 + '26', fill: true, tension: .25, pointRadius: 0 }] },
          options: Object.assign({}, base, { scales: { y: { min: 0, max: this.settings.goal } } })
        });
        const avg = S.categoryAverages(this.rows);
        charts.cat = new Chart(document.getElementById('chCat'), {
          type: 'bar',
          data: { labels: avg.map((a) => a.label), datasets: [{ data: avg.map((a) => a.pct), borderRadius: 8,
            backgroundColor: avg.map((a) => (a.pct >= 85 ? good : a.pct >= 60 ? ok : bad)) }] },
          options: Object.assign({}, base, { indexAxis: 'y', scales: { x: { min: 0, max: 100, ticks: { callback: (v) => v + '%' } } } })
        });
      });
    },

    /* ============ parent mode ============ */
    touch() { if (this.parent) this.parentUntil = Date.now() + (this.settings.autoLockMin || 5) * 60000; },
    lockParent(auto) {
      this.parent = false; this.lockCountdown = '';
      if (auto) { this.editor = null; this.say('Parent mode locked'); }
    },
    requireParent(cb) {
      if (this.parent) { if (cb) cb(); return; }
      pendingCb = cb || null;
      this.pin = { open: true, mode: this.settings.pinHash ? 'enter' : 'setup', value: '', confirm: '', code: '', error: '', recovery: '' };
      this.$nextTick(() => this.$refs.pinInput && this.$refs.pinInput.focus());
    },
    openPinSetup() { this.pin = { open: true, mode: 'setup', value: '', confirm: '', code: '', error: '', recovery: '' }; },
    closePin() {
      const done = this.pin.mode === 'recovered';
      this.pin.open = false;
      const cb = pendingCb; pendingCb = null;
      if (done && cb && this.parent) cb();
    },
    get pinTitle() {
      return { enter: 'Parent PIN', setup: this.settings.pinHash ? 'Choose a new PIN' : 'Create a parent PIN', forgot: 'Reset with recovery code', recovered: 'PIN saved' }[this.pin.mode];
    },
    get pinHint() {
      return { enter: 'Enter the PIN to edit scores and settings.', setup: 'Use 4 to 8 digits.', forgot: 'Enter the recovery code you saved when the PIN was created.', recovered: '' }[this.pin.mode];
    },
    async submitPin() {
      const p = this.pin; p.error = '';
      if (p.mode === 'enter') {
        if (Date.now() < lockedUntil) { p.error = 'Too many tries. Wait ' + Math.ceil((lockedUntil - Date.now()) / 1000) + 's.'; return; }
        const h = await hashStr(p.value, this.settings.pinSalt);
        if (h === this.settings.pinHash) {
          failedPins = 0; this.parent = true; this.touch(); this.tick();
          p.open = false; const cb = pendingCb; pendingCb = null; if (cb) cb();
        } else {
          failedPins++; p.value = '';
          if (failedPins >= 5) { lockedUntil = Date.now() + 30000; failedPins = 0; p.error = 'Too many tries. Wait 30s.'; }
          else p.error = 'Wrong PIN.';
        }
      } else if (p.mode === 'forgot') {
        const h = await hashStr(normCode(p.code), this.settings.pinSalt);
        if (h === this.settings.recoveryHash) { p.mode = 'setup'; p.value = p.confirm = ''; }
        else p.error = 'That code does not match.';
      } else if (p.mode === 'setup') {
        if (!PIN_RE.test(p.value)) { p.error = 'PIN must be 4 to 8 digits.'; return; }
        if (p.value !== p.confirm) { p.error = 'The two PINs differ.'; return; }
        const salt = randomSalt(), code = newRecoveryCode();
        await this.setSettings({
          pinSalt: salt, pinHash: await hashStr(p.value, salt), recoveryHash: await hashStr(normCode(code), salt)
        });
        this.parent = true; this.touch(); this.tick();
        p.mode = 'recovered'; p.recovery = code; p.value = p.confirm = '';
      }
    },

    /* ============ settings ============ */
    async setSettings(obj) {
      const plain = JSON.parse(JSON.stringify(obj)); // strip Alpine proxies before IndexedDB
      await db.transaction('rw', db.settings, async () => {
        for (const [k, v] of Object.entries(plain)) await db.settings.put({ key: k, value: v });
      });
      Object.assign(this.settings, plain);
    },
    async setSetting(key, value) {
      if (!this.parent) { this.say('Unlock parent mode first'); return; }
      await this.setSettings({ [key]: value });
      await this.recompute(); this.refreshViews();
    },
    async addRule() {
      const r = this.newRule.trim(); if (!r || !this.parent) return;
      await this.setSettings({ rules: this.settings.rules.concat(r) }); this.newRule = '';
    },
    async removeRule(i) {
      if (!this.parent) return;
      await this.setSettings({ rules: this.settings.rules.filter((_, j) => j !== i) });
    },
    openOpening() { this.go('settings'); this.say('Opening balance is in Settings → Challenge'); },

    /* ============ day editor ============ */
    scoreToday() { this.openEditor(this.today); },
    openEditor(date) {
      const ex = this.entries.find((e) => e.date === date);
      const can = this.parent || (!ex && date === this.today && !this.settings.lockToday);
      if (!ex && !can) { this.requireParent(() => this.openEditor(date)); return; }
      const scores = {};
      this.cats.forEach((c) => { scores[c.key] = ex ? ex.scores[c.key] : 0; });
      this.editor = {
        date, scores, exists: !!ex, readonly: !can,
        bonus: ex ? ex.bonus.map((b) => Object.assign({}, b)) : [], notes: ex ? ex.notes || '' : ''
      };
    },
    closeEditor() { this.editor = null; },
    bump(c, d) {
      const v = Math.round((Number(this.editor.scores[c.key]) + d) * 2) / 2;
      this.editor.scores[c.key] = Math.min(c.max, Math.max(0, v));
    },
    get editorBonus() { return this.editor ? S.bonusTotal({ bonus: this.editor.bonus }) : 0; },
    get editorTotal() { return this.editor ? S.dayTotal({ scores: this.editor.scores, bonus: this.editor.bonus }) : 0; },
    async saveEditor() {
      const e = this.editor; if (!e) return;
      if (e.exists && !this.parent) { this.requireParent(() => this.saveEditor()); return; }
      const entry = cleanEntry({ date: e.date, scores: e.scores, bonus: e.bonus, notes: e.notes });
      if (!entry) { this.say('Please check the scores'); return; }
      const before = this.st.total;
      await db.days.put(entry);
      await this.recompute();
      this.editor = null;
      this.say('Saved · ' + this.fmt(S.dayTotal(entry)) + ' pts for Day ' + this.dayNumOf(entry.date));
      this.celebrate(before, this.st.total, entry);
      this.refreshViews();
    },
    async deleteDay() {
      if (!this.parent || !this.editor) return;
      if (!confirm('Delete this day? Totals will be recalculated.')) return;
      await db.days.delete(this.editor.date);
      await this.recompute();
      this.editor = null; this.say('Day deleted'); this.refreshViews();
    },

    /* ============ export / import ============ */
    exportJson() {
      const settings = {}; Object.keys(this.settings).forEach((k) => { if (!PRIVATE_KEYS.includes(k)) settings[k] = this.settings[k]; });
      const payload = { app: 'digital-fasting', version: 1, exportedAt: new Date().toISOString(), settings, entries: this.entries };
      download('digital-fasting-backup-' + this.today + '.json', JSON.stringify(payload, null, 2), 'application/json');
    },
    exportCsv() { download('digital-fasting-' + this.today + '.csv', S.toCsv(this.rows, this.settings), 'text/csv'); },
    async onImportFile(ev) {
      const f = ev.target.files && ev.target.files[0]; ev.target.value = '';
      if (!f) return;
      if (f.size > 2 * 1024 * 1024) { this.say('File is too large'); return; }
      const text = await f.text();
      let preview = null;
      try {
        const j = JSON.parse(text);
        if (j && Array.isArray(j.entries)) {
          const warnings = [], days = [];
          j.entries.forEach((r, i) => { const c = cleanEntry(r); if (c) days.push(c); else warnings.push('Entry ' + (i + 1) + ' skipped: invalid.'); });
          const settings = {};
          ['goal', 'startDate', 'openingBalance', 'goodDay', 'rules', 'milestones'].forEach((k) => { if (j.settings && j.settings[k] != null) settings[k] = j.settings[k]; });
          preview = { kind: 'json', days, warnings, settings };
        }
      } catch (e) { /* not JSON, try the text log format */ }
      if (!preview) {
        const r = S.parseText(text);
        preview = { kind: 'text', days: r.days.map(cleanEntry).filter(Boolean), warnings: r.warnings, settings: {} };
      }
      if (!preview.days.length) { this.say('No valid days found in that file'); return; }
      this.importPreview = preview;
    },
    async applyImport() {
      if (!this.parent) { this.requireParent(() => this.applyImport()); return; }
      const p = this.importPreview; if (!p) return;
      await db.days.bulkPut(JSON.parse(JSON.stringify(p.days)));
      if (Object.keys(p.settings).length) await this.setSettings(p.settings);
      this.importPreview = null;
      await this.recompute(); this.refreshViews();
      this.say('Imported ' + p.days.length + ' day(s)');
    },
    async resetAll() {
      if (prompt('This erases all data on this device. Type ERASE to confirm.') !== 'ERASE') return;
      await db.transaction('rw', db.days, db.settings, async () => {
        await db.days.clear(); await db.settings.clear();
        await db.settings.put({ key: 'seeded', value: true });
        await db.settings.put({ key: 'openingBalance', value: 0 });
      });
      this.parent = false;
      await this.loadAll(); this.refreshViews(); this.say('All data erased');
    }
  };
}
