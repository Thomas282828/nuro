// ══════════════════════════════════════════════════════════════════════════
// kaideno — Worker Cloudflare (proxy Deepgram/Claude + comptes réels + quota
// + parrainage + mot de passe oublié)
//
// ⚠️ Avant de déployer ce fichier :
//   1. Exécuter migration.sql, migration2.sql, migration3.sql PUIS migration4.sql
//      sur la base D1 "kaideno-db" (Dashboard Cloudflare → Workers & Pages → D1
//      → kaideno-db → Console).
//   2. Pour que "mot de passe oublié" ET le rapport hebdomadaire envoient vraiment
//      un email, ajouter un secret RESEND_API_KEY (Settings → Variables and Secrets)
//      avec une clé obtenue sur resend.com (gratuit). Sans domaine vérifié chez
//      Resend, les emails ne peuvent être envoyés qu'à l'adresse du compte Resend
//      lui-même — pour toucher n'importe quel utilisateur, il faut vérifier
//      un nom de domaine que tu possèdes. Tant que ce n'est pas fait,
//      /forgot-password et le digest répondent/tournent normalement mais
//      n'envoient rien (silencieux).
//   3. Le rapport hebdomadaire (fonction "scheduled" en bas de ce fichier) a besoin
//      d'un Cron Trigger Cloudflare, que je ne peux pas configurer moi-même :
//      Dashboard Cloudflare → Workers & Pages → [ton worker] → Settings → Trigger
//      Events → Cron Triggers → Add Cron Trigger → ex. "0 8 * * 1" (chaque lundi
//      8h UTC). Sans cette étape, "scheduled" n'est jamais appelée.
// ══════════════════════════════════════════════════════════════════════════

const FOUNDERS = ['vincent.naigeon@gmail.com', 'worldultimaterecords@outlook.com'];
const PLAN_MINUTES = { free: 30, essentiel: 600, pro: 1800 };
const REFERRAL_BONUS_MINUTES = 30; // offert au parrain ET au filleul, une fois, à l'inscription du filleul

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7); // "2026-07"
}

function limitSecondsFor(plan, email) {
  if (FOUNDERS.includes((email || '').toLowerCase())) return Infinity;
  const min = PLAN_MINUTES[plan] ?? PLAN_MINUTES.free;
  return min * 60;
}

// Minutes réellement consommées ce mois-ci, moins les minutes bonus (parrainage).
// Les minutes bonus ne se réinitialisent jamais (contrairement au quota mensuel).
function effectiveUsedSeconds(u, month) {
  const real = (u.quota_month === month) ? (u.used_seconds || 0) : 0;
  return Math.max(0, real - (u.bonus_seconds || 0));
}

// ── Hachage de mot de passe (PBKDF2, calculé côté serveur) ──
async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomHex(len) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}
const randomToken = () => randomHex(32);
const randomSalt = () => randomHex(16);

// Code de parrainage court et lisible (ex: "K7F3QX2"), unique en base (avec quelques essais).
async function generateReferralCode(env) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O/1/I pour éviter la confusion
  for (let attempt = 0; attempt < 6; attempt++) {
    let code = '';
    const bytes = crypto.getRandomValues(new Uint8Array(7));
    for (let i = 0; i < 7; i++) code += chars[bytes[i] % chars.length];
    const existing = await env.DB.prepare('SELECT email FROM users WHERE referral_code = ?').bind(code).first();
    if (!existing) return code;
  }
  return randomHex(6); // filet de sécurité si vraiment pas de chance
}

// ── Envoi d'email transactionnel via Resend (silencieux si non configuré) ──
async function sendEmail(env, to, subject, html) {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'no_resend_key' };
  const from = env.RESEND_FROM || 'kaideno <onboarding@resend.dev>';
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, html }),
    });
    return { ok: r.ok };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ── Rapport hebdomadaire par email (version limitée) ──
