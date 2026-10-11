export interface FixtureRequest {
  path: string;
  version: string;
  destination: string;
  cacheControl: string;
}
export interface FixtureBarrier {
  entered: Promise<FixtureRequest>;
  release(): void;
}
export interface FixtureHost {
  origin: string;
  workerHash: string;
  requests: FixtureRequest[];
  deploy(version: 'A' | 'B' | 'C', modules?: 'A' | 'B' | 'C'): void;
  fail(path: string, status?: number): void;
  clearFailures(): void;
  barrier(match: (entry: FixtureRequest) => boolean): FixtureBarrier;
  close(): Promise<void>;
}
export function createFixtureHost(): Promise<FixtureHost>;
