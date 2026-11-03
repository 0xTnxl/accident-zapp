import { expect, test } from '@playwright/test';

/**
 * The Verifier form must render and validate before touching the chain. A full happy path needs a
 * real reveal Memo on devnet, which is unavailable (the faucet returns 429), so the verdict path is
 * covered by the jsdom component test against the in-memory chain instead.
 */
test.describe('verifier page', () => {
  test('renders the form: two signature inputs, a file input and the check button', async ({
    page,
  }) => {
    await page.goto('/verify');
    await expect(page.getByTestId('sig0')).toBeVisible();
    await expect(page.getByTestId('sig1')).toBeVisible();
    await expect(page.getByTestId('transcript')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check this game' })).toBeVisible();
  });

  test('shows a friendly message when checking with no file', async ({ page }) => {
    await page.goto('/verify');
    await page.getByRole('button', { name: 'Check this game' }).click();
    await expect(page.getByTestId('error')).toContainText('transcript file');
  });
});
