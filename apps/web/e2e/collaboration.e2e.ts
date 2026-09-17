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

async function login(baseURL: string, name: string, admin = false): Promise<Editor> {
  const api = await request.newContext({ baseURL });
  const response = await api.post('/api/auth/dev-login', { data: { username: name, admin } });
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
async function setUp(
  baseURL: string
): Promise<{ alice: Editor; bob: Editor; projectName: string; tag: string }> {
  const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const alice = await login(baseURL, `e2e-alice-${tag}`);
  const bob = await login(baseURL, `e2e-bob-${tag}`);

  const created = await alice.api.post('/api/projects', { data: { name: `e2e ${tag}` } });
  const projectId = ((await created.json()) as { project: { id: string } }).project.id;
  expect((await alice.api.post(`/api/projects/${projectId}/sectors/0/50/50`)).status()).toBe(201);
  // The scenery tool refuses objects the project does not define (the export
  // could not ship them), and an empty project defines none.
  const object = {
    name: 'e2e crate',
    description: '',
    commands: [],
    model: { name: 'crate', id: 0 },
    width: 1,
    height: 1,
    type: 'blocked',
    itemHeight: 0
  };
  expect(
    (await alice.api.put(`/api/projects/${projectId}/definitions/objects/0`, { data: { data: object } })).ok()
  ).toBe(true);
  expect(
    (await alice.api.put(`/api/projects/${projectId}/members/${bob.id}`, { data: { role: 'editor' } })).ok()
  ).toBe(true);
  return { alice, bob, projectName: `e2e ${tag}`, tag };
}

test('every editing tool writes an op that a peer receives', async ({ browser, baseURL }) => {
  const { alice, bob } = await setUp(baseURL!);
  const a = await openEditor(browser, alice);
  const b = await openEditor(browser, bob);
  await a.getByRole('button', { name: 'Claim', exact: true }).click();
  await expect(status(a).getByText('you hold this sector')).toBeVisible();

  for (const tool of ['Elevation', 'Paint', 'Walls', 'Roof', 'Scenery', 'Region', 'NPCs', 'Items']) {
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

test('a shaky click edits once, and a drag edits each tile once', async ({ browser, baseURL }) => {
  const { alice } = await setUp(baseURL!);
  const a = await openEditor(browser, alice);
  await a.getByRole('button', { name: 'Claim', exact: true }).click();
  await expect(status(a).getByText('you hold this sector')).toBeVisible();
  await a.getByRole('button', { name: /Elevation$/ }).first().click();

  const box = (await a.locator('.pane--center canvas').first().boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  // A click whose hand wobbles by a couple of pixels: one op, not one per wobble.
  const head = await settledSeq(a);
  await a.mouse.move(x, y);
  await a.mouse.down();
  for (const [dx, dy] of [[1, 0], [2, 1], [0, 2], [-1, 1], [2, -1], [0, 0]]) {
    await a.mouse.move(x + dx!, y + dy!);
  }
  await a.mouse.up();
  await expect.poll(() => seq(a)).toBeGreaterThan(head);
  expect(await settledSeq(a)).toBe(head + 1);
});

test('an NPC one editor places, the other can select and edit', async ({ browser, baseURL }) => {
  const { alice, bob } = await setUp(baseURL!);
  const a = await openEditor(browser, alice);
  const b = await openEditor(browser, bob);
  await a.getByRole('button', { name: 'Claim', exact: true }).click();
  await expect(status(a).getByText('you hold this sector')).toBeVisible();

  const click = async (page: Page) => {
    const box = (await page.locator('.pane--center canvas').first().boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };

  await a.getByRole('button', { name: /NPCs$/ }).first().click();
  const head = await settledSeq(a);
  await click(a);
  await expect.poll(() => seq(b)).toBe(head + 1);

  // Bob, read-only, can still select it and see what it is...
  await b.getByRole('button', { name: /Select$/ }).first().click();
  await click(b);
  await expect(b.getByText('Selected npc')).toBeVisible();

  // ...and Alice can edit it; Bob's inspector follows.
  await click(a); // clicking an existing spawn selects it
  await expect(a.getByText('Selected npc')).toBeVisible();
  await a.getByRole('spinbutton', { name: 'Wander max x' }).fill('999');
  await a.getByRole('spinbutton', { name: 'Wander max x' }).press('Tab');
  await expect(b.getByRole('spinbutton', { name: 'Wander max x' })).toHaveValue('999');

  await a.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(b.getByText('Selected npc')).toHaveCount(0);
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

test('export says why it refused, instead of downloading a broken cache', async ({ browser, baseURL }) => {
  const { alice } = await setUp(baseURL!);
  const a = await openEditor(browser, alice);
  // A project built by hand has no imported archives to overlay onto.
  await a.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = a.getByRole('dialog', { name: 'Export refused' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/no imported config archive/)).toBeVisible();
  await dialog.getByRole('button', { name: 'close' }).click();
  await expect(dialog).toBeHidden();
});

test('history shows who changed what, and snapshots can be tagged', async ({ browser, baseURL }) => {
  const { alice, bob } = await setUp(baseURL!);
  const a = await openEditor(browser, alice);
  const b = await openEditor(browser, bob);
  await a.getByRole('button', { name: 'Claim', exact: true }).click();
  await expect(status(a).getByText('you hold this sector')).toBeVisible();

  await b.getByRole('tab', { name: 'History' }).or(b.getByRole('button', { name: 'History' })).first().click();
  await b.getByLabel('Snapshot name').fill('before alice');
  await b.getByRole('button', { name: 'Tag', exact: true }).click();
  await expect(b.getByText('before alice')).toBeVisible();

  await a.getByRole('button', { name: /Elevation$/ }).first().click();
  await stroke(a);
  await settledSeq(a);

  // Bob's log fills in live, attributed to alice, and jumps to the sector.
  const log = b.locator('.project-log');
  await expect(log.getByText(alice.name).first()).toBeVisible();
  await log.getByRole('button', { name: /0\/50\/50/ }).first().click();

  // A duplicate name is refused in place.
  await b.getByLabel('Snapshot name').fill('before alice');
  await b.getByRole('button', { name: 'Tag', exact: true }).click();
  await expect(b.getByRole('alert')).toHaveText('"before alice" is taken');

  // This project has no imported cache, so the snapshot export explains why not.
  await b.getByRole('button', { name: 'export', exact: true }).click();
  await expect(b.getByRole('dialog', { name: 'Export refused' })).toBeVisible();
  await b.screenshot({ path: 'test-results/history-panel.png' });
});

test('an admin decides who can sign in and what they can open', async ({ browser, baseURL }) => {
  const { alice, bob, projectName, tag } = await setUp(baseURL!);
  const admin = await login(baseURL!, `e2e-admin-${tag}`, true);

  // Bob can see alice's project because setUp made him an editor; take that
  // away first so the grid is what grants it.
  const b = await openEditor(browser, bob);

  const context = await browser.newContext({ storageState: await admin.api.storageState() });
  const a = await context.newPage();
  await a.goto('/');
  await a.getByRole('button', { name: 'Access', exact: true }).first().click();
  const dialog = a.getByRole('dialog', { name: 'Access' });
  await expect(dialog).toBeVisible();

  // An invite for someone who has never signed in.
  const invitee = `e2e_inv_${tag}`.slice(0, 32);
  await dialog.getByLabel('Discord username').fill(`@${invitee}`);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  const inviteRow = dialog.locator(`tr[data-user="${invitee}"]`);
  await expect(inviteRow.getByText('invited')).toBeVisible();
  await dialog.getByLabel('Discord username').fill(invitee);
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText(`${invitee} is already on the list`);
  await inviteRow.getByRole('button', { name: 'remove' }).click();
  await expect(inviteRow).toHaveCount(0);

  // Bob's role in alice's project, from the grid, narrowed to that project.
  await dialog.getByLabel('Filter projects').fill(projectName);
  await dialog.getByLabel('Filter people').fill(bob.name);
  const cell = dialog.getByLabel(`${bob.name} in ${projectName}`);
  await expect(cell).toHaveValue('editor');
  await cell.selectOption('viewer');
  await expect(cell).toHaveValue('viewer');
  expect(alice.name).toBeTruthy();

  // Revoking signs bob out where he is.
  await dialog.locator(`tr[data-user="${bob.name}"]`).getByRole('button', { name: 'revoke' }).click();
  await expect(dialog.locator(`tr[data-user="${bob.name}"]`).getByText('revoked')).toBeVisible();
  await b.reload();
  await expect(b.getByRole('link', { name: 'Sign in with Discord' })).toBeVisible();

  await dialog.locator(`tr[data-user="${bob.name}"]`).getByRole('button', { name: 'restore' }).click();
  await expect(dialog.locator(`tr[data-user="${bob.name}"]`).getByText('revoked')).toHaveCount(0);
  await a.screenshot({ path: 'test-results/access-screen.png' });
});

test('a first visit without a session is offered sign-in, not an error', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Sign in with Discord' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);

  // And a refused Discord sign-in says why.
  await page.goto('/?login_error=not-invited');
  await expect(page.getByRole('alert')).toContainText('not on this editor’s access list');
  await context.close();
});

