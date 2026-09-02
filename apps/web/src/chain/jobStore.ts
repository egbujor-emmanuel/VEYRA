// Remembers which ERC-8183 jobs this browser has created, so a visitor can find them again and
// reclaim an undelivered one.
//
// Why local storage rather than reading the chain: the jobs are discoverable on-chain via the
// JobCreated event indexed by client, but every public BSC testnet RPC tested here refuses
// eth_getLogs over any historical range ("Request exceeds defined limit" / outright failure) --
// only the most recent few thousand blocks are served. A user coming back a day later would find
// nothing. The job id is not secret and the on-chain record is authoritative, so keeping a local
// index and reading each job's live state by id is both reliable and honest: nothing here is
// trusted, it only tells us WHICH ids to go and read.

const STORAGE_KEY = "veyra.jobs.v1";

export interface StoredJob {
  jobId: string;
  agentName: string;
  budgetWei: string;
  createdAt: number;
  /** Set once we know it; purely informational. */
  fundTxHash?: string;
}

export function loadJobs(): StoredJob[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function rememberJob(job: StoredJob): void {
  try {
    const existing = loadJobs().filter((j) => j.jobId !== job.jobId);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([job, ...existing].slice(0, 50)));
  } catch {
    // Private browsing or blocked storage. The job still exists on-chain; only the local
    // convenience index is lost, so this must never be fatal.
  }
}

export function forgetJobs(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}
