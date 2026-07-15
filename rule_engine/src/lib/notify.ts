const RED_COUNT_NOTIFY_THRESHOLD = 2;

/**
 * Fires a push notification (via ntfy.sh) only on the transition INTO
 * confirmed_red_count >= 2 — not every day it stays there, which would
 * otherwise re-notify daily and get ignored fast. Compares against the
 * prior crash_checks row's confirmed_red_count, which classify() already
 * fetches for other reasons (carrying forward confirmation_state).
 *
 * No-op if NTFY_TOPIC isn't configured (feature is opt-in), and swallows
 * delivery failures rather than throwing — a missed push notification
 * shouldn't fail the classify() run that already wrote the real
 * classification to Supabase.
 */
export async function notifyIfRedCountCrossedThreshold(
  priorConfirmedRedCount: number | null | undefined,
  newConfirmedRedCount: number,
): Promise<void> {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;

  const wasBelowThreshold = (priorConfirmedRedCount ?? 0) < RED_COUNT_NOTIFY_THRESHOLD;
  const isNowAtOrAboveThreshold = newConfirmedRedCount >= RED_COUNT_NOTIFY_THRESHOLD;
  if (!(wasBelowThreshold && isNowAtOrAboveThreshold)) return;

  try {
    const res = await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      headers: {
        Title: "Macro Crash Check",
        Priority: "high",
        Tags: "rotating_light",
      },
      body: `${newConfirmedRedCount} of 6 indicators are now confirmed RED — wave-authorization threshold reached. Run a crash check for details.`,
    });
    if (!res.ok) {
      console.warn(`ntfy notification failed (${res.status}): ${await res.text()}`);
    }
  } catch (err) {
    console.warn(`ntfy notification failed: ${err}`);
  }
}
