/**
 * One bar for one action.
 *
 * A scan reads the card, reads its capture times, compares, and verifies —
 * and each of those counts its own work from zero. Shown as they come, that
 * is a bar that fills, empties and fills again four times, and nobody can
 * tell from it how far through the *action* they are. So the action declares
 * its phases up front, the bar is divided into one segment per phase, and
 * progress inside a step fills only its own segment.
 *
 * Two rules keep it honest:
 *
 * - **It never goes backwards.** A report from a phase already left behind
 *   (the matcher runs its capture pass a second time, late) updates the
 *   message but not the bar.
 * - **A phase passed over is skipped, not done.** Most scans never need to
 *   hash anything; that segment is marked as not needed rather than filled,
 *   since filling it would claim work that never happened.
 */

export interface Phase {
  key: string;
  label: string;
}

export interface PhaseState {
  phases: Phase[];
  /** Index of the phase under way. */
  current: number;
  /** How far through the current phase, 0-1. Null while it cannot be known. */
  fraction: number | null;
  /** Phases passed over without running. */
  skipped: string[];
  /** The whole action, 0-1, for anything that wants a single number. */
  overall: number;
}

export interface PhaseUpdate {
  phase: string;
  done?: number;
  total?: number;
  /**
   * A fraction for the phase stated directly, for a phase that is itself
   * made of phases — an import's re-check is a whole scan.
   */
  within?: number;
}

export class PhaseTracker {
  readonly #phases: Phase[];
  #current = 0;
  #fraction: number | null = null;
  #skipped = new Set<string>();
  #finished = false;

  constructor(phases: Phase[]) {
    if (phases.length === 0) throw new Error("A phased action needs at least one phase.");
    this.#phases = phases;
  }

  update(update: PhaseUpdate): PhaseState {
    const index = this.#phases.findIndex((p) => p.key === update.phase);
    // An unknown phase or one already finished: the message moves on, the bar
    // does not.
    if (index === -1 || index < this.#current) return this.state();

    if (index > this.#current) {
      // The phase being left was started; the ones jumped over never were.
      for (let i = this.#current + 1; i < index; i++) this.#skipped.add(this.#phases[i]!.key);
      this.#current = index;
      this.#fraction = null;
    }

    const next =
      update.within !== undefined
        ? update.within
        : update.total !== undefined && update.total > 0 && update.done !== undefined
          ? update.done / update.total
          : null;

    if (next !== null) {
      const clamped = Math.min(1, Math.max(0, next));
      // Within a phase, a step that counts afresh must not pull the bar back.
      this.#fraction = this.#fraction === null ? clamped : Math.max(this.#fraction, clamped);
    }
    return this.state();
  }

  /**
   * The action is over. Whatever phases were still ahead were never needed,
   * and say so — finishing early is not the same as doing them.
   */
  finish(): PhaseState {
    for (let i = this.#current + 1; i < this.#phases.length; i++) this.#skipped.add(this.#phases[i]!.key);
    this.#fraction = 1;
    this.#finished = true;
    return this.state();
  }

  state(): PhaseState {
    return {
      phases: this.#phases,
      current: this.#current,
      fraction: this.#fraction,
      skipped: [...this.#skipped],
      overall: this.#finished ? 1 : (this.#current + (this.#fraction ?? 0)) / this.#phases.length,
    };
  }
}
