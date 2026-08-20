import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { schema } from './schema.js';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface DbHandle {
  db: Db;
  raw: Database.Database;
  close(): void;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Veritabanını açar, pragmaları kurar ve migration'ları uygular.
 *
 * `better-sqlite3` senkron olduğu için yazıcı sayısı YAPISAL olarak birdir —
 * eşzamanlı yazma çakışması diye bir sınıf hata bu mimaride mümkün değil.
 * WAL, tarama yazarken arayüzün okumasını engellemez.
 */
export function openDatabase(path: string): DbHandle {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const raw = new Database(path);
  raw.pragma('journal_mode = WAL');
  raw.pragma('synchronous = NORMAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');

  const db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });

  return {
    db,
    raw,
    close() {
      // Uzun taramalardan sonra WAL dosyası büyür; kapanışta ana dosyaya katlanır.
      try {
        raw.pragma('wal_checkpoint(TRUNCATE)');
      } finally {
        raw.close();
      }
    },
  };
}
