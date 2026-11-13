import { APIRequestContext, BrowserContext, Page, expect, test } from '@playwright/test';

/**
 * Offline mode, end to end: the production build with its service worker, a real API on a temporary database,
 * and the network really cut (BrowserContext.setOffline). Fictional data only.
 */
const PASSWORD = process.env['E2E_PASSWORD']!;
const PIN = '482915';
const AGENT = 'agent.e2e';

const day = (offset = -2) => { const d = new Date(Date.now() + offset * 86_400_000); return d.toISOString().slice(0, 10); };
const pill = (page: Page) => page.locator('wk-connection .pill');
const headerChip = (page: Page) => page.locator('wk-page-header wk-sync');

async function signIn(page: Page, username = AGENT) {
  await page.goto('/login');
  await page.getByPlaceholder('Identifiant ou email').fill(username);
  await page.getByPlaceholder('Mot de passe').fill(PASSWORD);
  await page.locator('form button[type=submit]').click();
}

/** First use of the device: sign in online, choose the PIN, land on the declarations. */
async function setUpDevice(page: Page, username = AGENT) {
  await signIn(page, username);
  await expect(page).toHaveURL(/\/verrouillage/);
  await expect(page.getByRole('heading', { name: 'Protégez cet appareil' })).toBeVisible();
  await page.locator('#pin').fill(PIN);
  await page.locator('#pin2').fill(PIN);
  await page.getByRole('button', { name: 'Activer le mode hors connexion' }).click();
  await expect(page).toHaveURL(/\/declarations/);
  await expect(pill(page)).toContainText('En ligne');
}

/** The application shell and every screen are in the service worker cache: the page can reload without network. */
async function waitForOfflineShell(page: Page) {
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await expect.poll(async () => page.evaluate(async () => {
    let entries = 0;
    for (const name of await caches.keys()) if (name.includes(':assets:')) entries += (await (await caches.open(name)).keys()).length;
    return entries;
  }), { timeout: 90_000 }).toBeGreaterThan(40);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000 }).toBe(true);
}

async function goOffline(context: BrowserContext, page: Page) {
  await context.setOffline(true);
  await expect(pill(page)).toContainText('Hors connexion');
}
async function goOnline(context: BrowserContext, page: Page) {
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
}

async function fillDeclaration(page: Page, child: string) {
  await page.getByRole('link', { name: 'Nouvelle déclaration' }).click();
  await expect(page.getByRole('heading', { name: 'Nouvelle déclaration de naissance' })).toBeVisible();
  await page.locator('input[name=c_fn]').fill(child);
  await page.locator('input[name=c_ln]').fill('Essai');
  await page.locator('select[name=c_g]').selectOption('F');
  await page.locator('input[name=bd]').fill(day());
  await page.locator('input[name=bt]').fill('08:30');
  await page.locator('input[name=bp]').fill('Ratoma');
  await page.locator('input[name=m_fn]').fill('Fatoumata');
  await page.locator('input[name=m_ln]').fill('Bah');
}

async function saveDraft(page: Page, child: string) {
  await fillDeclaration(page, child);
  await page.getByRole('button', { name: 'Enregistrer le brouillon' }).click();
  await expect(page).toHaveURL(/\/declarations\/[0-9a-f-]{36}$/);
}

/** What the SERVER holds for this child (asked as the agent, outside the browser). */
async function serverRows(request: APIRequestContext, child: string) {
  const login = await request.post('/api/auth/login/', { data: { username: AGENT, password: PASSWORD } });
  const { access } = await login.json();
  const headers = { Authorization: `Bearer ${access}` };
  const list = await (await request.get('/api/declarations/', { headers, params: { search: child } })).json();
  return { headers, rows: list.results as { uuid: string; reference: string; status: string }[] };
}

test('saisie hors connexion, redémarrage sans réseau, puis synchronisation au retour de la connexion', async ({ page, context, request }) => {
  await setUpDevice(page);
  await waitForOfflineShell(page);
  await goOffline(context, page);

  await saveDraft(page, 'Horsligne');
  await expect(page.locator('wk-toasts')).toContainText('Enregistré sur cet appareil');
  await expect(headerChip(page)).toContainText('Sur cet appareil');
  await expect(page.locator('wk-page-header h1')).toContainText(/LOCAL-/i);
  await expect(page.locator('wk-sync-banner')).toContainText('enregistré sur cet appareil uniquement');
  expect((await serverRows(request, 'Horsligne')).rows).toHaveLength(0);

  // the browser is closed and reopened without network: the shell comes from the service worker, the data from the device
  await page.reload();
  await expect(page).toHaveURL(/\/verrouillage/);
  await expect(page.getByRole('heading', { name: 'Appareil verrouillé' })).toBeVisible();
  await expect(page.locator('.count')).toContainText('1 opération');
  await page.locator('#code').fill('111222');
  await page.getByRole('button', { name: 'Déverrouiller' }).click();
  await expect(page.locator('.alert-danger')).toContainText('Code incorrect');
  await page.locator('#code').fill(PIN);
  await page.getByRole('button', { name: 'Déverrouiller' }).click();
  await expect(page).toHaveURL(/\/declarations\/[0-9a-f-]{36}$/);   // back where the agent was
  await expect(headerChip(page)).toContainText('Sur cet appareil');
  await page.locator('.sidebar nav').getByRole('link', { name: 'Déclarations' }).click();
  const row = page.locator('tbody tr', { hasText: 'Horsligne' });
  await expect(row.locator('wk-sync')).toContainText('Sur cet appareil');
  await expect(pill(page)).toContainText('Hors connexion');

  // the connection returns: sent automatically, the server attributes the reference
  await goOnline(context, page);
  await expect(row.locator('wk-sync')).toContainText('En ligne');
  await expect(row).toContainText(/WKR-\d{4}-\d{4}/);
  await expect(pill(page)).toContainText('En ligne');
  const { rows } = await serverRows(request, 'Horsligne');
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe('DRAFT');
});

