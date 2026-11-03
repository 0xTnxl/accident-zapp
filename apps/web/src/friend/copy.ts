/**
 * Copies text to the clipboard. Returns whether it worked, because clipboard access is refused in
 * some browsers and inside some in-app webviews, and the player must be told rather than left
 * wondering whether the link went anywhere.
 */
export async function copyText(
  text: string,
  nav: { clipboard?: { writeText?: (t: string) => Promise<void> } } = navigator,
): Promise<boolean> {
  try {
    if (!nav.clipboard?.writeText) return false;
    await nav.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Opens the phone's share sheet when there is one. Returns whether it was used. */
export async function shareText(
  data: { title: string; text: string; url: string },
  nav: { share?: (d: { title: string; text: string; url: string }) => Promise<void> } = navigator,
): Promise<boolean> {
  if (!nav.share) return false;
  try {
    await nav.share(data);
    return true;
  } catch {
    // The player closed the sheet, or sharing is blocked. Either way, fall back to copying.
    return false;
  }
}
