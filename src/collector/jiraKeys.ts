/**
 * Jira issue keys look like `ABC-123`: one or more uppercase letters, a hyphen,
 * and digits. We require a word boundary so we do not match things like
 * `feature/JIRA-123-checkout` incorrectly (that still matches `JIRA-123`).
 */
export const JIRA_KEY_REGEX = /\b[A-Z][A-Z0-9]+-\d+\b/g;

/**
 * Validates a single Jira key. Acts as a type guard so callers can narrow
 * `string | undefined` values down to `string`.
 */
export function isJiraKey(value: string | undefined | null): value is string {
  if (typeof value !== 'string') return false;
  return /^[A-Z][A-Z0-9]+-\d+$/.test(value.trim());
}

/** Extracts every distinct Jira key mentioned in a block of text. */
export function extractJiraKeys(text: string | undefined | null): string[] {
  if (!text || typeof text !== 'string') return [];
  const matches = text.match(JIRA_KEY_REGEX) || [];
  return [...new Set(matches)];
}

export default extractJiraKeys;
