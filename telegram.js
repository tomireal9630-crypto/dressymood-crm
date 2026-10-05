// Telegram-бот звітів: щоденні зведення по рекламі ФБ і замовленнях + тривоги.
// Вмикається змінними оточення:
//   TG_REPORT_BOT_TOKEN — токен бота від @BotFather
//   TG_REPORT_CHAT_ID   — id групи, куди слати (бот підкаже його у групі, поки не задано)
// Без токена модуль нічого не робить.

const TZ = 'Europe/Kyiv';
const MORNING = { from: '09:00', to: '10:59' };   // зведення за вчора
const EVENING = { from: '22:00', to: '23:59' };   // зведення за сьогодні
const NO_LEADS_USD = 5;                           // група витратила ≥ $5 без лідів → тривога
const ALERT_EVERY_MS = 60 * 60 * 1000;
const STATE_KEY = 'tg_report_state';

const APPROVED = `('В работе','Доставка','В пути','На почте','Продажа','Отказ','Возврат','Ошибка в ТТН','Переадресация')`;
const LEAD_TS = `COALESCE(o.original_created_at, o.created_at)`;

module.exports = function initTelegramReports(deps) {
  const { pool, getEconomicsSettings, fxSpendSql, articleCplMap, syncAllFbAccounts } = deps;
  const token = (process.env.TG_REPORT_BOT_TOKEN || '').trim();
  const chatId = (process.env.TG_REPORT_CHAT_ID || '').trim();
  if (!token) { console.log('[TG] TG_REPORT_BOT_TOKEN не задано — бот звітів вимкнено'); return; }

  const API = `https://api.telegram.org/bot${token}`;

  async function tg(method, body) {
    const r = await fetch(`${API}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
    });
    const j = await r.json().catch(() => ({ ok: false, description: 'HTTP ' + r.status }));
    if (!j.ok) { const e = new Error(j.description || 'Telegram error'); e.code = j.error_code; e.params = j.parameters; throw e; }
    return j.result;
  }

  async function send(text, to = chatId) {
    if (!to) return;
    // Ліміт Telegram — 4096 символів
    for (let i = 0; i < text.length; i += 4000) {
      await tg('sendMessage', { chat_id: to, text: text.slice(i, i + 4000), parse_mode: 'HTML', disable_web_page_preview: true });
    }
  }

  // --- дати/форматування ---
  const kyivDate = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: TZ }); // YYYY-MM-DD
  const kyivTime = (d = new Date()) => d.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dm = iso => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const uah = v => Math.round(Number(v) || 0).toLocaleString('uk-UA').replace(/ /g, ' ') + ' ₴';
  const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '—';

  async function getState() {
    const r = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [STATE_KEY]);
    return r.rows.length ? r.rows[0].value : {};
  }
  async function saveState(v) {
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ($1, $2)
                      ON CONFLICT (key) DO UPDATE SET value = $2`, [STATE_KEY, v]);
  }

  // Пороги CPL (грн) по артикулах — за вікно lookback, як у юніт-економіці
  async function cplThresholds() {
    const s = await getEconomicsSettings();
    const today = kyivDate();
    const from = addDays(today, -((Number(s.lookback_days) || 30) - 1));
    return articleCplMap(from, today);
  }

  // --- дані ---
  async function adsByArticle(from, to) {
    const s = await getEconomicsSettings();
    const r = await pool.query(`
      SELECT COALESCE(NULLIF(article, ''), '— без артикула') article,
             SUM(${fxSpendSql(s)})::numeric spend_uah, SUM(leads)::int leads
      FROM fb_spend_daily WHERE date >= $1::date AND date <= $2::date
      GROUP BY 1 ORDER BY 2 DESC`, [from, to]);
    return r.rows.map(x => ({ article: x.article, spend: Number(x.spend_uah) || 0, leads: x.leads || 0 }));
  }

  async function ordersForPeriod(from, to) {
    const r = await pool.query(`
      SELECT COUNT(*)::int total,
             COUNT(*) FILTER (WHERE o.status IN ${APPROVED})::int approved,
             COUNT(*) FILTER (WHERE o.status = 'Новый')::int fresh,
             COUNT(*) FILTER (WHERE o.status IN ('Не дозвон','Не дозвон2'))::int no_answer,
             COUNT(*) FILTER (WHERE o.status = 'Отбой')::int rejected
      FROM orders o
      WHERE o.status <> '✗✗✗'
        AND (${LEAD_TS} AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date`, [from, to]);
    return r.rows[0];
  }

  async function ordersSnapshot() {
    const r = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE status = 'Новый')::int fresh,
             COUNT(*) FILTER (WHERE status IN ('Не дозвон','Не дозвон2'))::int no_answer,
             COUNT(*) FILTER (WHERE status = 'В работе')::int in_work,
             COUNT(*) FILTER (WHERE status = 'Доставка')::int delivery,
             COUNT(*) FILTER (WHERE status = 'В пути')::int on_way,
             COUNT(*) FILTER (WHERE status = 'На почте')::int at_post,
             COUNT(*) FILTER (WHERE status = 'Ошибка в ТТН')::int ttn_err
      FROM orders`);
    return r.rows[0];
  }

  function cplMark(a, thr) {
    const t = thr[a.article];
    if (!t || t.cpl_max == null || t.provisional) return '⚪';
    if (!a.leads) return a.spend > t.cpl_max ? '🔴' : '⚪';
    const cpl = a.spend / a.leads;
    if (cpl <= t.cpl_recommended) return '🟢';
    if (cpl <= t.cpl_max) return '🟡';
    return '🔴';
  }

  async function buildReport(from, to, title) {
    const [ads, ord, snap, thr] = await Promise.all([adsByArticle(from, to), ordersForPeriod(from, to), ordersSnapshot(), cplThresholds()]);
    const spend = ads.reduce((s, a) => s + a.spend, 0);
    const leads = ads.reduce((s, a) => s + a.leads, 0);
    const L = [];
    L.push(`📊 <b>${esc(title)}</b>`);
    L.push('');
    L.push(`💰 <b>Реклама:</b> ${uah(spend)} · лідів ФБ ${leads} · CPL ${leads ? uah(spend / leads) : '—'}`);
    L.push(`📦 <b>Заявки CRM:</b> ${ord.total} · підтв. ${ord.approved} · відбій ${ord.rejected} · не дозвон ${ord.no_answer} · нові ${ord.fresh}`);
    L.push(`    Апрув: ${pct(ord.approved, ord.total)}` +
           (ord.total && spend ? ` · ціна заявки CRM ${uah(spend / ord.total)}` : ''));
    if (ads.length) {
      L.push('');
      L.push('<b>По моделях:</b>');
      for (const a of ads) {
        const t = thr[a.article];
        const lim = t && t.cpl_max != null && !t.provisional ? ` (гран. ${uah(t.cpl_max)})` : (t && t.provisional ? ' (предв.)' : '');
        L.push(`${cplMark(a, thr)} ${esc(a.article)} — ${uah(a.spend)} · ${a.leads} лід. · CPL ${a.leads ? uah(a.spend / a.leads) : '—'}${lim}`);
      }
    }
    L.push('');
    L.push(`🚚 <b>Зараз:</b> в роботі ${snap.in_work} · доставка ${snap.delivery} · в дорозі ${snap.on_way} · на пошті ${snap.at_post}` +
           (snap.ttn_err ? ` · помилка ТТН ${snap.ttn_err}` : ''));
    L.push(`☎️ Чекають дзвінка: нові ${snap.fresh} · не дозвон ${snap.no_answer}`);
    L.push('');
    L.push('<i>🟢 нижче реком. CPL · 🟡 між реком. і граничним · 🔴 вище граничного · ⚪ мало історії</i>');
    return L.join('\n');
  }

  async function buildOrdersInfo() {
    const r = await pool.query(`
      SELECT o.id, o.status, COALESCE(NULLIF(o.full_name,''), c.full_name) n,
             to_char(${LEAD_TS} AT TIME ZONE '${TZ}', 'DD.MM HH24:MI') t,
             (SELECT string_agg(article || ' ' || size || ' ' || color, ', ') FROM order_items i WHERE i.order_id = o.id) it
      FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE o.status IN ('Новый','Не дозвон','Не дозвон2')
      ORDER BY o.status, o.id`);
    if (!r.rows.length) return '☎️ Немає заявок, що чекають дзвінка 👍';
    const g = {};
    r.rows.forEach(x => (g[x.status] = g[x.status] || []).push(x));
    const L = [`☎️ <b>Чекають дзвінка: ${r.rows.length}</b>`];
    for (const st of ['Новый', 'Не дозвон', 'Не дозвон2']) {
      if (!g[st]) continue;
      L.push('', `<b>${st} (${g[st].length})</b>`);
      g[st].forEach(x => L.push(`#${x.id} ${x.t} · ${esc(x.n)} · ${esc(x.it || '')}`));
    }
    return L.join('\n');
  }

  // --- тривоги ---
  async function checkAlerts() {
    if (!chatId) return;
    const today = kyivDate();
    const state = await getState();
    if (!state.alerts || state.alerts.date !== today) state.alerts = { date: today, sent: [] };
    const sent = new Set(state.alerts.sent);
    const out = [];

    // 1) Група витратила ≥ $5 сьогодні без жодного ліда
    const s = await getEconomicsSettings();
    const usd = Number(s.fx_usd) || 41;
    const g = await pool.query(`
      SELECT d.adset_id, MAX(d.adset_name) adset_name, MAX(d.campaign_name) campaign_name, MAX(d.article) article,
             MAX(a.name) account, MAX(d.currency) currency,
             SUM(d.spend)::numeric spend, SUM(${fxSpendSql(s, 'd')})::numeric spend_uah, SUM(d.leads)::int leads
      FROM fb_spend_daily d LEFT JOIN fb_ad_accounts a ON a.id = d.ad_account_id
      WHERE d.date = $1::date AND d.adset_id IS NOT NULL
      GROUP BY d.adset_id`, [today]);
    for (const x of g.rows) {
      const spendUsd = String(x.currency || '').toUpperCase() === 'USD' ? Number(x.spend) : Number(x.spend_uah) / usd;
      const key = 'noleads:' + x.adset_id;
      if (x.leads === 0 && spendUsd >= NO_LEADS_USD && !sent.has(key)) {
        out.push(`⚠️ <b>Група без лідів</b>: $${spendUsd.toFixed(2)} сьогодні, 0 лідів\n` +
                 `${esc(x.article || '—')} · ${esc(x.campaign_name)} → ${esc(x.adset_name)}\n<i>${esc(x.account || '')}</i>`);
        sent.add(key);
      }
    }

    // 2) CPL моделі сьогодні вище граничного (лише моделі з історією, не «предварительно»)
    const [ads, thr] = await Promise.all([adsByArticle(today, today), cplThresholds()]);
    for (const a of ads) {
      const t = thr[a.article];
      if (!t || t.provisional || t.cpl_max == null || t.cpl_max <= 0) continue;
      const over = a.leads ? a.spend / a.leads > t.cpl_max : a.spend > t.cpl_max;
      const key = 'cpl:' + a.article;
      if (over && !sent.has(key)) {
        out.push(`🔴 <b>CPL вище граничного</b>: ${esc(a.article)}\n` +
                 `сьогодні ${uah(a.spend)} · ${a.leads} лід. · CPL ${a.leads ? uah(a.spend / a.leads) : '—'} (гран. ${uah(t.cpl_max)})`);
        sent.add(key);
      }
    }

    // 3) Не тягнуться дані з ФБ
    const e = await pool.query(`SELECT name, last_sync_error FROM fb_ad_accounts WHERE is_active = true AND last_sync_error <> ''`);
    for (const x of e.rows) {
      const key = 'sync:' + x.name + ':' + String(x.last_sync_error).slice(0, 60);
      if (!sent.has(key)) {
        out.push(`⚠️ <b>Не завантажуються дані ФБ</b>: ${esc(x.name)}\n<i>${esc(String(x.last_sync_error).slice(0, 300))}</i>`);
        sent.add(key);
      }
    }

    state.alerts.sent = [...sent];
    await saveState(state);
    for (const m of out) await send(m);
  }

  // --- розклад зведень ---
  async function scheduleTick() {
    if (!chatId) return;
    const now = new Date(), today = kyivDate(now), t = kyivTime(now);
    const state = await getState();
    if (t >= MORNING.from && t <= MORNING.to && state.lastMorning !== today) {
      state.lastMorning = today; await saveState(state);
      const y = addDays(today, -1);
      await send(await buildReport(y, y, `Підсумок за вчора, ${dm(y)}`));
    }
    if (t >= EVENING.from && t <= EVENING.to && state.lastEvening !== today) {
      state.lastEvening = today; await saveState(state);
      await syncAllFbAccounts(2).catch(err => console.error('[TG] sync before report:', err.message));
      await send(await buildReport(today, today, `Підсумок за сьогодні, ${dm(today)}`));
    }
  }

  // --- команди ---
  const HELP = [
    '<b>Команди:</b>',
    '/today — зведення за сьогодні',
    '/yesterday — за вчора',
    '/week — за 7 днів',
    '/orders — хто чекає дзвінка',
    '',
    `Автоматично: о ${MORNING.from} — за вчора, о ${EVENING.from} — за сьогодні, тривоги щогодини.`
  ].join('\n');

  async function handleMessage(msg) {
    const from = String(msg.chat.id);
    const text = String(msg.text || '').trim();
    if (!text.startsWith('/')) return;
    const cmd = text.split(/\s+/)[0].split('@')[0].toLowerCase();

    // Поки група не прив'язана — бот лише підказує id чату, жодних даних
    if (!chatId) {
      await send(`ID цього чату: <code>${esc(from)}</code>\nВстав його в Railway як змінну <b>TG_REPORT_CHAT_ID</b>.`, from);
      return;
    }
    if (from !== chatId) return; // чужі чати ігноруємо

    const today = kyivDate();
    if (cmd === '/start' || cmd === '/help') return send(HELP);
    if (cmd === '/today') {
      await syncAllFbAccounts(1).catch(err => console.error('[TG] sync:', err.message));
      return send(await buildReport(today, today, `Сьогодні, ${dm(today)} (станом на ${kyivTime()})`));
    }
    if (cmd === '/yesterday') { const y = addDays(today, -1); return send(await buildReport(y, y, `Вчора, ${dm(y)}`)); }
    if (cmd === '/week') { const f = addDays(today, -6); return send(await buildReport(f, today, `7 днів, ${dm(f)}–${dm(today)}`)); }
    if (cmd === '/orders') return send(await buildOrdersInfo());
  }

  let offset = 0, stopped = false;
  async function poll() {
    while (!stopped) {
      try {
        const updates = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
        for (const u of updates) {
          offset = u.update_id + 1;
          const msg = u.message;
          if (!msg || !msg.chat) continue;
          if (msg.migrate_to_chat_id) console.log(`[TG] група стала супергрупою, новий id: ${msg.migrate_to_chat_id}`);
          handleMessage(msg).catch(err => {
            console.error('[TG] command error:', err.message);
            send('✕ Помилка: ' + esc(err.message), String(msg.chat.id)).catch(() => {});
          });
        }
      } catch (err) {
        // 409 — інший екземпляр (під час деплою) теж опитує; чекаємо довше
        console.error('[TG] poll error:', err.message);
        await new Promise(r => setTimeout(r, err.code === 409 ? 30000 : 5000));
      }
    }
  }

  poll();
  setInterval(() => { scheduleTick().catch(err => console.error('[TG] schedule:', err.message)); }, 60 * 1000);
  setTimeout(() => { checkAlerts().catch(err => console.error('[TG] alerts:', err.message)); }, 5 * 60 * 1000);
  setInterval(() => { checkAlerts().catch(err => console.error('[TG] alerts:', err.message)); }, ALERT_EVERY_MS);
  console.log(`[TG] бот звітів запущено${chatId ? '' : ' (TG_REPORT_CHAT_ID не задано — чекаю команду в групі)'}`);

  return { buildReport, buildOrdersInfo, checkAlerts };
};
