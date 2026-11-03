import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

/**
 * Friend mode against the simulation backend: the real app, the real session and protocol code,
 * with a pretend chain and a tab-to-tab relay. Two pages of one browser context are two players,
 * because they share `localStorage` and `BroadcastChannel`.
 *
 * Each player needs their own burner key, and they share one context, so the key is swapped by
 * giving each page its own key before the app starts.
 */
// Debug screenshots, not assertions. Written under test-results/, which is gitignored and already
// the directory CI uploads as a failure artifact.
const SHOTS = fileURLToPath(new URL('../test-results/screenshots', import.meta.url));

async function tapCode(page: Page, code: string): Promise<void> {
  for (const digit of code) await page.getByRole('button', { name: digit, exact: true }).click();
}

test.describe('friend mode (simulation backend)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/friend');
  });

  test('the lobby offers to create or join, and says it is a simulation', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Create a room' })).toBeVisible();
    await expect(page.getByLabel('Join with a code')).toBeVisible();
    await expect(page.getByTestId('simulation-banner')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/06-lobby.png` });
  });

  test('a code with forbidden letters is rejected with an explanation', async ({ page }) => {
    await page.getByLabel('Join with a code').fill('ABC0O1');
    await expect(page.getByRole('alert')).toContainText('never has the letters I or O');
    await expect(page.getByRole('button', { name: 'Join' })).toBeDisabled();
  });

  test('a good code, typed loosely, can be joined', async ({ page }) => {
    await page.getByLabel('Join with a code').fill(' abc-234 ');
    await expect(page.getByRole('button', { name: 'Join' })).toBeEnabled();
    await page.getByRole('button', { name: 'Join' }).click();
    await expect(page).toHaveURL(/\/r\/ABC234$/);
    await expect(page.getByText('Pick your secret')).toBeVisible();
  });

  test('creating a room shows a code, a link, a QR code and a waiting message', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Create a room' }).click();
    await tapCode(page, '1964');
    await page.getByRole('button', { name: /Lock it in and wait/ }).click();
    const code = await page.getByTestId('room-code').innerText();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
    await expect(page.getByTestId('waiting')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/07-waiting.png` });
  });

  test('a refresh in the waiting room keeps the game', async ({ page }) => {
    await page.getByRole('button', { name: 'Create a room' }).click();
    await tapCode(page, '1964');
    await page.getByRole('button', { name: /Lock it in and wait/ }).click();
    const code = await page.getByTestId('room-code').innerText();
    await page.reload();
    await expect(page.getByTestId('room-code')).toHaveText(code);
    await expect(page.getByTestId('waiting')).toBeVisible();
  });
});

test.describe('two players, one game', () => {
  test('play from room code to a verified result', async ({ context }) => {
    const host = await context.newPage();
    const guest = await context.newPage();

    // The host creates a room and locks in a secret.
    await host.goto('/friend?as=host');
    await host.getByRole('button', { name: 'Create a room' }).click();
    await tapCode(host, '1964');
    await host.getByRole('button', { name: /Lock it in and wait/ }).click();
    const code = await host.getByTestId('room-code').innerText();

    // The guest opens the room from the link and locks in a secret.
    const hostKey = await host.evaluate(() => {
      const key = JSON.parse(localStorage.getItem('accident:burner:v1:host') as string) as number[];
      return key.length;
    });
    expect(hostKey).toBe(64);
    await guest.goto(`/r/${code}?as=guest`);
    await tapCode(guest, '4271');
    await guest.getByRole('button', { name: /Lock it in and join/ }).click();

    // Both see the secrets being locked in, then play begins.
    await expect(host.getByTestId('turn')).toBeVisible({ timeout: 20_000 });
    await expect(guest.getByTestId('turn')).toBeVisible({ timeout: 20_000 });
    await host.screenshot({ path: `${SHOTS}/08-friend-playing.png` });

    // Take turns until the game ends. Whoever's turn it is guesses; the other answers by itself.
    const codes = [
      '0123',
      '4567',
      '8901',
      '2345',
      '6789',
      '0246',
      '1357',
      '9753',
      '8642',
      '1470',
      '2580',
      '3691',
    ];
    for (let round = 0; round < 12; round++) {
      for (const page of [host, guest]) {
        if (await host.getByTestId('result').isVisible()) break;
        if (await page.getByText('Your turn').isVisible()) {
          await tapCode(page, codes[round] as string);
          await page.getByRole('button', { name: 'Guess' }).click();
          // Wait for the answer to land before moving on: either the turn passes, or the game ends.
          await expect(
            page
              .getByTestId('result')
              .or(page.getByTestId('turn').filter({ hasNotText: /^Your turn/ })),
          ).toBeVisible({ timeout: 15_000 });
        }
      }
      if (await host.getByTestId('result').isVisible()) break;
      await host.waitForTimeout(250);
    }

    await expect(host.getByTestId('result')).toBeVisible({ timeout: 60_000 });
    await expect(guest.getByTestId('result')).toBeVisible({ timeout: 60_000 });
    await host.screenshot({ path: `${SHOTS}/09-friend-result.png` });

    // Both players see the same outcome, each from their own side, with secrets verified.
    const hostText = await host.getByTestId('result').innerText();
    const guestText = await guest.getByTestId('result').innerText();
    if (hostText === 'You win!') expect(guestText).toBe('Your friend wins');
    else if (hostText === 'Your friend wins') expect(guestText).toBe('You win!');
    else expect(guestText).toBe(hostText);
    await expect(host.getByText('1964').first()).toBeVisible();
    await expect(host.getByText('4271').first()).toBeVisible();
    await expect(host.getByText('Checked against the lock-in').first()).toBeVisible();
    await expect(host.getByText('Every answer matched the revealed secrets.')).toBeVisible();
  });
});
