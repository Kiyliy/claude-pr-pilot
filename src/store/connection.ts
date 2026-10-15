import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { ROOT_DIR } from "../config";
import { log } from "../utils/logger";

const DB_DIR = path.join(ROOT_DIR, "data");
const DB_PATH = path.join(DB_DIR, "store.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  fs.mkdirSync(DB_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  migrate(_db);
  log(`SQLite store initialized at ${DB_PATH}`);
  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    -- PR topic mappings: chatId + prNumber → threadId
    CREATE TABLE IF NOT EXISTS pr_topics (
      chat_id   TEXT    NOT NULL,
      pr_number INTEGER NOT NULL,
      thread_id INTEGER NOT NULL,
      PRIMARY KEY (chat_id, pr_number)
    );

    -- Standalone topic metadata
    CREATE TABLE IF NOT EXISTS standalone_topics (
      chat_id     TEXT    NOT NULL,
      thread_id   INTEGER NOT NULL,
      repo        TEXT    NOT NULL,
      branch      TEXT,
      pr_number   INTEGER,
      description TEXT,
      PRIMARY KEY (chat_id, thread_id)
    );

    -- GitHub comment ↔ TG message mapping
    CREATE TABLE IF NOT EXISTS message_refs (
      repo       TEXT    NOT NULL,
      pr_number  INTEGER NOT NULL,
      comment_id INTEGER NOT NULL,
      chat_id    TEXT    NOT NULL,
      thread_id  INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      PRIMARY KEY (repo, pr_number, comment_id)
    );

    -- Topic conversation history (for context injection)
    CREATE TABLE IF NOT EXISTS topic_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id    TEXT    NOT NULL,
      thread_id  INTEGER NOT NULL,
      role       TEXT    NOT NULL,  -- 'user' | 'assistant' | 'command'
      author     TEXT,
      content    TEXT    NOT NULL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_topic_messages_thread
      ON topic_messages(chat_id, thread_id);

    -- Auto-fix state: replaces in-memory Maps in autofix.ts
    CREATE TABLE IF NOT EXISTS autofix_state (
      pr_key     TEXT    NOT NULL PRIMARY KEY,  -- "owner/repo#prNumber"
      rounds     INTEGER NOT NULL DEFAULT 0,
      is_manual  INTEGER NOT NULL DEFAULT 0,    -- 0/1 boolean
      head_sha   TEXT,
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Auto-verify state: tracks product verification cycles per PR
    CREATE TABLE IF NOT EXISTS autoverify_state (
      pr_key        TEXT    NOT NULL PRIMARY KEY,  -- "owner/repo#prNumber"
      verify_rounds INTEGER NOT NULL DEFAULT 0,
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migration: standalone_topics add issue_number column
  const stColInfo = db.prepare("PRAGMA table_info(standalone_topics)").all() as { name: string; type: string }[];
  if (!stColInfo.find((c) => c.name === "issue_number")) {
    log("Migrating standalone_topics: adding issue_number column...");
    db.exec(`ALTER TABLE standalone_topics ADD COLUMN issue_number INTEGER;`);
    log("Migration complete.");
  }

  // Migration: pr_topics add base_title column
  const prColInfo = db.prepare("PRAGMA table_info(pr_topics)").all() as { name: string; type: string }[];
  if (!prColInfo.find((c) => c.name === "base_title")) {
    log("Migrating pr_topics: adding base_title column...");
    db.exec(`ALTER TABLE pr_topics ADD COLUMN base_title TEXT;`);
    log("Migration complete.");
  }

  // Migration: standalone_topics add description column (for PR binding verification)
  const stColInfo2 = db.prepare("PRAGMA table_info(standalone_topics)").all() as { name: string; type: string }[];
  if (!stColInfo2.find((c) => c.name === "description")) {
    log("Migrating standalone_topics: adding description column...");
    db.exec(`ALTER TABLE standalone_topics ADD COLUMN description TEXT;`);
    log("Migration complete.");
  }

  // Migration: message_refs.chat_id INTEGER → TEXT
  const colInfo = db.prepare("PRAGMA table_info(message_refs)").all() as { name: string; type: string }[];
  const chatCol = colInfo.find((c) => c.name === "chat_id");
  if (chatCol && chatCol.type === "INTEGER") {
    log("Migrating message_refs.chat_id from INTEGER to TEXT...");
    db.exec(`
      ALTER TABLE message_refs RENAME TO message_refs_old;
      CREATE TABLE message_refs (
        repo       TEXT    NOT NULL,
        pr_number  INTEGER NOT NULL,
        comment_id INTEGER NOT NULL,
        chat_id    TEXT    NOT NULL,
        thread_id  INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        PRIMARY KEY (repo, pr_number, comment_id)
      );
      INSERT INTO message_refs SELECT repo, pr_number, comment_id, CAST(chat_id AS TEXT), thread_id, message_id FROM message_refs_old;
      DROP TABLE message_refs_old;
    `);
    log("Migration complete.");
  }
}
