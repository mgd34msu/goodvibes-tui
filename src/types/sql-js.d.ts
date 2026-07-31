// Ambient declaration for the optional `sql.js` dependency.
//
// It stays here rather than coming from the SDK: an ambient `declare module`
// is a property of the PROGRAM being compiled, and the SDK's build emits no
// ambient declarations for a consumer to pick up. Whoever imports `sql.js`
// declares it.

declare module 'sql.js' {
  interface Database {
    run(sql: string, params?: (string | number | Uint8Array | null)[]): void;
    exec(sql: string, params?: (string | number)[]): Array<{ columns: string[]; values: unknown[][] }>;
    export(): Uint8Array;
    close(): void;
  }

  interface SqlJsStatic {
    Database: new (data?: Uint8Array | Buffer) => Database;
  }

  function initSqlJs(): Promise<SqlJsStatic>;
  export default initSqlJs;
}
