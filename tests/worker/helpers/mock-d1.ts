import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../migrations/0001_init.sql",
);

class SqlitePreparedStatement {
  private readonly db: DatabaseSync;
  private readonly sql: string;
  private readonly params: unknown[];

  constructor(db: DatabaseSync, sql: string, params: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqlitePreparedStatement(
      this.db,
      this.sql,
      values,
    ) as unknown as D1PreparedStatement;
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...(this.params as [])) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    if (colName) {
      return (row[colName] as T) ?? null;
    }
    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const stmt = this.db.prepare(this.sql);
    const results = stmt.all(...(this.params as [])) as T[];
    return {
      results,
      success: true,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: results.length,
        rows_written: 0,
        last_row_id: 0,
        changed_db: false,
        changes: 0,
      },
    };
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...(this.params as []));
    return {
      results: [],
      success: true,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: 0,
        rows_written: Number(info.changes),
        last_row_id: Number(info.lastInsertRowid),
        changed_db: Number(info.changes) > 0,
        changes: Number(info.changes),
      },
    };
  }

  executeInBatch(): D1Result<unknown> {
    const trimmed = this.sql.trim().toUpperCase();
    const stmt = this.db.prepare(this.sql);
    if (trimmed.startsWith("SELECT")) {
      const results = stmt.all(...(this.params as []));
      return {
        results,
        success: true,
        meta: {
          duration: 0,
          size_after: 0,
          rows_read: results.length,
          rows_written: 0,
          last_row_id: 0,
          changed_db: false,
          changes: 0,
        },
      };
    }
    const info = stmt.run(...(this.params as []));
    return {
      results: [],
      success: true,
      meta: {
        duration: 0,
        size_after: 0,
        rows_read: 0,
        rows_written: Number(info.changes),
        last_row_id: Number(info.lastInsertRowid),
        changed_db: Number(info.changes) > 0,
        changes: Number(info.changes),
      },
    };
  }
}

export function createTestD1(): { db: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const migrationSql = readFileSync(MIGRATION_PATH, "utf8");
  sqlite.exec(migrationSql);

  const db = {
    prepare(query: string): D1PreparedStatement {
      return new SqlitePreparedStatement(
        sqlite,
        query,
      ) as unknown as D1PreparedStatement;
    },
    async batch<T = unknown>(
      statements: D1PreparedStatement[],
    ): Promise<D1Result<T>[]> {
      sqlite.exec("BEGIN");
      try {
        const results: D1Result<T>[] = [];
        for (const s of statements) {
          const impl = s as unknown as SqlitePreparedStatement;
          results.push(impl.executeInBatch() as D1Result<T>);
        }
        sqlite.exec("COMMIT");
        return results;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    },
    async exec(query: string): Promise<D1ExecResult> {
      sqlite.exec(query);
      return { count: 1, duration: 0 };
    },
  } as unknown as D1Database;

  return { db, sqlite };
}

export function createMockExecutionContext(): {
  ctx: ExecutionContext;
  flush: () => Promise<void>;
} {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {
      // no-op in tests
    },
  } as unknown as ExecutionContext;

  return {
    ctx,
    async flush() {
      await Promise.allSettled(pending.splice(0));
    },
  };
}
