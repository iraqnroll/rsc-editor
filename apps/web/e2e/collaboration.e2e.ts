import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Two editors, one sector: the Phase 3 claims, proven in a real browser.
 *
 * Each run makes its own project and users, so it never touches real work.
 * Projects cannot be deleted over the API yet, so they accumulate in the dev
 * database under the `e2e-` users, who are the only ones who can see them.
 */

interface Editor {
  api: APIRequestContext;
  id: string;
  name: string;
}

async function login(baseURL: string, name: string): Promise<Editor> {
  const api = await request.newContext({ baseURL });
  const response = await api.post('/api/auth/dev-login', { data: { username: name } });
  expect(response.ok(), 'dev login -- is RSC_DEV_LOGIN=1 set on the server?').toBe(true);
  const { user } = (await response.json()) as { user: { id: string } };
  return { api, id: user.id, name };
}

async function openEditor(browser: import('@playwright/test').Browser, who: Editor): Promise<Page> {
  const context = await browser.newContext({ storageState: await who.api.storageState() });
  const page = await context.newPage();
  await page.goto('/');
  // One project each, so the app opens it without asking.
  await expect(status(page).getByText('sector 0/50/50')).toBeVisible();
  return page;
}

/** The status bar: the one place that states lock, presence and sequence. */
function status(page: Page) {
  return page.getByRole('contentinfo');
}

/** The server's head sequence as this editor's status bar reports it. */
async function seq(page: Page): Promise<number> {
  const text = await status(page).getByText(/undo · seq \d+/).innerText();
  return Number(/seq (\d+)/.exec(text)![1]);
}

/** `seq` once it has stopped moving: a drag's ops arrive over several frames. */
async function settledSeq(page: Page): Promise<number> {
  let last = await seq(page);
  for (;;) {
    await page.waitForTimeout(400);
    const now = await seq(page);
    if (now === last) return now;
    last = now;
  }
}

async function stroke(page: Page): Promise<void> {
  const box = (await page.locator('.pane--center canvas').first().boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(x + i * 6, y);
  await page.mouse.up();
}

/** A fresh project with one empty sector, 0/50/50, and both users as editors. */
async function setUp(baseURL: string): Promise<{ alice: Editor; bob: Editor }> {
  const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const alice = await login(baseURL, `e2e-alice-${tag}`);
  const bob = await login(baseURL, `e2e-bob-${tag}`);

  const created = await alice.api.post('/api/projects', { data: { name: `e2e ${tag}` } });
  const projectId = ((await created.json()) as { project: { id: string } }).project.id;
  expect((await alice.api.post(`/api/projects/${projectId}/sectors/0/50/50`)).status()).toBe(201);
  expect(
    (await alice.api.put(`/api/projects/${projectId}/members/${bob.id}`, { data: { role: 'editor' } })).ok()
  ).toBe(true);
  return { alice, bob };
}

test('every editing tool writes an op that a peer receives', async ({ browser, baseURL }) => {
  const { alice, bob } = await setUp(baseURL!);
  const a = await openEditor(browser, alice);
  const b = await openEditor(browser, bob);
  await a.getByRole('button', { name: 'Claim', exact: true }).click();
  await expect(status(a).getByText('you hold this sector')).toBeVisible();

  for (const tool of ['Elevation', 'Paint', 'Walls', 'Roof', 'Scenery', 'Region']) {
    await test.step(tool, async () => {
      const head = await seq(a);
      await a.getByRole('button', { name: new RegExp(`${tool}$`) }).first().click();
      await stroke(a);
      if (tool === 'Region') {
        // The drag above made a selection; the write is a fill of it, with a
        // value that is not what an empty sector already holds.
        await a.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'fill' }).click();
        await a.getByRole('spinbutton', { name: 'Value' }).fill('7');
        const box = (await a.locator('.pane--center canvas').first().boundingBox())!;
        await a.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      }
      await expect.poll(() => seq(a), { message: `${tool} wrote nothing` }).toBeGreaterThan(head);
      const after = await settledSeq(a);
      await expect.poll(() => seq(b)).toBe(after);
    });
  }
});

test('two editors share a sector through locks, live ops and undo', async ({ browser, baseURL }) => {
  const { alice, bob } = await setUp(baseURL!);

  const a = await openEditor(browser, alice);
  const b = await openEditor(browser, bob);

  await test.step('a cold load does not report the project as missing', async () => {
    // The world map used to ask before the project was open and show
    // "map failed: No project is open." on every fresh load.
    await a.waitForTimeout(1500);
    await expect(a.getByText(/map failed/)).toHaveCount(0);
  });

  await test.step('presence: each sees the other', async () => {
    await expect(status(a).getByText(bob.name)).toBeVisible();
    await expect(status(b).getByText(alice.name)).toBeVisible();
  });

  await test.step('lock: alice claims, bob is read-only', async () => {
    await a.getByRole('button', { name: 'Claim', exact: true }).click();
    await expect(status(a).getByText('you hold this sector')).toBeVisible();
    await expect(status(b).getByText(`read-only — held by ${alice.name}`)).toBeVisible();
  });

  const before = await seq(a);
  let strokeOps = 0;

  await test.step('ops: alice edits, bob receives them live', async () => {
    await a.getByRole('button', { name: /Elevation/ }).click();
    await stroke(a);
    await expect.poll(() => seq(a)).toBeGreaterThan(before);
    const after = await settledSeq(a);
    await expect.poll(() => seq(b)).toBe(after);
    // Several ops, one gesture, one undo step.
    strokeOps = after - before;
    expect(strokeOps).toBeGreaterThan(1);
    await expect(status(a).getByText(/^1 undo · /)).toBeVisible();
  });

  await test.step('bob cannot write into alice’s sector', async () => {
    const head = await seq(b);
    await b.getByRole('button', { name: /Elevation/ }).click();
    await stroke(b);
    await b.waitForTimeout(1000);
    expect(await seq(b)).toBe(head);
    expect(await seq(a)).toBe(head);
  });

  await test.step('undo reaches the server and bob', async () => {
    const head = await seq(a);
    await a.getByRole('button', { name: 'Undo' }).click();
    // An undo is an op like any other: sequenced, logged and broadcast.
    await expect.poll(() => seq(a)).toBeGreaterThan(head);
    const after = await settledSeq(a);
    await expect.poll(() => seq(b)).toBe(after);
    // One undo takes back the whole drag, not its last tile.
    expect(after - head).toBe(strokeOps);

    const redoHead = after;
    await a.getByRole('button', { name: 'Redo' }).click();
    await expect.poll(() => seq(a)).toBeGreaterThan(redoHead);
  });

  await test.step('the log survives a reload', async () => {
    const head = await settledSeq(a);
    await a.reload();
    await expect(status(a).getByText('sector 0/50/50')).toBeVisible();
    await expect.poll(() => seq(a)).toBe(head);
  });

  await test.step('alice leaving releases the lock to bob', async () => {
    await a.context().close();
    await expect(status(b).getByText(`read-only — held by ${alice.name}`)).toBeHidden({ timeout: 60_000 });
    await b.getByRole('button', { name: 'Claim', exact: true }).click();
    await expect(status(b).getByText('you hold this sector')).toBeVisible();
  });
});
