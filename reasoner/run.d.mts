export const LIBRARY: { file: string; url: string; sha256: string };
export const DEFAULT_PORT: number;
/** What stands in the way of running the service on this machine, in words; nothing when it can run. */
export function javaProblem(): string | undefined;
/** Why the service cannot be started here without fetching anything; nothing when it can. */
export function unavailable(): string | undefined;
export function prepare(log?: (message: string) => void): Promise<void>;
export function startReasoner(options?: { port?: number; host?: string; allowOrigins?: string[]; allowLocalAi?: boolean; javaOptions?: string[]; log?: (message: string) => void; quiet?: boolean }): Promise<{ url: string; health: { engine: string; engineVersion: string; owlapi: string }; stop: () => Promise<unknown> }>;
