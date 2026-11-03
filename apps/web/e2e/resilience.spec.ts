import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// Debug screenshots, not assertions. Written under test-results/, which is gitignored and already
// the directory CI uploads as a failure artifact.
const SHOTS = fileURLToPath(new URL('../test-results/screenshots', import.meta.url));

async function tapCode(page: Page, code: string): Promise<void> {
  for (const digit of code) await page.getByRole('button', { name: digit, exact: true }).click();
}

/** Runs on the simulation build so two tabs can play. Pairs with the screen wake lock for risk R1. */
test.describe('the hidden-tab warning', () => {
  test('appears while playing when the tab is hidden, and clears when it returns', async ({
    context,
  }) => {
    const host = await context.newPage();
    const guest = await context.newPage();
    await host.goto('/friend?as=host');
    await host.getByRole('button', { name: 'Create a room' }).click();
    await tapCode(host, '1964');
    await host.getByRole('button', { name: /Lock it in and wait/ }).click();
    const code = await host.getByTestId('room-code').innerText();
    await guest.goto(`/r/${code}?as=guest`);
    await tapCode(guest, '4271');
    await guest.getByRole('button', { name: /Lock it in and join/ }).click();
    await expect(host.getByTestId('turn')).toBeVisible({ timeout: 20_000 });

    await expect(host.getByTestId('hidden-warning')).toBeHidden();

    await host.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(host.getByTestId('hidden-warning')).toBeVisible();
    await host.screenshot({ path: `${SHOTS}/10-hidden-warning.png` });

    await host.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(host.getByTestId('hidden-warning')).toBeHidden();
  });
});
