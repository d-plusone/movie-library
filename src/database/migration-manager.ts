import { constants, promises as fs } from "fs";
import path from "path";

/**
 * 旧バージョンが db push で作成した、migration 履歴を持たない DB の
 * 既知の最終 schema に対応する migration 群。
 *
 * この一覧にない migration は、legacy DB に対して自動で applied 扱いに
 * してはいけない。新しい migration を追加した場合は、legacy schema の
 * 形状とこの一覧を必ず見直す。
 */
export const LEGACY_BASELINE_MIGRATIONS = [
  "20250725085239_initial_with_bigint_size",
  "20260118153243_add_duplicate_detection_fields",
  "20260613000000_add_performance_indexes",
  "20260811165559_add_watch_progress_fields",
] as const;

export interface MigrationSqlClient {
  query<T>(sql: string): Promise<T[]>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface MigrationRunner {
  deploy(): Promise<void>;
  resolveApplied(migrationName: string): Promise<void>;
}

export interface MigrationCoordinatorOptions {
  databasePath: string;
  migrationNames: string[];
  legacyBaselineMigrations?: readonly string[];
  sql: MigrationSqlClient;
  runner: MigrationRunner;
}

export interface MigrationOutcome {
  kind: "new" | "managed" | "legacy-baseline";
  backupPath?: string;
}

interface MigrationHistoryRow {
  migration_name: string;
  finished_at: string | number | null;
  rolled_back_at: string | number | null;
}

interface SqliteMasterRow {
  name: string;
  type: string;
  tbl_name: string;
  sql: string | null;
}

interface SqliteColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface SqliteForeignKeyRow {
  table: string;
  from: string;
  to: string;
  on_delete: string;
  on_update: string;
}

interface SqliteDateRow {
  id: number;
  created_at: unknown;
  modified_at: unknown;
}

interface IntegrityRow {
  integrity_check: string;
}

interface WalCheckpointRow {
  busy: number | bigint;
}

interface LegacyInspection {
  status: "match" | "unknown" | "invalid-datetime";
  reason?: string;
}

interface DatabaseState {
  tables: Set<string>;
  hasMigrationTable: boolean;
  history: MigrationHistoryRow[];
  userTableCount: number;
}

interface ColumnExpectation {
  name: string;
  type: string;
  notnull: number;
  defaultValue: string | null;
  pk: number;
}

const LEGACY_TABLES = new Set([
  "videos",
  "directories",
  "tags",
  "video_tags",
]);

const LEGACY_INDEXES = new Set([
  "videos_path_key",
  "videos_updated_at_idx",
  "videos_added_at_idx",
  "videos_thumbnail_path_idx",
  "video_tags_tag_id_idx",
  "directories_path_key",
  "tags_name_key",
]);

const LEGACY_COLUMNS: Record<string, readonly ColumnExpectation[]> = {
  videos: [
    { name: "id", type: "INTEGER", notnull: 1, defaultValue: null, pk: 1 },
    { name: "path", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "filename", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "title", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "duration", type: "INTEGER", notnull: 1, defaultValue: "0", pk: 0 },
    { name: "size", type: "BIGINT", notnull: 1, defaultValue: "0", pk: 0 },
    { name: "width", type: "INTEGER", notnull: 1, defaultValue: "0", pk: 0 },
    { name: "height", type: "INTEGER", notnull: 1, defaultValue: "0", pk: 0 },
    { name: "fps", type: "INTEGER", notnull: 1, defaultValue: "0", pk: 0 },
    { name: "codec", type: "TEXT", notnull: 1, defaultValue: "", pk: 0 },
    { name: "bitrate", type: "INTEGER", notnull: 1, defaultValue: "0", pk: 0 },
    { name: "rating", type: "INTEGER", notnull: 1, defaultValue: "0", pk: 0 },
    { name: "thumbnail_path", type: "TEXT", notnull: 0, defaultValue: null, pk: 0 },
    { name: "chapter_thumbnails", type: "TEXT", notnull: 1, defaultValue: "[]", pk: 0 },
    { name: "description", type: "TEXT", notnull: 0, defaultValue: null, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "modified_at", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "added_at", type: "DATETIME", notnull: 1, defaultValue: "CURRENT_TIMESTAMP", pk: 0 },
    { name: "updated_at", type: "DATETIME", notnull: 1, defaultValue: null, pk: 0 },
    { name: "file_hash", type: "TEXT", notnull: 0, defaultValue: null, pk: 0 },
    { name: "partial_hash", type: "TEXT", notnull: 0, defaultValue: null, pk: 0 },
    { name: "watched_at", type: "DATETIME", notnull: 0, defaultValue: null, pk: 0 },
    { name: "watch_position", type: "INTEGER", notnull: 1, defaultValue: "0", pk: 0 },
  ],
  directories: [
    { name: "id", type: "INTEGER", notnull: 1, defaultValue: null, pk: 1 },
    { name: "path", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "name", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "added_at", type: "DATETIME", notnull: 1, defaultValue: "CURRENT_TIMESTAMP", pk: 0 },
  ],
  tags: [
    { name: "id", type: "INTEGER", notnull: 1, defaultValue: null, pk: 1 },
    { name: "name", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "color", type: "TEXT", notnull: 1, defaultValue: "#007AFF", pk: 0 },
    { name: "created_at", type: "DATETIME", notnull: 1, defaultValue: "CURRENT_TIMESTAMP", pk: 0 },
  ],
  video_tags: [
    { name: "video_id", type: "INTEGER", notnull: 1, defaultValue: null, pk: 1 },
    { name: "tag_id", type: "INTEGER", notnull: 1, defaultValue: null, pk: 2 },
  ],
};

function normalizeSqlValue(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1).replace(/''/g, "'").toUpperCase();
  }
  return trimmed.replace(/\s+/g, " ").toUpperCase();
}

