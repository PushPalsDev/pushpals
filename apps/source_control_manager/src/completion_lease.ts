import { parseCompletionPositiveAck } from "./completion_callback";

export type CompletionLeaseRenewalResult = {
  ok: boolean;
  detail?: string;
  leaseLost?: boolean;
};

export type CompletionLeaseRenewalAttempt = () => Promise<CompletionLeaseRenewalResult>;

export async function parseCompletionLeaseRenewalResponse(
  response: Response,
): Promise<CompletionLeaseRenewalResult> {
  const acknowledgement = await parseCompletionPositiveAck(response);
  if (acknowledgement.ok) return { ok: true };

  const malformedPositiveResponse = response.ok;
  return {
    ok: false,
    leaseLost: response.status === 409,
    detail: malformedPositiveResponse
      ? `Completion publication lease renewal returned HTTP ${response.status} without an explicit positive acknowledgement.`
      : `Completion publication lease could not be renewed (HTTP ${response.status}).`,
  };
}

/**
 * Shares one in-flight lease renewal between the periodic heartbeat and the
 * publication barrier. A required caller observes the actual shared result;
 * it must never infer success merely because a background renewal settled.
 */
export class CompletionLeaseRenewalCoordinator {
  private inFlight: Promise<CompletionLeaseRenewalResult> | null = null;
  private lastFailureDetail: string | null = null;
  private leaseLost = false;

  constructor(private readonly attempt: CompletionLeaseRenewalAttempt) {}

  async renew(required = false): Promise<boolean> {
    if (this.leaseLost) {
      const detail = this.lastFailureDetail ?? "Completion publication lease was permanently lost.";
      if (required) throw new Error(detail);
      return false;
    }
    try {
      const result = await this.sharedAttempt();
      if (result.ok) {
        this.lastFailureDetail = null;
        return true;
      }

      this.lastFailureDetail =
        String(result.detail ?? "").trim() || "Completion publication lease was not renewed.";
      if (result.leaseLost) this.leaseLost = true;
      if (required) throw new Error(this.lastFailureDetail);
      return false;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.lastFailureDetail = detail || "Completion publication lease renewal failed.";
      if (required) throw error;
      return false;
    }
  }

  failureDetail(): string | null {
    return this.lastFailureDetail;
  }

  hasLostLease(): boolean {
    return this.leaseLost;
  }

  private sharedAttempt(): Promise<CompletionLeaseRenewalResult> {
    if (this.inFlight) return this.inFlight;

    const attempt = Promise.resolve().then(() => this.attempt());
    this.inFlight = attempt;
    void attempt.then(
      () => {
        if (this.inFlight === attempt) this.inFlight = null;
      },
      () => {
        if (this.inFlight === attempt) this.inFlight = null;
      },
    );
    return attempt;
  }
}
