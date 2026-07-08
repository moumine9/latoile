/**
 * Jira issue keys look like `ABC-123`: one or more uppercase letters, a hyphen,
 * and digits. We require a word boundary so we do not match things like
 * `feature/JIRA-123-checkout` incorrectly (that still matches `JIRA-123`).
 */
export const JIRA_KEY_REGEX = /\b[A-Z][A-Z0-9]+-\d+\b/g;

/**
 * Validates a single Jira key.
 * @param {string} value
 * @returns {boolean}
 */
export function isJiraKey(value) {
  if (typeof value !== 'string') return false;
  return /^[A-Z][A-Z0-9]+-\d+$/.test(value.trim());
}

/**
 * Extracts every distinct Jira key mentioned in a block of text.
 * @param {string} [text]
 * @returns {string[]}
 */
export function extractJiraKeys(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = text.match(JIRA_KEY_REGEX) || [];
  return [...new Set(matches)];
}

export default extractJiraKeys;
