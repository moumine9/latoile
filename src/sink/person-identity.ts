/**
 * Person identity resolution for the knowledge graph.
 *
 * The three sources name people differently:
 *   - Jira assignee:    display name  ("Karianne Verville-Paris")
 *   - GitLab MR author: username      ("kvervilleparis")
 *   - Commit author:    git name      ("Karianne Verville-Paris")
 *
 * Team usernames follow first-name-initials + last name, where a hyphenated
 * first name contributes one initial per part: "Karianne Verville-Paris" →
 * `k` + `vervilleparis`, "Jean-Sébastien Roy" → `js` + `roy`. Both forms
 * reduce to the same canonical key: display names are derived per that rule,
 * usernames are normalized as-is. `:Person` nodes MERGE on that key and keep
 * the source-specific spellings as properties (name / jiraName /
 * gitlabUsername).
 *
 * Known limitation: two people sharing a first initial and last name collide.
 * Accepted for now — see PLAN-NEO4J.md (identity mapping table if it happens).
 */

/** Lowercases, strips accents, drops everything but letters and digits. */
export function normalizePersonToken(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]/g, '');
}

/** True when the value looks like a display name rather than a username. */
export function isDisplayName(value: string): boolean {
  return /\s/.test(value.trim());
}

/**
 * Bump when the key derivation changes: the sink deletes Person nodes written
 * under an older version so they re-materialize under the current keys.
 */
export const PERSON_SCHEMA_VERSION = 2;

/**
 * Canonical Person key. Display names become first-name initials (one per
 * hyphen-separated part) + remaining tokens: "Karianne Verville-Paris" →
 * "kvervilleparis", "Jean-Sébastien Roy" → "jsroy" — matching the team's
 * GitLab username convention. Usernames are just normalized.
 */
export function personKey(value: string): string {
  const trimmed = value.trim();
  if (!isDisplayName(trimmed)) return normalizePersonToken(trimmed);
  const tokens = trimmed.split(/\s+/);
  const rest = tokens.slice(1).map(normalizePersonToken).join('');
  if (!rest) return normalizePersonToken(tokens[0] ?? '');
  const initials = (tokens[0] ?? '')
    .split('-')
    .map((part) => normalizePersonToken(part).charAt(0))
    .join('');
  return initials + rest;
}
