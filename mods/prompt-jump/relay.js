// Liveness through shared state: the relay and the panel each beat a key, and a key press the relay forwards
// while no panel runs shows the panel, which then takes that press.

/** How long a press that showed the panel stays for the copy it starts: its start and first list */
export const WAKE_MS = 5000;

/** A copy beating every `period` ms is running while its last beat is younger than two and a half periods */
export function alive(beat, period, now) {
  return !!beat && now - beat.at < period * 2.5;
}

/** Whether a forwarded step showed the panel and is still young enough for the copy that starts from it */
export function waking(step, now) {
  return !!step?.wake && now - step.at < WAKE_MS;
}