test('transmission et photo de la fiche préparées hors connexion', async ({ page, context, request, browser }) => {
  await setUpDevice(page);
  await waitForOfflineShell(page);
  await goOffline(context, page);

  await fillDeclaration(page, 'Transmise');
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 7)]);
  await page.locator('wk-paper-form input[type=file]').nth(1).setInputFiles({ name: 'fiche.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  await expect(page.locator('wk-paper-form figure')).toHaveCount(1);
  await page.getByRole('button', { name: 'Enregistrer et transmettre au secrétariat' }).click();
  await expect(page).toHaveURL(/\/declarations\/[0-9a-f-]{36}$/);
  await expect(page.locator('wk-toasts')).toContainText('Elle sera transmise au secrétariat au retour de la connexion');
  await expect(page.locator('wk-page-header wk-status')).toContainText('Transmis au secrétariat');
  await expect(headerChip(page)).toContainText('Sur cet appareil');
  await expect(page.locator('wk-paper-form figure wk-sync')).toContainText('Sur cet appareil');
  await expect(page.getByRole('link', { name: 'Modifier' })).toHaveCount(0);  // transmitted: locked on the device too

  await goOnline(context, page);
  await expect(headerChip(page)).toContainText('En ligne');
  await expect(page.locator('wk-page-header h1')).toContainText(/WKR-/);
  const { headers, rows } = await serverRows(request, 'Transmise');
  expect(rows.map(r => r.status)).toEqual(['TRANSMITTED']);
  const docs = await (await request.get('/api/documents/', { headers, params: { declaration: rows[0].uuid } })).json();
  expect(docs.count).toBe(1);
  expect(docs.results[0].size).toBe(jpeg.length);

  // the administrator can tell that this dossier was transmitted from a device (statistics + filtered list)
  const adminLogin = await request.post('/api/auth/login/', { data: { username: 'admin.e2e', password: PASSWORD } });
  const adminHeaders = { Authorization: `Bearer ${(await adminLogin.json()).access}` };
  const stats = await (await request.get('/api/stats/dashboard/', { headers: adminHeaders })).json();
  expect(stats.offline.transmitted).toBeGreaterThanOrEqual(1);
  const offlineList = await (await request.get('/api/declarations/', { headers: adminHeaders, params: { transmitted_offline: 'true' } })).json();
  expect(offlineList.results.map((r: { uuid: string }) => r.uuid)).toContain(rows[0].uuid);

  // ...and sees it on screen: card of the dashboard, then the list narrowed to these dossiers (own browser: own session)
  const staff = await browser.newContext();
  const admin = await staff.newPage();
  await signIn(admin, 'admin.e2e');
  await expect(admin).toHaveURL(/\/dashboard/);
  const card = admin.locator('section.offline');
  await expect(card).toContainText('Dossiers transmis hors ligne');
  await expect(card.locator('.o-figs dd').first()).not.toHaveText('0');
  await card.getByRole('link', { name: /transmis hors ligne/i }).click();
  await expect(admin).toHaveURL(/offline=transmitted/);
  await expect(admin.locator('tbody tr', { hasText: 'Transmise' }).locator('.chip-off')).toHaveText('Hors ligne');
  if (process.env['E2E_SHOTS']) { await admin.screenshot({ path: `${process.env['E2E_SHOTS']}/liste.png` }); await admin.goto('/dashboard'); await expect(card).toBeVisible(); await admin.screenshot({ path: `${process.env['E2E_SHOTS']}/tableau.png` }); }
  await staff.close();
});

