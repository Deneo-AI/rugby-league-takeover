// Shared runtime helpers for Rugby League Takeover Supabase Edge Functions.
// Each function directory carries a copy of this file (deployed alongside
// index.ts) so every function stays self-contained, mirroring the original
// Base44 function layout. Edit THIS file and run scripts/sync-shared.mjs
// (or copy manually) to fan changes out.
import { createClient } from 'npm:@supabase/supabase-js@2';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });

export const preflight = () => new Response('ok', { headers: CORS });

// Service-role client — bypasses RLS. SUPABASE_* env vars are injected by the
// Supabase Edge runtime automatically.
export function serviceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
}

// Resolve the calling app user (their profiles row) from the Authorization
// header. Returns null for anonymous callers, invalid tokens, or disabled
// accounts — matching base44.auth.me() semantics.
// deno-lint-ignore no-explicit-any
export async function getCaller(req: Request, svc: any) {
  try {
    const header = req.headers.get('authorization') || '';
    const token = header.replace(/^Bearer\s+/i, '').trim();
    if (!token) return null;
    const { data, error } = await svc.auth.getUser(token);
    if (error || !data?.user) return null;
    const { data: profile } = await svc
      .from('profiles')
      .select('*')
      .eq('auth_user_id', data.user.id)
      .maybeSingle();
    if (!profile || profile.disabled) return null;
    return profile;
  } catch {
    return null;
  }
}

// Stripe test/live mode toggle. Set STRIPE_MODE to 'test' or 'live' (default
// 'live') to control which key set createCheckout/stripeWebhook use. In live
// mode this falls back to the plain STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET
// names for backward compatibility with keys configured before this toggle
// existed — set STRIPE_SECRET_KEY_LIVE/STRIPE_WEBHOOK_SECRET_LIVE to be explicit.
export function stripeMode() {
  return Deno.env.get('STRIPE_MODE') === 'test' ? 'test' : 'live';
}

export function getStripeSecretKey() {
  const mode = stripeMode();
  const key = mode === 'test'
    ? Deno.env.get('STRIPE_SECRET_KEY_TEST')
    : Deno.env.get('STRIPE_SECRET_KEY_LIVE') || Deno.env.get('STRIPE_SECRET_KEY');
  if (!key) throw new Error(`Stripe is not configured for ${mode} mode (missing STRIPE_SECRET_KEY_${mode.toUpperCase()})`);
  return key;
}

export function getStripeWebhookSecret() {
  const mode = stripeMode();
  const secret = mode === 'test'
    ? Deno.env.get('STRIPE_WEBHOOK_SECRET_TEST')
    : Deno.env.get('STRIPE_WEBHOOK_SECRET_LIVE') || Deno.env.get('STRIPE_WEBHOOK_SECRET');
  if (!secret) throw new Error(`Stripe webhook secret is not configured for ${mode} mode (missing STRIPE_WEBHOOK_SECRET_${mode.toUpperCase()})`);
  return secret;
}

// ---------------------------------------------------------------------------
// Branded transactional email (Resend). One light-themed template (white card,
// orange accent + logo) so every email is on-brand and renders consistently in
// every client (dark emails get force-lightened by Gmail). Auth emails (signup
// code / reset / invite) share the same look via the Supabase dashboard
// templates — see supabase/auth-email-templates/.
// ---------------------------------------------------------------------------
export function siteUrl() {
  return (Deno.env.get('SITE_URL') || 'https://www.rugbyleaguetakeover.com').replace(/\/+$/, '');
}

export const escapeHtml = (value: unknown) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

