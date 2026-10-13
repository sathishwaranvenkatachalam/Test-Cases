import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], environment: 'node', fileParallelism: false, env: { DB_PATH: ':memory:', CLAUDE_STUB: '1' } } });