// IMPORTANT — limite architecturale assumée : les transcriptions/résumés ne sont JAMAIS stockés
// côté serveur (uniquement dans le localStorage du navigateur de chaque utilisateur, pour la
// confidentialité). Le Worker ne connaît donc que le total de secondes enregistrées (used_seconds),
// jamais le contenu, le nombre exact de sessions ou les actions. Ce digest reste donc volontairement
// limité à "combien de minutes as-tu enregistrées cette semaine", sans détail de contenu.
const DIGEST_I18N = {
  fr: (min, url) => ({
    subject: `Ton récap kaideno de la semaine`,
    html: `<p>Bonjour,</p><p>Cette semaine, tu as enregistré <strong>${min} minute${min>1?'s':''}</strong> avec kaideno.</p><p><a href="${url}">Retrouve tes transcriptions et résumés →</a></p><p style="color:#888;font-size:.85em">Astuce : tes transcriptions restent stockées uniquement sur tes appareils, jamais sur nos serveurs — ce résumé ne peut donc afficher que ton temps d'enregistrement, pas le détail de leur contenu.</p>`,
  }),
  en: (min, url) => ({
    subject: `Your weekly kaideno recap`,
    html: `<p>Hi,</p><p>This week, you recorded <strong>${min} minute${min>1?'s':''}</strong> with kaideno.</p><p><a href="${url}">See your transcripts and summaries →</a></p><p style="color:#888;font-size:.85em">Note: your transcripts are stored only on your own devices, never on our servers — so this digest can only show your recording time, not their content.</p>`,
  }),
  es: (min, url) => ({
    subject: `Tu resumen semanal de kaideno`,
    html: `<p>Hola,</p><p>Esta semana grabaste <strong>${min} minuto${min>1?'s':''}</strong> con kaideno.</p><p><a href="${url}">Ver tus transcripciones y resúmenes →</a></p><p style="color:#888;font-size:.85em">Nota: tus transcripciones se guardan solo en tus dispositivos, nunca en nuestros servidores — por eso este resumen solo puede mostrar tu tiempo grabado, no su contenido.</p>`,
  }),
  de: (min, url) => ({
    subject: `Dein wöchentlicher kaideno-Rückblick`,
    html: `<p>Hallo,</p><p>Diese Woche hast du <strong>${min} Minute${min>1?'n':''}</strong> mit kaideno aufgenommen.</p><p><a href="${url}">Deine Transkriptionen und Zusammenfassungen ansehen →</a></p><p style="color:#888;font-size:.85em">Hinweis: Deine Transkriptionen werden nur auf deinen Geräten gespeichert, nie auf unseren Servern — daher zeigt dieser Rückblick nur deine Aufnahmezeit, nicht den Inhalt.</p>`,
  }),
  it: (min, url) => ({
    subject: `Il tuo riepilogo settimanale kaideno`,
    html: `<p>Ciao,</p><p>Questa settimana hai registrato <strong>${min} minuto${min>1?'i':''}</strong> con kaideno.</p><p><a href="${url}">Vedi le tue trascrizioni e riassunti →</a></p><p style="color:#888;font-size:.85em">Nota: le tue trascrizioni sono salvate solo sui tuoi dispositivi, mai sui nostri server — quindi questo riepilogo può mostrare solo il tempo registrato, non il contenuto.</p>`,
  }),
  pt: (min, url) => ({
    subject: `O teu resumo semanal do kaideno`,
    html: `<p>Olá,</p><p>Esta semana gravaste <strong>${min} minuto${min>1?'s':''}</strong> com o kaideno.</p><p><a href="${url}">Ver as tuas transcrições e resumos →</a></p><p style="color:#888;font-size:.85em">Nota: as tuas transcrições ficam guardadas apenas nos teus dispositivos, nunca nos nossos servidores — por isso este resumo só pode mostrar o teu tempo gravado, não o conteúdo.</p>`,
  }),
  nl: (min, url) => ({
    subject: `Jouw wekelijkse kaideno-overzicht`,
    html: `<p>Hoi,</p><p>Deze week nam je <strong>${min} minuut${min>1?'en':''}</strong> op met kaideno.</p><p><a href="${url}">Bekijk je transcripties en samenvattingen →</a></p><p style="color:#888;font-size:.85em">Let op: je transcripties worden alleen op je eigen apparaten bewaard, nooit op onze servers — dit overzicht kan dus alleen je opnametijd tonen, niet de inhoud.</p>`,
  }),
  zh: (min, url) => ({
    subject: `你的 kaideno 每周摘要`,
    html: `<p>你好，</p><p>本周你使用 kaideno 录制了 <strong>${min} 分钟</strong>。</p><p><a href="${url}">查看你的转录和摘要 →</a></p><p style="color:#888;font-size:.85em">提示：你的转录内容仅保存在你自己的设备上，从不存储在我们的服务器上 — 因此本摘要只能显示录制时长，无法显示内容详情。</p>`,
  }),
  ja: (min, url) => ({
    subject: `kaideno の週間レポート`,
    html: `<p>こんにちは、</p><p>今週、kaidenoで <strong>${min}分</strong> 録音しました。</p><p><a href="${url}">文字起こしと要約を見る →</a></p><p style="color:#888;font-size:.85em">注：文字起こしはお使いの端末にのみ保存され、サーバーには一切保存されません。そのため本レポートは録音時間のみ表示でき、内容の詳細は表示できません。</p>`,
  }),
};
function digestEmailContent(lang, minutes) {
  const build = DIGEST_I18N[lang] || DIGEST_I18N.fr;
  return build(minutes, 'https://thomas282828.github.io/nuro/index.html');
}

