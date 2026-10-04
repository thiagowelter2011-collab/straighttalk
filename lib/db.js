// Banco de dados.
//  - Padrão: SQLite embutido no Node (arquivo local, sem instalar nada a mais).
//  - Com DATABASE_URL (ex.: libsql://meu-banco.turso.io): banco na nuvem (Turso), para hospedagens
//    grátis em que o disco é apagado a cada reinício (Render, Koyeb...).
// As duas opções falam o mesmo SQL e têm a mesma interface assíncrona: get, all, run, close.

const path = require('path');
const fs = require('fs');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS servers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    invite_code TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS members (
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('text', 'voice')),
    position INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id, id)',
  // Conversas privadas (uma pessoa com outra, como no MSN)
  `CREATE TABLE IF NOT EXISTS dm_messages (
    id INTEGER PRIMARY KEY,
    from_id INTEGER NOT NULL REFERENCES users(id),
    to_id INTEGER NOT NULL REFERENCES users(id),
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS dm_pair ON dm_messages(from_id, to_id, id)',
  'CREATE INDEX IF NOT EXISTS dm_unread ON dm_messages(to_id, read_at)',
];

// Colunas adicionadas depois da primeira versão (rodam uma vez; "já existe" é ignorado)
const MIGRATIONS = [
  "ALTER TABLE users ADD COLUMN personal_message TEXT NOT NULL DEFAULT ''",
];
const alreadyApplied = (err) => /duplicate column/i.test(String(err?.message || err));

function openLocal(file) {
  const { DatabaseSync } = require('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  for (const sql of SCHEMA) db.exec(sql);
  for (const sql of MIGRATIONS) { try { db.exec(sql); } catch (err) { if (!alreadyApplied(err)) throw err; } }
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };
  return {
    kind: 'sqlite',
    ready: Promise.resolve(),
    get: async (sql, ...args) => stmt(sql).get(...args),
    all: async (sql, ...args) => stmt(sql).all(...args),
    run: async (sql, ...args) => {
      const r = stmt(sql).run(...args);
      return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    close: () => db.close(),
  };
}

function openRemote(url, authToken) {
  // "file:" usa o libsql nativo (testes); o resto vai por HTTP, sem nada nativo.
  const { createClient } = url.startsWith('file:') ? require('@libsql/client') : require('@libsql/client/web');
  const client = createClient({ url, authToken: authToken || undefined, intMode: 'number' });
  const toObjects = (rs) => rs.rows.map((row) => Object.fromEntries(rs.columns.map((c, i) => [c, row[i]])));
  const exec = (sql, args) => client.execute({ sql, args });
  const ready = client.batch(SCHEMA, 'write').then(async () => {
    for (const sql of MIGRATIONS) { try { await client.execute(sql); } catch (err) { if (!alreadyApplied(err)) throw err; } }
  });
  return {
    kind: 'libsql',
    ready,
    get: async (sql, ...args) => toObjects(await exec(sql, args))[0],
    all: async (sql, ...args) => toObjects(await exec(sql, args)),
    run: async (sql, ...args) => {
      const r = await exec(sql, args);
      return { lastInsertRowid: Number(r.lastInsertRowid ?? 0), changes: r.rowsAffected };
    },
    close: () => client.close(),
  };
}

function openDb({ file, url, authToken } = {}) {
  return url ? openRemote(url, authToken) : openLocal(file);
}

module.exports = { openDb };