function normalizeType(value: string): string {
  return value.trim().toUpperCase();
}

function sameStringSet(actual: Iterable<string>, expected: Set<string>): boolean {
  const actualSet = new Set(actual);
  if (actualSet.size !== expected.size) return false;
  for (const value of expected) {
    if (!actualSet.has(value)) return false;
  }
  return true;
}

function isValidIsoDateTime(value: unknown): boolean {
  if (value instanceof Date) return Number.isFinite(value.getTime());
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    return false;
  }
  return Number.isFinite(new Date(value).getTime());
}

function validateDateRows(rows: SqliteDateRow[]): string | null {
  for (const row of rows) {
    if (!isValidIsoDateTime(row.created_at)) {
      return `videos.id=${row.id} の created_at は変換可能な ISO 8601 日時ではありません`;
    }
    if (!isValidIsoDateTime(row.modified_at)) {
      return `videos.id=${row.id} の modified_at は変換可能な ISO 8601 日時ではありません`;
    }
  }
  return null;
}

async function inspectLegacySchema(
  sql: MigrationSqlClient,
): Promise<LegacyInspection> {
  const masterRows = await sql.query<SqliteMasterRow>(
    "SELECT name, type, tbl_name, sql FROM sqlite_master WHERE type IN ('table', 'index', 'trigger', 'view')",
  );
  const tableNames = masterRows
    .filter((row) => row.type === "table" && !row.name.startsWith("sqlite_"))
    .map((row) => row.name);
  const userTableNames = tableNames.filter((name) => name !== "_prisma_migrations");
  if (!sameStringSet(userTableNames, LEGACY_TABLES)) {
    return {
      status: "unknown",
      reason: `テーブル構成が既知のlegacy schemaと一致しません: ${userTableNames.join(", ")}`,
    };
  }

  const unexpectedObjects = masterRows.filter(
    (row) =>
      (row.type === "trigger" || row.type === "view") &&
      row.name !== "_prisma_migrations",
  );
  if (unexpectedObjects.length > 0) {
    return {
      status: "unknown",
      reason: `未知のtrigger/viewがあります: ${unexpectedObjects.map((row) => row.name).join(", ")}`,
    };
  }

  for (const [tableName, expectedColumns] of Object.entries(LEGACY_COLUMNS)) {
    const actualColumns = await sql.query<SqliteColumnRow>(
      `PRAGMA table_info("${tableName}")`,
    );
    if (actualColumns.length !== expectedColumns.length) {
      return {
        status: "unknown",
        reason: `${tableName} の列数が一致しません`,
      };
    }
    for (let index = 0; index < expectedColumns.length; index++) {
      const actual = actualColumns[index];
      const expected = expectedColumns[index];
      if (
        actual?.name !== expected.name ||
        normalizeType(actual.type) !== expected.type ||
        Number(actual.notnull) !== expected.notnull ||
        normalizeSqlValue(actual.dflt_value) !==
          (expected.defaultValue === null
            ? null
            : expected.defaultValue.toUpperCase()) ||
        Number(actual.pk) !== expected.pk
      ) {
        return {
          status: "unknown",
          reason: `${tableName}.${expected.name} の定義が既知のlegacy schemaと一致しません`,
        };
      }
    }
  }

  const indexes = masterRows
    .filter((row) => row.type === "index" && row.sql !== null)
    .map((row) => row.name);
  if (!sameStringSet(indexes, LEGACY_INDEXES)) {
    return {
      status: "unknown",
      reason: `index構成が既知のlegacy schemaと一致しません: ${indexes.join(", ")}`,
    };
  }

  const foreignKeys = await sql.query<SqliteForeignKeyRow>(
    "PRAGMA foreign_key_list(\"video_tags\")",
  );
  const actualForeignKeys = foreignKeys
    .map(
      (row) =>
        `${row.table}|${row.from}|${row.to}|${row.on_delete}|${row.on_update}`,
    )
    .sort();
  const expectedForeignKeys = [
    "tags|tag_id|id|CASCADE|CASCADE",
    "videos|video_id|id|CASCADE|CASCADE",
  ].sort();
  if (JSON.stringify(actualForeignKeys) !== JSON.stringify(expectedForeignKeys)) {
    return {
      status: "unknown",
      reason: "video_tags の外部キー構成が既知のlegacy schemaと一致しません",
    };
  }

  const dateRows = await sql.query<SqliteDateRow>(
    'SELECT id, created_at, modified_at FROM "videos"',
  );
  const dateError = validateDateRows(dateRows);
  if (dateError !== null) {
    return { status: "invalid-datetime", reason: dateError };
  }
  return { status: "match" };
}

