declare module 'better-sqlite3' {
  interface Database {
    exec(sql: string): void;
    prepare(sql: string): Statement;
    pragma(pragma: string): void;
    backup(filename: string): void;
    close(): void;
  }

  interface Statement {
    run(...params: any[]): { changes: number };
    get(...params: any[]): any;
    all(...params: any[]): any[];
  }

  interface DatabaseConstructor {
    new (filename: string, options?: { verbose?: Function }): Database;
  }

  const Database: DatabaseConstructor;
  export default Database;
}
