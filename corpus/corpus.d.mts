export interface CorpusEntry {
  id: string;
  name: string;
  file: string;
  url: string;
  sha256: string;
  about: string;
}
export const FILES: string;
export const CORPUS: CorpusEntry[];
export function corpusFile(entry: CorpusEntry): string;
/** The entries whose file is not there yet. */
export function missing(): CorpusEntry[];
export function fetchCorpus(log?: (message: string) => void): Promise<void>;