async function inspectDatabase(
  sql: MigrationSqlClient,
): Promise<DatabaseState> {
  const tableRows = await sql.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND NOT name LIKE 'sqlite_%'",
  );
  const tables = new Set(tableRows.map((row) => row.name));
  const hasMigrationTable = tables.has("_prisma_migrations");
  const history = hasMigrationTable
    ? await sql.query<MigrationHistoryRow>(
        'SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at',
      )
    : [];
  const userTableCount = [...tables].filter(
    (tableName) => tableName !== "_prisma_migrations",
  ).length;
  return { tables, hasMigrationTable, history, userTableCount };
}

async function verifyDatabase(
  sql: MigrationSqlClient,
): Promise<void> {
  await sql.query("PRAGMA foreign_keys = ON");
  const integrityRows = await sql.query<IntegrityRow>("PRAGMA integrity_check");
  if (
    integrityRows.length !== 1 ||
    integrityRows[0]?.integrity_check.toLowerCase() !== "ok"
  ) {
    throw new Error("SQLite integrity_check に失敗しました。DBを変更せず起動を中断します。");
  }

  const foreignKeyErrors = await sql.query<Record<string, unknown>>(
    "PRAGMA foreign_key_check",
  );
  if (foreignKeyErrors.length > 0) {
    throw new Error(
      `SQLite foreign_key_check に失敗しました（${foreignKeyErrors.length}件）。DBを変更せず起動を中断します。`,
    );
  }

  const dateRows = await sql.query<SqliteDateRow>(
    'SELECT id, created_at, modified_at FROM "videos"',
  );
  const dateError = validateDateRows(dateRows);
  if (dateError !== null) throw new Error(dateError);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function createEmptyDatabaseFile(databasePath: string): Promise<void> {
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  // Prisma migrate deploy は SQLite の完全に存在しないファイルを自動作成
  // できない環境があるため、空ファイルだけを先に用意する。既存DBには
  // この関数を実行しないので、既存データを上書きする経路にはならない。
  await fs.writeFile(databasePath, "", { flag: "a" });
}

async function createBackup(databasePath: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[.:]/g, "-");
  let backupPath = `${databasePath}.backup-${stamp}`;
  let suffix = 1;
  while (await fileExists(backupPath)) {
    backupPath = `${databasePath}.backup-${stamp}-${suffix}`;
    suffix++;
  }
  await fs.copyFile(databasePath, backupPath, constants.COPYFILE_EXCL);
  return backupPath;
}

async function disconnectAndBackup(
  options: MigrationCoordinatorOptions,
): Promise<string> {
  // WAL の内容を本体へ反映してから切断・コピーする。checkpointに失敗した
  // 場合は、整合性の不明なバックアップを作らず、その場で中断する。
  const checkpointRows = await options.sql.query<WalCheckpointRow>(
    "PRAGMA wal_checkpoint(TRUNCATE)",
  );
  if (checkpointRows.length !== 1 || Number(checkpointRows[0]?.busy) !== 0) {
    throw new Error(
      "SQLite WAL checkpointに失敗しました。バックアップとmigrationを行わず起動を中断します。",
    );
  }
  await options.sql.disconnect();
  return createBackup(options.databasePath);
}

async function disconnect(options: MigrationCoordinatorOptions): Promise<void> {
  await options.sql.disconnect();
}

async function reconnectAndVerify(
  options: MigrationCoordinatorOptions,
): Promise<void> {
  await options.sql.connect();
  await verifyDatabase(options.sql);
}

async function runMigrationWithBackup(
  options: MigrationCoordinatorOptions,
  backupPath: string,
  prepare?: () => Promise<void>,
): Promise<void> {
  try {
    await prepare?.();
    await options.runner.deploy();
    await reconnectAndVerify(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `migrationに失敗したため起動を中断します。バックアップを保持しています: ${backupPath}. ${message}`,
    );
  }
}

