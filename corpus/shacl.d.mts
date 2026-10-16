export const SHACL_FILES: string;
export const SHACL_SUITE: { commit: string; root: string; sha256: string };
/** Where a file of the suite is published, at the commit. */
export function shaclUrl(file: string): string;
/** The address the suite's files resolve their relative IRIs against. */
export function shaclBase(file: string): string;
/** The files of the suite (paths below its root), once fetched; none before. */
export function shaclFiles(): string[];
/** The test files: those that are not manifests. */
export function shaclTests(): string[];
export function shaclFile(file: string): string;
export function digest(files: Iterable<string>, read: (file: string) => string): string;
export function fetchShaclSuite(log?: (message: string) => void): Promise<void>;
