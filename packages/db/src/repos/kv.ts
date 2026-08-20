import type { KvRepo } from '@hype/core';
import { eq } from 'drizzle-orm';
import type { Db } from '../client.js';
import { appState } from '../schema.js';

export class SqliteKvRepo implements KvRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  async get(key: string): Promise<string | null> {
    const row = this.db.select().from(appState).where(eq(appState.key, key)).get();
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.db
      .insert(appState)
      .values({ key, value, updatedAt: this.now() })
      .onConflictDoUpdate({ target: appState.key, set: { value, updatedAt: this.now() } })
      .run();
  }
}
