/**
 * Read-only crawler: logs in, visits every page reachable by links (same origin), clicks every
 * safe button on each page, and reports server errors (5xx), browser errors, error screens,
 * broken links and any request leaving the server (company data isolation, D-033).
 *
 * It CANNOT change data: every POST/PUT/PATCH/DELETE except login/logout is blocked in the
 * browser before it leaves. Safe to run against the Railway demo with a demo account.
 *
 * Needs Playwright (pre-installed in the dev container; not a project dependency):
 *   E2E_BASE_URL=http://127.0.0.1:3100 E2E_EMAIL=manager@example.test E2E_PASSWORD=… node e2e/crawl.cjs
 * Options: E2E_LANG=fr|ar (default fr), E2E_MOBILE=1 (phone viewport), E2E_MAX_PER_ROUTE (default 3).
 * Never put a password in the repository or in a command saved to shell history on a shared machine.
 */
const { chromium, devices } = require('playwright');

const BASE = (process.env.E2E_BASE_URL || 'http://127.0.0.1:3100').replace(/\/$/, '');
const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
const LANG = process.env.E2E_LANG === 'ar' ? 'ar' : 'fr';
const MOBILE = process.env.E2E_MOBILE === '1';
const MAX_PER_ROUTE = Number(process.env.E2E_MAX_PER_ROUTE || 3);
if (!EMAIL || !PASSWORD) {
  console.error('Set E2E_EMAIL and E2E_PASSWORD (demo account only).');
  process.exit(2);
}

