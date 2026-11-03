import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function tapCode(page: Page, code: string): Promise<void> {
  for (const digit of code) await page.getByRole('button', { name: digit, exact: true }).click();
}

/**
 * The live build has no analytics backend, so /api/event is intercepted. This shows what the app
 * tries to send, and that a blocked endpoint never affects the game.
 */
test.describe('analytics', () => {
  test('reports app_open on load, then the computer game start and end', async ({ page }) => {
    const events: string[] = [];
    await page.route('**/api/event', async (route) => {
      events.push((route.request().postDataJSON() as { name: string }).name);
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Play the computer' }).click();
    await page.getByRole('button', { name: /^Easy/ }).click();
    await tapCode(page, '1964');
    await page.getByRole('button', { name: 'Start' }).click();

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
    const result = page.getByTestId('result');
    for (const code of codes) {
      await expect(result.or(page.getByText('Your turn'))).toBeVisible({ timeout: 20_000 });
      if (await result.isVisible()) break;
      await tapCode(page, code);
      await page.getByRole('button', { name: 'Guess' }).click();
    }
    await expect(page.getByTestId('result')).toBeVisible({ timeout: 30_000 });

    expect(events).toContain('app_open');
    expect(events).toContain('cpu_game_start');
    expect(events).toContain('cpu_game_end');
  });

  test('a blocked analytics endpoint never breaks the game', async ({ page }) => {
    await page.route('**/api/event', (route) => route.abort());
    await page.goto('/');
    await page.getByRole('button', { name: 'Play the computer' }).click();
    await tapCode(page, '1964');
    await page.getByRole('button', { name: 'Start' }).click();
    await tapCode(page, '0123');
    await page.getByRole('button', { name: 'Guess' }).click();
    await expect(page.getByTestId('board-row').first()).toBeVisible();
  });
});