test('conflit : le dossier a changé sur le serveur, rien n\'est écrasé', async ({ page, context, request }) => {
  await setUpDevice(page);
  await waitForOfflineShell(page);
  await saveDraft(page, 'Conflit');
  await expect(headerChip(page)).toContainText('En ligne');
  const uuid = page.url().split('/').pop()!;

  await goOffline(context, page);
  await page.getByRole('link', { name: 'Modifier' }).click();
  await page.locator('input[name=bp]').fill('Appareil');
  await page.getByRole('button', { name: 'Enregistrer les modifications' }).click();
  await expect(headerChip(page)).toContainText('Modifications à envoyer');

  // meanwhile the same dossier is changed on the server (another device of the agent)
  const { headers } = await serverRows(request, 'Conflit');
  expect((await request.patch(`/api/declarations/${uuid}/`, { headers, data: { birth_place: 'Serveur' } })).status()).toBe(200);

  await goOnline(context, page);
  await expect(headerChip(page)).toContainText('Conflit à résoudre');
  const banner = page.locator('wk-sync-banner');
  await expect(banner).toContainText('a changé sur le serveur');
  expect((await (await request.get(`/api/declarations/${uuid}/`, { headers })).json()).birth_place).toBe('Serveur');

  await banner.getByRole('button', { name: 'Garder la version du serveur' }).click();
  await page.locator('.modal').getByRole('button', { name: 'Abandonner mes modifications' }).click();
  await expect(headerChip(page)).toContainText('En ligne');
  await expect(page.locator('dl.kv').first()).toContainText('Serveur');
});

// These two scenarios rewrite network answers (route): the service worker is left out so that every request is
// seen by the test. The service worker itself is covered by the scenarios above.
test.describe('pannes du serveur simulées', () => {
  test.use({ serviceWorkers: 'block' });

  test('réponse du serveur perdue pendant la synchronisation : aucun doublon', async ({ page, context, request }) => {
    await setUpDevice(page);
    let cut = false;
    await context.route('**/api/sync/push/', async route => {
      if (cut) { await route.continue(); return; }
      cut = true;
      await route.fetch();          // the server receives and applies the operation…
      await route.abort('failed');  // …but its answer never reaches the device
    });
    await saveDraft(page, 'Coupure');
    await expect(headerChip(page)).toContainText('En ligne');
    expect(cut).toBe(true);
    expect((await serverRows(request, 'Coupure')).rows).toHaveLength(1);
  });

  test('session expirée : le travail continue sur l\'appareil, la file reprend après reconnexion', async ({ page, context, request }) => {
    await setUpDevice(page);
    const expire = async (route: import('@playwright/test').Route) => {
      const url = route.request().url();
      if (/\/(sync\/ping|auth\/login|public)\//.test(url)) await route.continue();
      else await route.fulfill({ status: 401, json: { detail: 'Jeton expiré.' } });
    };
    await context.route('**/api/**', expire);

    await saveDraft(page, 'Expiree');
    await expect(page.locator('.strip.danger')).toContainText('Session expirée');
    await expect(page).not.toHaveURL(/\/login/);
    await expect(headerChip(page)).toContainText('Sur cet appareil');
    expect((await serverRows(request, 'Expiree')).rows).toHaveLength(0);

    await context.unroute('**/api/**', expire);
    await page.getByRole('button', { name: 'Se reconnecter' }).click();
    await page.locator('#reauth-pw').fill(PASSWORD);
    await page.locator('wk-reauth button[type=submit]').click();
    await expect(page.locator('.strip.danger')).toHaveCount(0);
    await expect(headerChip(page)).toContainText('En ligne');
    expect((await serverRows(request, 'Expiree')).rows).toHaveLength(1);
  });
});

test('déconnexion bloquée tant que des opérations attendent, et autre compte refusé sur l\'appareil', async ({ page, context }) => {
  await setUpDevice(page);
  await waitForOfflineShell(page);
  await goOffline(context, page);
  await saveDraft(page, 'Bloquee');

  await page.locator('.sidebar .logout').click();
  const dialog = page.locator('.modal');
  await expect(dialog).toContainText('Déconnexion impossible');
  await expect(dialog).toContainText('1 opération');
  await dialog.getByRole('button', { name: 'Annuler' }).click();
  await expect(page).toHaveURL(/\/declarations\//);

  // the device is locked (nothing lost), then somebody else tries to use it
  await pill(page).click();
  await page.getByRole('button', { name: "Verrouiller l'appareil" }).click();
  await expect(page).toHaveURL(/\/verrouillage/);
  await page.getByRole('button', { name: 'Utiliser un autre compte' }).click();
  await expect(page.locator('.alert-danger')).toContainText('Impossible de changer de compte');

  await context.setOffline(false);
  await signIn(page, 'agent2.e2e');
  await expect(page).toHaveURL(/\/login\?blocked=1/);
  await expect(page.locator('.alert-danger')).toContainText('non synchronisées');

  // the owner comes back, synchronises, and may then sign out — which leaves the device clean
  await page.goto('/verrouillage');
  await page.locator('#code').fill(PIN);
  await page.getByRole('button', { name: 'Déverrouiller' }).click();
  await expect(page).toHaveURL(/\/declarations/);
  await expect(page.locator('tbody tr', { hasText: 'Bloquee' }).locator('wk-sync')).toContainText('En ligne');
  await page.locator('.sidebar .logout').click();
  await expect(page).toHaveURL(/\/login/);
  expect(await page.evaluate(() => localStorage.getItem('wk_vault'))).toBeNull();
  expect(await page.evaluate(async () => (await indexedDB.databases()).filter(d => d.name?.startsWith('wakara-offline-')).length)).toBe(0);
});