// deno-lint-ignore no-explicit-any
export function brandedEmailHtml({ preheader = '', heading, bodyHtml, ctaLabel, ctaUrl, footerNote }: any) {
  const base = siteUrl();
  const logo = `${base}/icons/icon-192.png`;
  const cta = ctaLabel && ctaUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px auto 4px;"><tr><td bgcolor="#f97316" style="background-color:#f97316;">
         <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:14px 34px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#ffffff;text-decoration:none;">${escapeHtml(ctaLabel)}</a>
       </td></tr></table>`
    : '';
  // Light theme: renders consistently across every client (Gmail included),
  // where a dark background gets force-lightened. Brand identity carries via
  // the crest, orange accent bar + button, and bold uppercase headings.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(heading)}</title>
<style>
  :root { color-scheme: light; supported-color-schemes: light; }
  a[x-apple-data-detectors]{ color:inherit !important; text-decoration:none !important; }
</style>
</head>
<body bgcolor="#f2f4f7" style="margin:0;padding:0;background-color:#f2f4f7;">
  <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f2f4f7" style="background-color:#f2f4f7;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <tr><td align="center" style="padding:8px 0 24px;">
          <a href="${base}" style="text-decoration:none;">
            <img src="${logo}" width="72" height="72" alt="Rugby League Takeover" style="display:block;border:0;">
          </a>
        </td></tr>
        <tr><td style="height:4px;background-color:#f97316;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td bgcolor="#ffffff" style="background-color:#ffffff;border:1px solid #e2e8f0;border-top:0;padding:36px 32px;">
          <p style="margin:0 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;letter-spacing:3px;text-transform:uppercase;color:#ea580c;">Rugby League Takeover · Las Vegas</p>
          <h1 style="margin:0 0 18px;font-family:Arial,Helvetica,sans-serif;font-size:26px;line-height:1.2;text-transform:uppercase;letter-spacing:1px;color:#0b1220;">${escapeHtml(heading)}</h1>
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#334155;">${bodyHtml}</div>
          ${cta}
        </td></tr>
        <tr><td style="padding:22px 8px 0;" align="center">
          <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;color:#64748b;">
            ${footerNote ? `${escapeHtml(footerNote)}<br>` : ''}
            Rugby League Takeover Las Vegas · <a href="${base}" style="color:#64748b;">rugbyleaguetakeover.com</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// Sends via Resend. Returns false (never throws) when unconfigured or on
// failure — transactional email must not break the calling flow.
export async function sendBrandedEmail(to: string, subject: string, { text, ...template }: { text: string } & Record<string, unknown>) {
  try {
    const key = Deno.env.get('RESEND_API_KEY');
    if (!key || !to) return false;
    const from = Deno.env.get('EMAIL_FROM') || 'Rugby League Takeover <onboarding@resend.dev>';
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ from, to, subject, text, html: brandedEmailHtml(template) }),
    });
    if (!res.ok) console.error('Resend send failed:', res.status, await res.text().catch(() => ''));
    return res.ok;
  } catch (error) {
    console.error('sendBrandedEmail error:', error);
    return false;
  }
}

export const trimToLength = (value: unknown, maxLength: number) =>
  String(value ?? '').trim().slice(0, maxLength);

export const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export const isEmail = (email: unknown) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());

export const isLikelyBot = (input: Record<string, unknown> | null | undefined) =>
  Boolean(trimToLength(input?.website, 256) || trimToLength(input?.company, 256));

export function resolveClientIp(req: Request) {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return (req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || '').trim();
}

// Returns the first matching active, non-expired ban, or null.
// deno-lint-ignore no-explicit-any
export async function findActiveBan(svc: any, { ip, emails = [], userId }: { ip?: string; emails?: (string | null | undefined)[]; userId?: string }) {
  const now = Date.now();
  const candidates: { ban_type: string; value: string }[] = [];
  if (ip) candidates.push({ ban_type: 'ip', value: ip.toLowerCase() });
  for (const email of emails) {
    if (email) candidates.push({ ban_type: 'email', value: String(email).toLowerCase() });
  }
  if (userId) candidates.push({ ban_type: 'user', value: String(userId).toLowerCase() });

  for (const candidate of candidates) {
    const { data } = await svc
      .from('bans')
      .select('*')
      .eq('ban_type', candidate.ban_type)
      .eq('value', candidate.value)
      .eq('is_active', true);
    for (const ban of data || []) {
      if (!ban.expires_at || new Date(ban.expires_at).getTime() > now) return ban;
    }
  }
  return null;
}

// Automatic profanity censoring. Word-boundary match, keeps the first letter
// and masks the rest (e.g. "shit" -> "s***"). Applied to post body and title.
const PROFANITY = [
  'fuck', 'fucker', 'fucking', 'motherfucker', 'shit', 'bullshit', 'bitch', 'cunt',
  'asshole', 'arsehole', 'bastard', 'dickhead', 'piss', 'slut', 'whore', 'wanker',
  'prick', 'bollocks', 'bugger', 'twat', 'fag', 'faggot', 'nigger', 'nigga', 'retard',
];
const PROFANITY_RE = new RegExp(`\\b(${PROFANITY.join('|')})\\b`, 'gi');
export const censorProfanity = (text: unknown) =>
  String(text || '').replace(PROFANITY_RE, (match) => match[0] + '*'.repeat(Math.max(match.length - 1, 1)));

export const FORUM_CATEGORIES = ['General', 'Travel', 'Events', 'MatchDay', 'VegasTips', 'JerseySwap'];

const CASINO_RANKS = [
  { min: 2500, name: 'Vegas Royalty' }, { min: 1500, name: 'Whale' }, { min: 900, name: 'High Roller' },
  { min: 450, name: 'Pit Boss' }, { min: 180, name: 'Table Regular' }, { min: 60, name: 'Lucky Local' }, { min: 0, name: 'Rookie Punter' },
];
export const todayKey = () => new Date().toISOString().slice(0, 10);
export const rankForXp = (xp: number) => CASINO_RANKS.find((r) => xp >= r.min)?.name || 'Rookie Punter';

// Award casino XP/chips for forum activity + log a ForumRewardEvent.
// Mirrors the Base44 awardForumReward logic (incl. daily streak bonus).
// deno-lint-ignore no-explicit-any
export async function awardForumReward(svc: any, user: { id?: string; email?: string } | null, { kind, xp, chips, postId, note, counter }: { kind: string; xp: number; chips: number; postId?: string; note: string; counter?: string }) {
  if (!user?.id) return null;
  try {
    const { data: fullUser } = await svc.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (!fullUser) return null;
    const today = todayKey();
    const last = String(fullUser.casino_last_active_date || '');
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const streak = last === today ? num(fullUser.casino_streak) : last === yesterday ? num(fullUser.casino_streak) + 1 : 1;
    const streakBonus = last === today ? 0 : Math.min(50, streak * 5);
    const nextXp = num(fullUser.casino_xp) + xp + streakBonus;
    const nextChips = num(fullUser.casino_chips) + chips + streakBonus;
    const rank = rankForXp(nextXp);
    const update: Record<string, unknown> = {
      casino_xp: nextXp, casino_chips: nextChips, casino_rank: rank,
      casino_streak: streak, casino_last_active_date: today,
    };
    if (counter) update[counter] = num(fullUser[counter]) + 1;
    await svc.from('profiles').update(update).eq('id', user.id);
    await svc.from('forum_reward_events').insert({
      user_id: user.id, user_email: user.email || '', kind,
      xp: xp + streakBonus, chips: chips + streakBonus, rank_after: rank,
      post_id: postId || '', note: streakBonus ? `${note} · ${streak} day streak bonus` : note,
    });
    return { xp: xp + streakBonus, chips: chips + streakBonus, rank, streak };
  } catch (error) {
    console.error('awardForumReward error:', error);
    return null;
  }
}

// deno-lint-ignore no-explicit-any
export async function getForumPost(svc: any, postId: unknown) {
  const id = String(postId || '').trim();
  if (!id) return null;
  const { data } = await svc.from('forum_posts').select('*').eq('id', id).maybeSingle();
  return data || null;
}

// Forum media must live on storage we control. It was previously stored with
// only a length trim, and MediaAttach is a free-text URL field, so any member
// could point every forum page load at their own server — turning the feed into
// an IP/User-Agent beacon for everyone who scrolled past, and letting them swap
// the bytes for something else after a moderator had already approved the post.
// Returns '' for anything not on an allowed host, so the post still saves
// without the attachment rather than failing the whole submission.
export function safeForumMediaUrl(value: unknown) {
  const raw = String(value ?? '').trim().slice(0, 600);
  if (!raw) return '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:') return '';

  const allowed = new Set<string>();
  try {
    const project = new URL(Deno.env.get('SUPABASE_URL') || '');
    if (project.hostname) allowed.add(project.hostname.toLowerCase());
  } catch { /* project host unavailable — fall through to extras */ }
  for (const host of String(Deno.env.get('FORUM_MEDIA_ALLOWED_HOSTS') || '').split(',')) {
    const clean = host.trim().toLowerCase();
    if (clean) allowed.add(clean);
  }

  return allowed.has(url.hostname.toLowerCase()) ? url.toString() : '';
}