/** DATABASE_URL=file:... を実ファイルパスへ変換する。 */
export function databasePathFromUrl(databaseUrl: string): string {
  if (!databaseUrl.startsWith("file:")) {
    throw new Error("DATABASE_URL は SQLite の file: URL である必要があります");
  }
  const rawPath = databaseUrl.slice("file:".length).split("?", 1)[0] ?? "";
  const decodedPath = decodeURIComponent(rawPath);
  if (decodedPath === ":memory:") return decodedPath;
  return path.resolve(decodedPath);
}

/**
 * 起動時DB migrationの安全なオーケストレーション。
 * 失敗時に破壊的なスキーマ同期へフォールバックしない。
 */
export async function ensureDatabaseMigrated(
  options: MigrationCoordinatorOptions,
): Promise<MigrationOutcome> {
  const migrationNames = [...options.migrationNames].sort();
  const baselineNames = [
    ...(options.legacyBaselineMigrations ?? LEGACY_BASELINE_MIGRATIONS),
  ];
  const databaseExists =
    options.databasePath !== ":memory:" &&
    (await fileExists(options.databasePath));

  if (!databaseExists) {
    await createEmptyDatabaseFile(options.databasePath);
    await options.runner.deploy();
    await reconnectAndVerify(options);
    return { kind: "new" };
  }

  await options.sql.connect();
  const state = await inspectDatabase(options.sql);
  const knownMigrations = new Set(migrationNames);
  const baselineSet = new Set(baselineNames);

  for (const row of state.history) {
    if (row.finished_at === null || row.rolled_back_at !== null) {
      throw new Error(
        `未完了またはrollback済みのPrisma migrationがあります: ${row.migration_name}`,
      );
    }
    if (!knownMigrations.has(row.migration_name)) {
      throw new Error(
        `DBに記録されたmigrationがアプリに存在しません: ${row.migration_name}`,
      );
    }
  }

  const appliedNames = new Set(state.history.map((row) => row.migration_name));
  const canBeLegacyBaseline = [...appliedNames].every((name) =>
    baselineSet.has(name),
  );

  if (state.userTableCount === 0) {
    await disconnect(options);
    await options.runner.deploy();
    await reconnectAndVerify(options);
    return { kind: "new" };
  }

  if (!state.hasMigrationTable || (state.history.length === 0 && state.userTableCount > 0)) {
    const legacy = await inspectLegacySchema(options.sql);
    if (legacy.status === "invalid-datetime") {
      throw new Error(`legacy DBの日時値を変換できません: ${legacy.reason}`);
    }
    if (legacy.status !== "match") {
      throw new Error(
        `migration履歴のないDB schemaを安全に判定できません: ${legacy.reason ?? "unknown schema"}`,
      );
    }

    await verifyDatabase(options.sql);
    const backupPath = await disconnectAndBackup(options);
    await runMigrationWithBackup(options, backupPath, async () => {
      for (const migrationName of baselineNames) {
        if (!knownMigrations.has(migrationName)) {
          throw new Error(`legacy baseline migrationが存在しません: ${migrationName}`);
        }
        if (!appliedNames.has(migrationName)) {
          await options.runner.resolveApplied(migrationName);
        }
      }
    });
    return { kind: "legacy-baseline", backupPath };
  }

  if (canBeLegacyBaseline && appliedNames.size < baselineSet.size) {
    const legacy = await inspectLegacySchema(options.sql);
    if (legacy.status === "invalid-datetime") {
      throw new Error(`legacy DBの日時値を変換できません: ${legacy.reason}`);
    }
    if (legacy.status === "match") {
      await verifyDatabase(options.sql);
      const backupPath = await disconnectAndBackup(options);
      await runMigrationWithBackup(options, backupPath, async () => {
        for (const migrationName of baselineNames) {
          if (!knownMigrations.has(migrationName)) {
            throw new Error(`legacy baseline migrationが存在しません: ${migrationName}`);
          }
          if (!appliedNames.has(migrationName)) {
            await options.runner.resolveApplied(migrationName);
          }
        }
      });
      return { kind: "legacy-baseline", backupPath };
    }
  }

  const pending = migrationNames.some((name) => !appliedNames.has(name));
  if (pending) await verifyDatabase(options.sql);
  const backupPath = pending
    ? await disconnectAndBackup(options)
    : (await disconnect(options), undefined);
  if (backupPath === undefined) {
    await options.runner.deploy();
    await reconnectAndVerify(options);
  } else {
    await runMigrationWithBackup(options, backupPath);
  }
  return backupPath === undefined
    ? { kind: "managed" }
    : { kind: "managed", backupPath };
}
