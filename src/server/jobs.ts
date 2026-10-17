import { EventEmitter } from "node:events";
import { RateMeter, describeRate, type RateUnit } from "../core/rate.ts";
import { PhaseTracker, type Phase, type PhaseState } from "../core/phases.ts";

/**
 * Long-running work (indexing a library, scanning a card) runs as a job so the
 * browser can watch it rather than hold a request open for four minutes.
 *
 * Only one job runs at a time, deliberately. Everything writes through a single
 * synchronous SQLite connection, so two jobs interleaving transactions would
 * corrupt each other's batches — and there is nothing to gain, since the work
 * is disk bound either way.
 */

export type JobKind = "index" | "scan" | "import";
export type JobStatus = "running" | "done" | "error" | "cancelled";

export interface JobProgress {
  message: string;
  done: number;
  total: number;
  /** Bytes of media covered so far, where the work knows its own size. */
  bytes: number;
  totalBytes: number;
  /** Quote the rate in bytes only where every counted byte is really read. */
  rateUnit: RateUnit;
  /** "82 MB/s · 1.2 GB of 6.4 GB · about 3 minutes left". Computed here. */
  detail: string;
  /**
   * Where the action as a whole has got to, for a job that declared its
   * phases. The bar is drawn from this, never from done/total, which count
   * one step at a time and start again at each one.
   */
  phases: PhaseState | null;
}

/** What a runner reports: progress within a step, and which phase it is in. */
export interface JobReport extends Partial<Omit<JobProgress, "phases" | "detail">> {
  phase?: string;
  /** A phase made of phases states its own fraction; see PhaseUpdate. */
  within?: number;
  /** False for a step whose counts say nothing about how far the phase has got. */
  counts?: boolean;
}

export interface Job {
  id: string;
  kind: JobKind;
  label: string;
  status: JobStatus;
  progress: JobProgress;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  result: unknown;
}

export interface JobEvent {
  type: "job";
  job: Job;
}

type Runner = (
  report: (progress: JobReport) => void,
  signal: AbortSignal,
) => Promise<unknown>;

export class JobManager extends EventEmitter {
  #jobs = new Map<string, Job>();
  #active: { job: Job; controller: AbortController } | null = null;
  #nextId = 1;

  get active(): Job | null {
    return this.#active?.job ?? null;
  }

  list(): Job[] {
    return [...this.#jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 20);
  }

  get(id: string): Job | undefined {
    return this.#jobs.get(id);
  }

  /**
   * Starts a job, or throws if one is already running. Callers surface the
   * message directly, so it explains what is in the way.
   */
  start(kind: JobKind, label: string, runner: Runner, phases?: Phase[]): Job {
    if (this.#active) {
      throw new Error(`Busy: "${this.#active.job.label}" is still running.`);
    }

    const job: Job = {
      id: String(this.#nextId++),
      kind,
      label,
      status: "running",
      progress: {
        message: "Starting",
        done: 0,
        total: 0,
        bytes: 0,
        totalBytes: 0,
        rateUnit: "files",
        detail: "",
        phases: null,
      },
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      result: null,
    };

    // Before the first publish, so the banner never sees a phased job without
    // its phases.
    const tracker = phases && phases.length > 0 ? new PhaseTracker(phases) : null;
    job.progress.phases = tracker?.state() ?? null;

    const controller = new AbortController();
    this.#jobs.set(job.id, job);
    this.#active = { job, controller };
    this.#publish(job);

    // Rates are measured here rather than by each caller, so anything that
    // reports progress gets a throughput and an estimate without asking.
    const meter = new RateMeter();

    const report = ({ phase, within, counts, ...progress }: JobReport) => {
      const next: JobProgress = { ...job.progress, ...progress };
      // A different total means different work, and a rate carried across the
      // boundary would describe the previous phase.
      if (next.total !== job.progress.total || next.totalBytes !== job.progress.totalBytes) {
        meter.reset();
      }
      meter.record(next.done, next.bytes, Date.now());
      next.detail = describeRate(
        meter.rate(next.total, next.totalBytes),
        next.bytes,
        next.totalBytes,
        next.rateUnit,
      );
      if (tracker) {
        next.phases =
          phase === undefined
            ? tracker.state()
            : tracker.update({
                phase,
                ...(within !== undefined ? { within } : {}),
                ...(counts === false ? {} : { done: next.done, total: next.total }),
              });
      }
      job.progress = next;
      this.#publish(job);
    };

    void runner(report, controller.signal)
      .then((result) => {
        job.status = controller.signal.aborted ? "cancelled" : "done";
        job.result = result;
        if (tracker && job.status === "done") job.progress.phases = tracker.finish();
      })
      .catch((err: unknown) => {
        const aborted =
          controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
        job.status = aborted ? "cancelled" : "error";
        job.error = aborted ? null : err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        job.finishedAt = Date.now();
        this.#active = null;
        this.#publish(job);
      });

    return job;
  }

  cancel(id: string): boolean {
    if (this.#active?.job.id !== id) return false;
    this.#active.controller.abort();
    return true;
  }

  #publish(job: Job): void {
    // Emit a copy: the job object keeps mutating, and an SSE frame should
    // capture the state at the moment it was sent.
    const progress = { ...job.progress };
    if (progress.phases) progress.phases = { ...progress.phases, skipped: [...progress.phases.skipped] };
    this.emit("job", { type: "job", job: { ...job, progress } });
  }
}
