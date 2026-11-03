import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// Debug screenshots, not assertions. Written under test-results/, which is gitignored and already
// the directory CI uploads as a failure artifact.
const SHOTS = fileURLToPath(new URL('../test-results/screenshots', import.meta.url));

/** Taps the four digits of a code on the on-screen keypad. */
async function tapCode(page: Page, code: string): Promise<void> {
  for (const digit of code) await page.getByRole('button', { name: digit, exact: true }).click();
}

const FILLER = [
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

/**
 * Plays guesses until the game shows a result. Waits for either the player's next turn or the
 * result, because the computer can end the game on its own move and "Your turn" never comes back.
 */
async function playToTheEnd(page: Page): Promise<void> {
  const result = page.getByTestId('result');
  const yourTurn = page.getByText('Your turn');
  for (const code of FILLER) {
    await expect(result.or(yourTurn)).toBeVisible({ timeout: 20_000 });
    if (await result.isVisible()) return;
    await tapCode(page, code);
    await page.getByRole('button', { name: 'Guess' }).click();
  }
  await expect(result).toBeVisible({ timeout: 20_000 });
}

test.describe('home', () => {
  test('explains the game on the first screen and offers both modes', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Accident' })).toBeVisible();
    await expect(page.getByText('dead', { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play the computer' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play a friend' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/01-home.png` });
  });

  test('a stranger can make a first guess within a few taps and seconds', async ({ page }) => {
    const started = Date.now();
    await page.goto('/');
    await page.getByRole('button', { name: 'Play the computer' }).click();
    await page.getByRole('button', { name: 'Pick one for me' }).click();
    await tapCode(page, '1234');
    await page.getByRole('button', { name: 'Guess' }).click();
    await expect(page.getByTestId('board-row').first()).toBeVisible();
    // PRD target: a first guess within 15 seconds of page load, including human tapping time.
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  test('how to play shows the worked example', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'How to play' }).click();
    await expect(page.getByText('2604').first()).toBeVisible();
    await expect(page.getByLabel('1 dead, 1 injured')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/02-how.png` });
  });
});

test.describe('the keypad', () => {
  test('refuses a repeated digit because the button is disabled', async ({ page }) => {
    await page.goto('/practice');
    await page.getByRole('button', { name: '1', exact: true }).click();
    await expect(page.getByRole('button', { name: '1', exact: true })).toBeDisabled();
    await expect(page.getByTestId('slot-0')).toHaveText('1');
  });

  test('Start stays disabled until four digits are chosen', async ({ page }) => {
    await page.goto('/practice');
    const start = page.getByRole('button', { name: 'Start' });
    await expect(start).toBeDisabled();
    await tapCode(page, '123');
    await expect(start).toBeDisabled();
    await tapCode(page, '4');
    await expect(start).toBeEnabled();
  });

  test('delete removes the last digit and frees it to be used again', async ({ page }) => {
    await page.goto('/practice');
    await tapCode(page, '12');
    await page.getByRole('button', { name: 'Delete last digit' }).click();
    await expect(page.getByTestId('slot-1')).toHaveText('');
    await expect(page.getByRole('button', { name: '2', exact: true })).toBeEnabled();
  });

  test('works from a hardware keyboard too', async ({ page }) => {
    await page.goto('/practice');
    await page.keyboard.type('1964');
    await expect(page.getByTestId('slot-3')).toHaveText('4');
    await page.keyboard.press('Backspace');
    await expect(page.getByTestId('slot-3')).toHaveText('');
    await page.keyboard.type('4');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Your turn')).toBeVisible();
  });
});

test.describe('a full practice game', () => {
  test('plays to a result, answers correctly, and records stats', async ({ page }) => {
    await page.goto('/practice');
    await page.getByRole('button', { name: /^Easy/ }).click();
    await tapCode(page, '1964');
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByText('Your turn')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/03-practice-start.png` });

    // The first guess shows an answer with dead and injured counts.
    await tapCode(page, '0123');
    await page.getByRole('button', { name: 'Guess' }).click();
    const firstRow = page.getByTestId('board-row').first();
    await expect(firstRow).toContainText('0123');
    await expect(firstRow.getByLabel(/\d dead, \d injured/)).toBeVisible();

    await playToTheEnd(page);
    await page.screenshot({ path: `${SHOTS}/04-practice-result.png` });

    // Stats were recorded.
    await page.getByRole('button', { name: 'Home' }).click();
    await page.getByRole('button', { name: 'My stats' }).click();
    await expect(page.getByLabel('Easy')).toContainText('1');
  });

  test('announces moves to screen readers', async ({ page }) => {
    await page.goto('/practice');
    await tapCode(page, '1964');
    await page.getByRole('button', { name: 'Start' }).click();
    await tapCode(page, '1234');
    await page.getByRole('button', { name: 'Guess' }).click();
    await expect(page.getByTestId('announcer')).toContainText(
      /You guessed 1234: \d dead, \d injured/,
    );
  });

  test('a finished game can be started again', async ({ page }) => {
    await page.goto('/practice');
    await page.getByRole('button', { name: /^Easy/ }).click();
    await tapCode(page, '1964');
    await page.getByRole('button', { name: 'Start' }).click();
    await playToTheEnd(page);
    await page.getByRole('button', { name: 'Play again' }).click();
    await expect(page.getByText('Pick your secret')).toBeVisible();
  });
});

test.describe('leaving and bad links', () => {
  test('leaving a game in progress asks first', async ({ page }) => {
    await page.goto('/practice');
    await tapCode(page, '1964');
    await page.getByRole('button', { name: 'Start' }).click();
    let asked = false;
    page.once('dialog', (dialog) => {
      asked = true;
      void dialog.dismiss();
    });
    await page.getByRole('button', { name: 'Back' }).click();
    expect(asked).toBe(true);
    await expect(page.getByText('Your turn')).toBeVisible();
  });

  test('a room link with an impossible code shows a friendly page instead of crashing', async ({
    page,
  }) => {
    await page.goto('/r/ABC0O1'); // 0, O and 1 are never used in room codes
    await expect(page.getByText(/does not look right/)).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/05-notfound.png` });
  });

  test('an unknown page is handled', async ({ page }) => {
    await page.goto('/nowhere');
    await expect(page.getByText(/does not look right/)).toBeVisible();
  });
});

test.describe('offline', () => {
  test('practice keeps working after the app has been loaded once, with no network', async ({
    page,
    context,
  }) => {
    await page.goto('/');
    // Wait for the service worker to take control of the page.
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Play the computer' })).toBeVisible();

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Play the computer' })).toBeVisible();
    await page.getByRole('button', { name: 'Play the computer' }).click();
    await tapCode(page, '1964');
    await page.getByRole('button', { name: 'Start' }).click();
    await tapCode(page, '1234');
    await page.getByRole('button', { name: 'Guess' }).click();
    await expect(page.getByTestId('board-row').first()).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Computer (1)' })).toBeVisible({ timeout: 20_000 });
  });
});