// ── Valide un jeton "Authorization: Bearer ..." et renvoie l'utilisateur (ou null) ──
async function getAuthUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  try {
    const sess = await env.DB.prepare('SELECT * FROM auth_sessions WHERE token = ?').bind(token).first();
    if (!sess) return null;
    if (new Date(sess.expires_at) < new Date()) return null;
    const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(sess.email).first();
    return u || null;
  } catch (e) {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);

    // ── Clé Deepgram (contrôle de quota si un jeton est fourni) ──
    if (url.pathname === '/deepgram-token') {
      const u = await getAuthUser(request, env);
      if (u) {
        const month = currentMonth();
        const used = effectiveUsedSeconds(u, month);
        const limit = limitSecondsFor(u.plan || 'free', u.email);
        if (limit !== Infinity && used >= limit) {
          return json({ error: 'quota_exceeded' }, 403, cors);
        }
      }
      // Pas de jeton (ancien client, ou mode local) : on ne casse pas l'existant.
      return new Response(
        JSON.stringify({ key: env.DEEPGRAM_API_KEY }),
        { headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }

    // ── Transcrire un fichier audio déjà enregistré (import) via l'API Deepgram "pre-recorded" ──
    if (url.pathname === '/deepgram-transcribe-file' && request.method === 'POST') {
      const u = await getAuthUser(request, env);
      if (!u) return json({ error: 'unauthorized' }, 401, cors);

      const month = currentMonth();
      const used = effectiveUsedSeconds(u, month);
      const limit = limitSecondsFor(u.plan || 'free', u.email);
      if (limit !== Infinity && used >= limit) {
        return json({ error: 'quota_exceeded' }, 403, cors);
      }

      try {
        const language = url.searchParams.get('language') || 'fr';
        const keyterms = url.searchParams.getAll('keyterm'); // ?keyterm=x&keyterm=y répété

        const audioBuf = await request.arrayBuffer();
        // Limite raisonnable pour éviter les abus / timeouts du Worker (~60 Mo).
        if (audioBuf.byteLength > 60 * 1024 * 1024) {
          return json({ error: 'file_too_large' }, 413, cors);
        }

        const dgUrl = new URL('https://api.deepgram.com/v1/listen');
        dgUrl.searchParams.set('model', 'nova-3');
        dgUrl.searchParams.set('language', language);
        dgUrl.searchParams.set('punctuate', 'true');
        dgUrl.searchParams.set('smart_format', 'true');
        dgUrl.searchParams.set('diarize', 'true');
        keyterms.forEach(k => dgUrl.searchParams.append('keyterm', k));

        const contentType = request.headers.get('Content-Type') || 'audio/wav';
        const dgRes = await fetch(dgUrl.toString(), {
          method: 'POST',
          headers: { 'Authorization': `Token ${env.DEEPGRAM_API_KEY}`, 'Content-Type': contentType },
          body: audioBuf,
        });
        const dgData = await dgRes.json();
        if (!dgRes.ok) return json({ error: 'deepgram_error', detail: dgData }, 502, cors);

        // Comptabiliser la consommation à partir de la durée réelle renvoyée par Deepgram
        // (même logique que /usage, mais calculée ici car le client ne connaît pas encore la durée).
        const duration = Math.ceil(dgData?.metadata?.duration || 0);
        if (duration > 0) {
          const now = new Date().toISOString();
          const realUsed = (u.quota_month === month) ? (u.used_seconds || 0) + duration : duration;
          await env.DB.prepare('UPDATE users SET used_seconds=?, quota_month=?, last_seen=? WHERE email=?')
            .bind(realUsed, month, now, u.email).run();
        }

        return json({ ok: true, result: dgData, duration }, 200, cors);
      } catch (e) {
        return json({ error: String(e) }, 500, cors);
      }
    }

    // ── Créer un lien de partage en lecture seule pour un enregistrement ──
    if (url.pathname === '/share' && request.method === 'POST') {
      const u = await getAuthUser(request, env);
      if (!u) return json({ error: 'unauthorized' }, 401, cors);
      try {
        const { title, summary, transcript } = await request.json();
        const token = randomHex(10); // lien court, ex: /share.html?t=3fa9c1b2e7
        const now = new Date().toISOString();
        await env.DB.prepare(
          `INSERT INTO shares (token, owner_email, title, summary_json, transcript, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(token, u.email, (title || '').slice(0, 200), JSON.stringify(summary || {}), (transcript || '').slice(0, 200000), now).run();
        return json({ ok: true, token }, 200, cors);
      } catch (e) {
        return json({ error: String(e) }, 500, cors);
      }
    }

    // ── Lire un enregistrement partagé (public, aucune authentification requise) ──
    if (url.pathname === '/share' && request.method === 'GET') {
      const token = url.searchParams.get('token');
      if (!token) return json({ error: 'missing_token' }, 400, cors);
      try {
        const row = await env.DB.prepare(
          'SELECT title, summary_json, transcript, created_at FROM shares WHERE token = ?'
        ).bind(token).first();
        if (!row) return json({ error: 'not_found' }, 404, cors);
        let summary = {};
        try { summary = JSON.parse(row.summary_json || '{}'); } catch (e) {}
        return json({
          ok: true, title: row.title, summary, transcript: row.transcript, created_at: row.created_at,
        }, 200, cors);
      } catch (e) {
        return json({ error: String(e) }, 500, cors);
      }
    }

    // ── Relais vers Claude ──
    if (url.pathname === '/claude') {
      const body = await request.json();
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      return new Response(JSON.stringify(data), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // ── Créer un compte réel (mot de passe + plan + quota + parrainage) ──
    if (url.pathname === '/register' && request.method === 'POST') {
      try {
        const { email: rawEmail, password, lang, ref } = await request.json();
        const email = (rawEmail || '').trim().toLowerCase();
        if (!email || !email.includes('@')) return json({ error: 'invalid_email' }, 400, cors);
        if (!password || password.length < 8) return json({ error: 'weak_password' }, 400, cors);

        const existing = await env.DB.prepare('SELECT email, password_hash FROM users WHERE email = ?').bind(email).first();
        if (existing && existing.password_hash) return json({ error: 'email_taken' }, 409, cors);

        const salt = randomSalt();
        const hash = await hashPassword(password, salt);
        const now = new Date().toISOString();
        const month = currentMonth();
        const referralCode = await generateReferralCode(env);

        if (existing) {
          await env.DB.prepare(
            `UPDATE users SET password_hash=?, salt=?, plan=COALESCE(plan,'free'), used_seconds=0, quota_month=?, last_seen=?, lang=?, referral_code=COALESCE(referral_code,?) WHERE email=?`
          ).bind(hash, salt, month, now, lang || 'fr', referralCode, email).run();
        } else {
          await env.DB.prepare(
            `INSERT INTO users (email, created_at, lang, last_seen, password_hash, salt, plan, used_seconds, quota_month, referral_code, bonus_seconds)
             VALUES (?, ?, ?, ?, ?, ?, 'free', 0, ?, ?, 0)`
          ).bind(email, now, lang || 'fr', now, hash, salt, month, referralCode).run();
        }

        // ── Parrainage : si un code valide est fourni et que ce n'est pas un auto-parrainage,
        // on crédite le parrain ET le filleul, une seule fois.
        if (ref) {
          try {
            const referrer = await env.DB.prepare('SELECT email FROM users WHERE referral_code = ?').bind(ref).first();
            if (referrer && referrer.email.toLowerCase() !== email) {
              const already = await env.DB.prepare('SELECT referred_email FROM referrals WHERE referred_email = ?').bind(email).first();
              if (!already) {
                const bonusSec = REFERRAL_BONUS_MINUTES * 60;
                await env.DB.prepare('INSERT INTO referrals (referred_email, referrer_email, created_at, rewarded) VALUES (?, ?, ?, 1)')
                  .bind(email, referrer.email, now).run();
                await env.DB.prepare('UPDATE users SET bonus_seconds = COALESCE(bonus_seconds,0) + ? WHERE email = ?').bind(bonusSec, referrer.email).run();
                await env.DB.prepare('UPDATE users SET bonus_seconds = COALESCE(bonus_seconds,0) + ? WHERE email = ?').bind(bonusSec, email).run();
              }
            }
          } catch (e) { /* le parrainage ne doit jamais faire échouer l'inscription */ }
        }

        const token = randomToken();
        const expires = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
        await env.DB.prepare('INSERT INTO auth_sessions (token, email, created_at, expires_at) VALUES (?, ?, ?, ?)')
          .bind(token, email, now, expires).run();

        const fresh = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
        return json({
          ok: true, token, email, plan: fresh.plan || 'free',
          used_seconds: effectiveUsedSeconds(fresh, month), quota_month: month,
          referral_code: fresh.referral_code,
        }, 200, cors);
      } catch (e) {
        return json({ error: String(e) }, 500, cors);
      }
    }

    // ── Connexion (depuis n'importe quel appareil) ──
    if (url.pathname === '/login' && request.method === 'POST') {
      try {
        const { email: rawEmail, password } = await request.json();
        const email = (rawEmail || '').trim().toLowerCase();
        const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
        if (!u || !u.password_hash) return json({ error: 'no_account' }, 404, cors);

        const hash = await hashPassword(password, u.salt);
        if (hash !== u.password_hash) return json({ error: 'bad_credentials' }, 401, cors);

        const now = new Date().toISOString();
        const month = currentMonth();
        if (u.quota_month !== month) {
          await env.DB.prepare('UPDATE users SET used_seconds=0, quota_month=?, last_seen=? WHERE email=?').bind(month, now, email).run();
          u.used_seconds = 0; u.quota_month = month;
        } else {
          await env.DB.prepare('UPDATE users SET last_seen=? WHERE email=?').bind(now, email).run();
        }
        // Compte créé avant l'ajout du parrainage : lui attribuer un code au passage.
        if (!u.referral_code) {
          u.referral_code = await generateReferralCode(env);
          await env.DB.prepare('UPDATE users SET referral_code=? WHERE email=?').bind(u.referral_code, email).run();
        }

        const token = randomToken();
        const expires = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();
        await env.DB.prepare('INSERT INTO auth_sessions (token, email, created_at, expires_at) VALUES (?, ?, ?, ?)')
          .bind(token, email, now, expires).run();

        return json({
          ok: true, token, email, plan: u.plan || 'free',
          used_seconds: effectiveUsedSeconds(u, month), quota_month: month,
          referral_code: u.referral_code,
        }, 200, cors);
      } catch (e) {
        return json({ error: String(e) }, 500, cors);
      }
    }

    // ── Déconnexion ──
    if (url.pathname === '/logout' && request.method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
      if (token) {
        try { await env.DB.prepare('DELETE FROM auth_sessions WHERE token = ?').bind(token).run(); } catch (e) {}
      }
      return json({ ok: true }, 200, cors);
    }

    // ── Infos du compte connecté (plan, quota, code de parrainage) ──
    if (url.pathname === '/me' && request.method === 'GET') {
      const u = await getAuthUser(request, env);
      if (!u) return json({ error: 'unauthorized' }, 401, cors);
      const month = currentMonth();
      if (!u.referral_code) {
        u.referral_code = await generateReferralCode(env);
        await env.DB.prepare('UPDATE users SET referral_code=? WHERE email=?').bind(u.referral_code, u.email).run();
      }
      return json({
        email: u.email, plan: u.plan || 'free',
        used_seconds: effectiveUsedSeconds(u, month), quota_month: month,
        lang: u.lang, referral_code: u.referral_code,
      }, 200, cors);
    }

    // ── Enregistrer la consommation (quota infalsifiable) ──
    if (url.pathname === '/usage' && request.method === 'POST') {
      const u = await getAuthUser(request, env);
      if (!u) return json({ error: 'unauthorized' }, 401, cors);
      try {
        const { seconds } = await request.json();
        const add = Math.max(0, Math.floor(Number(seconds) || 0));
        const month = currentMonth();
        const now = new Date().toISOString();
        const realUsed = (u.quota_month === month) ? (u.used_seconds || 0) + add : add;
        await env.DB.prepare('UPDATE users SET used_seconds=?, quota_month=?, last_seen=? WHERE email=?')
          .bind(realUsed, month, now, u.email).run();
        const updated = { ...u, used_seconds: realUsed, quota_month: month };
        return json({ ok: true, used_seconds: effectiveUsedSeconds(updated, month), quota_month: month }, 200, cors);
      } catch (e) {
        return json({ error: String(e) }, 500, cors);
      }
    }

    // ── Mot de passe oublié : envoie un lien de réinitialisation par email ──
    if (url.pathname === '/forgot-password' && request.method === 'POST') {
      try {
        const { email: rawEmail } = await request.json();
        const email = (rawEmail || '').trim().toLowerCase();
        // Réponse générique dans tous les cas : ne jamais révéler si un email est inscrit.
        if (email && email.includes('@')) {
          const u = await env.DB.prepare('SELECT email FROM users WHERE email = ? AND password_hash IS NOT NULL').bind(email).first();
          if (u) {
            const token = randomToken();
            const now = new Date().toISOString();
            const expires = new Date(Date.now() + 3600 * 1000).toISOString(); // valable 1h
            await env.DB.prepare('INSERT INTO password_resets (token, email, created_at, expires_at, used) VALUES (?, ?, ?, ?, 0)')
              .bind(token, email, now, expires).run();
            const link = `https://thomas282828.github.io/nuro/index.html?reset=${token}`;
            await sendEmail(env, email, 'Réinitialise ton mot de passe kaideno',
              `<p>Tu as demandé à réinitialiser ton mot de passe kaideno.</p>
               <p><a href="${link}">Clique ici pour choisir un nouveau mot de passe</a> (lien valable 1 heure).</p>
               <p>Si tu n'es pas à l'origine de cette demande, ignore cet email — rien ne changera.</p>`);
          }
        }
        return json({ ok: true }, 200, cors);
      } catch (e) {
        return json({ ok: true }, 200, cors); // toujours une réponse générique, même en cas d'erreur interne
      }
    }

    // ── Réinitialisation effective du mot de passe via le jeton reçu par email ──
    if (url.pathname === '/reset-password' && request.method === 'POST') {
      try {
        const { token, password } = await request.json();
        if (!token || !password || password.length < 8) return json({ error: 'invalid' }, 400, cors);
        const r = await env.DB.prepare('SELECT * FROM password_resets WHERE token = ?').bind(token).first();
        if (!r || r.used || new Date(r.expires_at) < new Date()) return json({ error: 'invalid_or_expired' }, 400, cors);

        const salt = randomSalt();
        const hash = await hashPassword(password, salt);
        await env.DB.prepare('UPDATE users SET password_hash=?, salt=? WHERE email=?').bind(hash, salt, r.email).run();
        await env.DB.prepare('UPDATE password_resets SET used=1 WHERE token=?').bind(token).run();
        // Sécurité : on déconnecte tous les appareils déjà connectés avec l'ancien mot de passe.
        await env.DB.prepare('DELETE FROM auth_sessions WHERE email=?').bind(r.email).run();

        return json({ ok: true }, 200, cors);
      } catch (e) {
        return json({ error: String(e) }, 500, cors);
      }
    }

    // ── Enregistrer une inscription (suivi admin — inchangé) ──
    if (url.pathname === '/signup' && request.method === 'POST') {
      try {
        const { email, lang } = await request.json();
        if (!email || !email.includes('@')) {
          return new Response(JSON.stringify({ error: 'invalid email' }), {
            status: 400,
            headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }
        const now = new Date().toISOString();
        await env.DB.prepare(
          `INSERT INTO users (email, created_at, lang, last_seen)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(email) DO UPDATE SET last_seen = ?`
        ).bind(email.toLowerCase(), now, lang || 'fr', now, now).run();

        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 500,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    }

    // ── Liste des inscrits (protégée par mot de passe — inchangé) ──
    if (url.pathname === '/admin-users') {
      const pass = url.searchParams.get('key');
      if (pass !== env.ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
      try {
        const { results } = await env.DB.prepare(
          'SELECT email, created_at, lang, last_seen FROM users ORDER BY created_at DESC'
        ).all();
        return new Response(JSON.stringify({ users: results, total: results.length }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 500,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response('kaideno proxy OK', { headers: cors });
  },

  // ── Déclenché par un Cron Trigger Cloudflare (à configurer manuellement — voir note en haut
  // du fichier). Envoie à chaque utilisateur ayant enregistré du temps depuis le dernier envoi
  // un email indiquant ses minutes enregistrées depuis le dernier digest. Ne peut pas inclure de
  // détail de contenu (voir DIGEST_I18N ci-dessus) car aucune session n'est stockée côté serveur.
  async scheduled(event, env, ctx) {
    const month = currentMonth();
    const now = new Date().toISOString();
    try {
      const { results } = await env.DB.prepare(
        'SELECT email, lang, used_seconds, quota_month, last_digest_seconds FROM users WHERE password_hash IS NOT NULL'
      ).all();
      for (const u of results || []) {
        const realUsed = (u.quota_month === month) ? (u.used_seconds || 0) : 0;
        // Si le mois a changé depuis le dernier digest, on repart d'une base à 0 (le compteur mensuel a été remis à zéro).
        const baseline = (u.quota_month === month) ? (u.last_digest_seconds || 0) : 0;
        const delta = Math.max(0, realUsed - baseline);
        if (delta < 60) continue; // pas d'activité notable depuis le dernier envoi : on n'envoie rien
        const minutes = Math.round(delta / 60);
        const { subject, html } = digestEmailContent(u.lang, minutes);
        const sent = await sendEmail(env, u.email, subject, html);
        if (sent.ok) {
          await env.DB.prepare('UPDATE users SET last_digest_seconds=?, last_digest_at=? WHERE email=?')
            .bind(realUsed, now, u.email).run();
        }
      }
    } catch (e) {
      // Silencieux : un Cron Trigger n'a pas d'appelant à qui répondre.
    }
  }
};
