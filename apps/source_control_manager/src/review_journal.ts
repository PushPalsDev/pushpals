/** Durable review evidence; side effects may be retried without re-rolling a verdict. */
export interface ReviewJournalEntry {
  verdictJson: string | null;
  finalized: boolean;
  repairEnqueues: number;
}

export interface ReviewJournal {
  getReviewDecision(
    repository: string,
    prNumber: number,
    revision: string,
  ): ReviewJournalEntry | null;
  saveReviewDecision(
    repository: string,
    prNumber: number,
    revision: string,
    entry: ReviewJournalEntry,
  ): void;
  getReviewRepairEnqueueCount(repository: string, prNumber: number): number;
}
