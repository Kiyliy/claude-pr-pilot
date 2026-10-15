import { getDb } from "./connection";

export interface AutofixStateRow {
  rounds: number;
  isManual: boolean;
  headSha: string | null;
}

export function getAutofixState(prKey: string): AutofixStateRow | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT rounds, is_manual, head_sha FROM autofix_state WHERE pr_key = ?"
  ).get(prKey) as { rounds: number; is_manual: number; head_sha: string | null } | undefined;
  if (!row) return null;
  return { rounds: row.rounds, isManual: row.is_manual !== 0, headSha: row.head_sha };
}

export function setAutofixRounds(prKey: string, rounds: number, isManual: boolean): void {
  const db = getDb();
  // Preserve existing head_sha if row already exists
  db.prepare(`
    INSERT INTO autofix_state (pr_key, rounds, is_manual, updated_at)
      VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(pr_key) DO UPDATE SET
      rounds = excluded.rounds,
      is_manual = excluded.is_manual,
      updated_at = datetime('now')
  `).run(prKey, rounds, isManual ? 1 : 0);
}

export function setAutofixHeadSHA(prKey: string, sha: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO autofix_state (pr_key, rounds, is_manual, head_sha, updated_at)
      VALUES (?, 0, 0, ?, datetime('now'))
    ON CONFLICT(pr_key) DO UPDATE SET
      head_sha = excluded.head_sha,
      updated_at = datetime('now')
  `).run(prKey, sha);
}

export function clearAutofixHeadSHA(prKey: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE autofix_state SET head_sha = NULL, updated_at = datetime('now') WHERE pr_key = ?"
  ).run(prKey);
}

export function clearAutofixRoundsAndManual(prKey: string): void {
  const db = getDb();
  // If head_sha is also null after clearing, remove the row entirely to keep the table tidy
  const row = db.prepare(
    "SELECT head_sha FROM autofix_state WHERE pr_key = ?"
  ).get(prKey) as { head_sha: string | null } | undefined;
  if (!row) return;
  if (row.head_sha === null) {
    db.prepare("DELETE FROM autofix_state WHERE pr_key = ?").run(prKey);
  } else {
    db.prepare(
      "UPDATE autofix_state SET rounds = 0, is_manual = 0, updated_at = datetime('now') WHERE pr_key = ?"
    ).run(prKey);
  }
}

export function deleteAutofixState(prKey: string): void {
  const db = getDb();
  db.prepare("DELETE FROM autofix_state WHERE pr_key = ?").run(prKey);
}

/** Delete all autofix state rows — used only in tests via _resetAutoFixState(). */
export function clearAllAutofixState(): void {
  const db = getDb();
  db.prepare("DELETE FROM autofix_state").run();
}
