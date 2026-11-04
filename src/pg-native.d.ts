declare module "pg-native" {
  type Row = Record<string, unknown>;
  export default class Client {
    constructor(config?: { types?: { getTypeParser(oid: number, format?: string): (v: string) => unknown } });
    pq: { cmdTuples(): string };
    connectSync(url?: string): void;
    querySync(text: string, values?: unknown[]): Row[];
    end(cb?: () => void): void;
  }
}
