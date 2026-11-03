import { expect, test } from '@playwright/test';

/** A build with no relay configured must say so plainly, and must not break the computer game. */
test.describe('friend mode when the app is not configured', () => {
  test('explains the situation and points to the computer game', async ({ page }) => {
    await page.goto('/friend');
    await expect(page.getByText('Friend games are not switched on here')).toBeVisible();
    await expect(page.getByTestId('config-error')).toContainText('VITE_SUPABASE_URL');
    await page.getByRole('button', { name: 'Play the computer' }).click();
    await expect(page).toHaveURL(/\/practice$/);
  });

  test('a shared room link shows the same explanation instead of a blank page', async ({
    page,
  }) => {
    await page.goto('/r/ABC234');
    await expect(page.getByText('Friend games are not switched on here')).toBeVisible();
  });

  test('reaching friend mode does not load it for people who only play the computer', async ({
    page,
  }) => {
    const loaded: string[] = [];
    page.on('request', (request) => {
      if (/FriendRoot/.test(request.url())) loaded.push(request.url());
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Play the computer' }).click();
    await expect(page.getByText('Pick your secret')).toBeVisible();
    expect(loaded).toEqual([]);
  });
});
