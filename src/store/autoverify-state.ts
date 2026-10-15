import { getDb } from "./connection";

export interface AutoverifyStateRow {
  verifyRounds: number;
}

export function getAutoverifyState(prKey: string): AutoverifyStateRow | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT verify_rounds FROM autoverify_state WHERE pr_key = ?"
  ).get(prKey) as { verify_rounds: number } | undefined;
  if (!row) return null;
  return { verifyRounds: row.verify_rounds };
}

export function setAutoverifyRounds(prKey: string, rounds: number): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO autoverify_state (pr_key, verify_rounds, updated_at)
      VALUES (?, ?, datetime('now'))
    ON CONFLICT(pr_key) DO UPDATE SET
      verify_rounds = excluded.verify_rounds,
      updated_at = datetime('now')
  `).run(prKey, rounds);
}

export function deleteAutoverifyState(prKey: string): void {
  const db = getDb();
  db.prepare("DELETE FROM autoverify_state WHERE pr_key = ?").run(prKey);
}

/** Delete all rows — used only in tests. */
export function clearAllAutoverifyState(): void {
  const db = getDb();
  db.prepare("DELETE FROM autoverify_state").run();
}