/** Buttons that would change something or leave the page are never clicked (even though writes are blocked). */
const UNSAFE = /déconnex|logout|sortir|se déconnecter|خروج|imprimer|print|طباعة/i;
/** POST endpoints that only compute and write nothing (price preview), plus the session itself. */
const READ_ONLY_POST = /^\/api\/(auth\/(login|logout)|reservations\/quote)$/;
const pattern = (path) => path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id').replace(/\?.*$/, '');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    ...(MOBILE ? devices['Pixel 7'] : { viewport: { width: 1366, height: 900 } }),
    timezoneId: 'Africa/Casablanca',
    acceptDownloads: false,
  });
  await ctx.addInitScript((lang) => {
    void lang;
    window.print = () => undefined;
    window.open = () => null;
  }, LANG);
  const issues = [];
  let blockedWrites = 0;
  let current = '';
  const add = (kind, detail) => issues.push(`${kind} @ ${current}: ${detail}`);

  await ctx.route('**/*', (route) => {
    const req = route.request();
    const url = req.url();
    if (!url.startsWith(BASE) && !url.startsWith('data:') && !url.startsWith('blob:')) {
      add('EXTERNAL', url);
      return route.abort();
    }
    if (req.method() !== 'GET' && req.method() !== 'HEAD' && !READ_ONLY_POST.test(new URL(url).pathname)) {
      blockedWrites += 1;
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'crawler_read_only', message: 'Read-only crawl' } }) });
    }
    return route.continue();
  });

  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/status of (4\d\d)/.test(t)) return; // expected refusals (403/404/409) are shown in the UI
    add('CONSOLE', t.slice(0, 200));
  });
  page.on('pageerror', (e) => add('PAGEERROR', String(e).slice(0, 200)));
  page.on('response', (r) => {
    if (r.status() >= 500) add('HTTP5XX', `${r.status()} ${r.url()}`);
  });

  // Login
  current = '/login';
  await page.goto(BASE + '/');
  await page.locator('input[type=email]').fill(EMAIL);
  await page.locator('input[type=password]').first().fill(PASSWORD);
  await page.locator('form button[type=submit]').click();
  await page.locator('.welcome-card').waitFor({ timeout: 15000 });
  if (LANG === 'ar') await page.locator('button[lang=ar]').first().click();

  const seen = new Set();
  const perRoute = new Map();
  const queue = ['/'];
  const apiLinks = new Set();
  let pages = 0;
  let clicks = 0;

  async function settle() {
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => add('SLOW', 'network not idle after 10 s'));
  }
  async function collectLinks() {
    const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')));
    for (const h of hrefs) {
      if (!h || h.startsWith('#') || h.startsWith('mailto:') || h.startsWith('tel:')) continue;
      if (/^https?:\/\//.test(h)) {
        if (!h.startsWith(BASE) && !/^https:\/\/wa\.me\//.test(h)) add('EXTERNAL_LINK', h);
        continue;
      }
      if (h.startsWith('/api/')) { apiLinks.add(h); continue; }
      const p = pattern(h);
      if (seen.has(h)) continue;
      if ((perRoute.get(p) ?? 0) >= MAX_PER_ROUTE) continue;
      perRoute.set(p, (perRoute.get(p) ?? 0) + 1);
      seen.add(h);
      queue.push(h);
    }
  }
  const notices = new Set();
  /** Generic error screen = a real failure. A business message (e.g. vehicle not inspected) is only noted. */
  async function errorScreen(writesBefore = blockedWrites) {
    const loc = page.locator('.state-error, [role=alert].alert-error');
    const n = await loc.count();
    for (let i = 0; i < n; i += 1) {
      const txt = (await loc.nth(i).innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
      if (/sauvegarde|نسخ|stockage|تخزين|protection|حماية/i.test(txt)) continue; // demo data-safety alert, expected
      if (blockedWrites > writesBefore) continue; // the crawler refused the write itself
      if (/erreur est survenue|حدث خطأ|introuvable|غير موجود/i.test(txt)) add('ERRORSCREEN', txt);
      else notices.add(`${pattern(current)}: ${txt}`);
    }
  }

  /** The crawl is only meaningful while logged in: losing the session is a failure, never a silent pass. */
  let relogins = 0;
  async function ensureLoggedIn() {
    // Ask the server (same cookies) rather than guessing from the page: "Mon compte" also has a password field.
    if ((await page.request.get(BASE + '/api/auth/me')).status() !== 401) return;
    await page.goto(BASE + '/');
    add('SESSION_LOST', 'the login page appeared during the crawl (a button logged out?)');
    relogins += 1;
    if (relogins > 3) throw new Error('Session lost repeatedly; stopping the crawl.');
    await page.locator('input[type=email]').fill(EMAIL);
    await page.locator('input[type=password]').first().fill(PASSWORD);
    await page.locator('form button[type=submit]').click();
    await page.locator('.welcome-card').waitFor({ timeout: 15000 });
    await page.goto(BASE + current);
    await settle();
  }

  seen.add('/');
  while (queue.length) {
    const path = queue.shift();
    current = path;
    const resp = await page.goto(BASE + path).catch((e) => add('NAV', String(e)));
    if (resp && resp.status() >= 400) add('HTTP', `${resp.status()} ${path}`);
    await settle();
    await ensureLoggedIn();
    pages += 1;
    await errorScreen();
    await collectLinks();

    // Click every visible, enabled, non-submit button that is not unsafe; come back if it navigates.
    const count = await page.locator('button:not([type=submit])').count();
    for (let i = 0; i < count; i += 1) {
      const b = page.locator('button:not([type=submit])').nth(i);
      if (!(await b.isVisible().catch(() => false)) || !(await b.isEnabled().catch(() => false))) continue;
      const label = ((await b.getAttribute('aria-label')) || (await b.innerText().catch(() => ''))).trim().replace(/\s+/g, ' ');
      if (UNSAFE.test(label)) continue;
      // The language buttons are left alone so the whole crawl stays in the chosen language.
      if (await b.evaluate((el) => el.hasAttribute('lang'))) continue;
      const before = blockedWrites;
      await b.click({ timeout: 3000 }).catch(() => undefined);
      clicks += 1;
      await page.waitForTimeout(150);
      await settle();
      await errorScreen(before);
      await ensureLoggedIn();
      if (pattern(new URL(page.url()).pathname) !== pattern(path) || blockedWrites > before) {
        await collectLinks();
        await page.goto(BASE + path);
        await settle();
      } else {
        await collectLinks();
        await page.keyboard.press('Escape').catch(() => undefined);
      }
    }
  }

  // Download / file links from the API (CSV exports, scans): status only, content never printed.
  for (const h of apiLinks) {
    current = h;
    const r = await page.request.get(BASE + h);
    if (r.status() >= 500 || r.status() === 404) add('APILINK', `${r.status()} ${h}`);
  }

  await browser.close();
  const routes = [...perRoute.keys(), '/'].sort();
  console.log(`Crawl ${BASE} as ${EMAIL} (${LANG}${MOBILE ? ', phone' : ''})`);
  console.log(`pages visited: ${pages} · route patterns: ${new Set(routes).size} · buttons clicked: ${clicks} · API links checked: ${apiLinks.size} · writes blocked: ${blockedWrites}`);
  console.log(`routes: ${[...new Set(routes)].join(' ')}`);
  if (notices.size) {
    console.log(`\nBusiness messages seen (not errors, check they make sense):`);
    for (const x of notices) console.log(`  ${x}`);
  }
  if (issues.length) {
    console.log(`\n${issues.length} issue(s):`);
    for (const x of [...new Set(issues)]) console.log(`  ${x}`);
    process.exit(1);
  }
  console.log('No issue found.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
