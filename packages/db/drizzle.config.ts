import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: { url: '../../data/hype.db' },
  casing: 'snake_case',
});
