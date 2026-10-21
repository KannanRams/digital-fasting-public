/* Scoring, ledger, date helpers and text-file importer.
   Pure functions, no DOM: runs in the browser (window.Scoring) and in Node (tests). */
(function (root) {
  'use strict';

  const CATEGORIES = [
    { key: 'wake',      label: 'Wake up time',      short: 'Wake',     max: 10, icon: '⏰' },
    { key: 'behaviour', label: 'Behaviour',         short: 'Behaviour', max: 10, icon: '😊' },
    { key: 'time',      label: 'Time management',   short: 'Time',     max: 10, icon: '🗓️' },
    { key: 'screen',    label: 'Screen time',       short: 'Screen',   max: 10, icon: '📵' },
    { key: 'sleep',     label: 'Sleep time',        short: 'Sleep',    max: 11, icon: '😴' },
    { key: 'school',    label: 'School impression', short: 'School',   max: 10, icon: '🎒' },
    { key: 'helpful',   label: 'Helpfulness',       short: 'Helpful',  max: 10, icon: '🤝' }
  ];
  const BASE_MAX = 70; // the "out of 70" in the original file (sleep can exceed 10 as a bonus)

  const round2 = (n) => Math.round(n * 100) / 100;
  const pad = (n) => String(n).padStart(2, '0');

  /* ---------- dates (all local, stored as YYYY-MM-DD) ---------- */
  function todayStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function parseYmd(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function addDays(s, n) {
    const d = parseYmd(s);
    d.setDate(d.getDate() + n);
    return todayStr(d);
  }
  function daysBetween(a, b) { // b - a in whole days (DST safe)
    const A = parseYmd(a), B = parseYmd(b);
    return Math.round((Date.UTC(B.getFullYear(), B.getMonth(), B.getDate()) -
                       Date.UTC(A.getFullYear(), A.getMonth(), A.getDate())) / 86400000);
  }
  function dayNumber(date, startDate) { return daysBetween(startDate, date) + 1; }

  /* ---------- scoring ---------- */
  function num(v) { v = Number(v); return isFinite(v) ? v : 0; }
  function baseTotal(e) {
    return round2(CATEGORIES.reduce((s, c) => s + num(e.scores && e.scores[c.key]), 0));
  }
  function bonusTotal(e) {
    return round2((e.bonus || []).reduce((s, b) => s + num(b.points), 0));
  }
  function dayTotal(e) { return round2(baseTotal(e) + bonusTotal(e)); }

  /* Ledger: every figure is calculated here, never stored. */
  function ledger(entries, opening) {
    const sorted = entries.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    let run = num(opening);
    return sorted.map((e) => {
      const base = baseTotal(e), bonus = bonusTotal(e), total = round2(base + bonus);
      run = round2(run + total);
      return Object.assign({}, e, { bonusItems: e.bonus || [], base, bonus, total, running: run });
    });
  }

  function stats(rows, settings, today) {
    const opening = num(settings.openingBalance);
    const total = rows.length ? rows[rows.length - 1].running : opening;
    const goal = num(settings.goal);
    const sumEntries = round2(rows.reduce((s, r) => s + r.total, 0));
    const avg = rows.length ? sumEntries / rows.length : 0;
    const remaining = Math.max(0, round2(goal - total));
    const byDate = {};
    rows.forEach((r) => { byDate[r.date] = r; });

    // streak of consecutive "good" days (>= goodDay), ending today, or yesterday if today isn't scored yet
    const good = num(settings.goodDay) || 60;
    let cursor = byDate[today] ? today : addDays(today, -1);
    let streak = 0;
    while (byDate[cursor] && byDate[cursor].total >= good) { streak++; cursor = addDays(cursor, -1); }

    let best = null, worst = null;
    rows.forEach((r) => {
      if (!best || r.total > best.total) best = r;
      if (!worst || r.total < worst.total) worst = r;
    });

    const paceDays = avg > 0 ? Math.ceil(remaining / avg) : null;
    const perfectDays = Math.ceil(remaining / BASE_MAX);
    return {
      total, goal, remaining, pct: goal ? Math.min(100, (total / goal) * 100) : 0,
      avg: round2(avg), streak, best, worst, daysLogged: rows.length,
      paceDays, paceDate: paceDays != null ? addDays(today, paceDays) : null,
      perfectDays, perfectDate: addDays(today, perfectDays),
      today: byDate[today] || null
    };
  }

  function categoryAverages(rows) {
    return CATEGORIES.map((c) => {
      const vals = rows.map((r) => num(r.scores[c.key]));
      const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      return { key: c.key, label: c.label, short: c.short, avg: round2(avg), pct: round2((avg / c.max) * 100) };
    });
  }

  /* ---------- text importer (the "Ode to Minecraft" log format) ---------- */
  const CAT_PATTERNS = [
    [/^wake\s*up\s*time/i, 'wake'], [/^behaviou?r/i, 'behaviour'], [/^time\s*management/i, 'time'],
    [/^screen\s*time/i, 'screen'], [/^sleep\s*time/i, 'sleep'],
    [/^school\s*impression/i, 'school'], [/^helpfulness/i, 'helpful']
  ];

  function parseText(text) {
    const warnings = [], days = [];
    let cur = null;
    String(text).split(/\r?\n/).forEach((raw) => {
      const line = raw.trim();
      if (!line) return;
      let m = line.match(/^Day\s*(\d+)\s*:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
      if (m) {
        cur = { day: +m[1], date: m[4] + '-' + pad(+m[3]) + '-' + pad(+m[2]),
                scores: {}, bonus: [], notes: '', statedTotal: null, statedRunning: null };
        days.push(cur);
        return;
      }
      if (!cur) return;
      for (const [re, key] of CAT_PATTERNS) {
        if (re.test(line)) {
          const mm = line.replace(re, '').match(/^[\s:]*(\d+(?:\.\d+)?)\s*\/\s*10\s*(.*)$/);
          if (mm) {
            cur.scores[key] = parseFloat(mm[1]);
            const note = mm[2].trim();
            if (note) {
              const label = CATEGORIES.find((c) => c.key === key).short;
              cur.notes += (cur.notes ? '; ' : '') + label + ': ' + note;
            }
          }
          return;
        }
      }
      if ((m = line.match(/^Add\b(.*)$/i))) {
        const n = m[1].match(/(\d+(?:\.\d+)?)/);
        if (n) {
          const reason = m[1].replace(n[0], '').replace(/\bfor\b/i, '').replace(/\s+/g, ' ').trim();
          cur.bonus.push({ points: parseFloat(n[1]), reason });
        }
        return;
      }
      if ((m = line.match(/^Total\s*:\s*(\d+(?:\.\d+)?)\s*\/+\s*70/i))) { cur.statedTotal = parseFloat(m[1]); return; }
      if ((m = line.match(/^(\d+(?:\.\d+)?)\s*\/+\s*(\d+)$/))) { cur.statedRunning = parseFloat(m[1]); return; }
    });

    const complete = [], seen = {};
    days.forEach((d) => {
      const missing = CATEGORIES.filter((c) => d.scores[c.key] == null).map((c) => c.short);
      if (missing.length) {
        warnings.push('Day ' + d.day + ' (' + d.date + ') skipped: missing ' + missing.join(', ') + '.');
        return;
      }
      if (seen[d.date]) { warnings.push('Day ' + d.day + ': duplicate date ' + d.date + ', later one wins.'); }
      seen[d.date] = true;
      const calc = dayTotal(d);
      if (d.statedTotal != null && Math.abs(d.statedTotal - calc) > 0.01 && Math.abs(d.statedTotal - baseTotal(d)) > 0.01) {
        warnings.push('Day ' + d.day + ': file says ' + d.statedTotal + ', recalculated ' + calc + '.');
      }
      complete.push(d);
    });
    return { days: complete, warnings };
  }

  function toCsv(rows, settings) {
    const head = ['Day', 'Date'].concat(CATEGORIES.map((c) => c.label), ['Bonus', 'Bonus reasons', 'Daily total', 'Running total', 'Notes']);
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lines = [head.map(esc).join(',')];
    rows.forEach((r) => {
      lines.push([dayNumber(r.date, settings.startDate), r.date]
        .concat(CATEGORIES.map((c) => r.scores[c.key]),
                [r.bonus, (r.bonusItems || []).map((b) => b.points + (b.reason ? ' ' + b.reason : '')).join('; ')],
                [r.total, r.running, r.notes || '']).map(esc).join(','));
    });
    return lines.join('\n');
  }

  const api = {
    CATEGORIES, BASE_MAX, round2, todayStr, parseYmd, addDays, daysBetween, dayNumber,
    baseTotal, bonusTotal, dayTotal, ledger, stats, categoryAverages, parseText, toCsv
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Scoring = api;
})(typeof window !== 'undefined' ? window : globalThis);
