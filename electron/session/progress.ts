// Progress of one whole start or stop, as the bar under the power button shows it.
// Every action is one unit: stopping Java is 1, creating 800 folders is 800, uploading 2,000 files is 2,000.
// The bar is units done / units planned. Stages whose size is only known later (how many folders?) start
// with an estimate; the bar never moves backwards when an estimate turns out too small.
import type {
    ProgressStage, ProgressStageKey, RunKind, SessionProgress, StepMessage, TransferSnapshot,
} from '../../shared/types';
import type { ProgressSink } from '../sync/progressSink';

export interface StagePlan {
    key: ProgressStageKey;
    label: string;
    total: number;
}

export interface RunInfo {
    /** A hint shown while the run is active, e.g. that a first upload takes long. */
    note?: string | null;
    kind?: RunKind | null;
    serverId?: string | null;
}

/** Lines of the progress log. A task keeps its id, so its "loading" line turns into "done" in place. */
export interface TaskLog {
    open(message: string, importance: StepMessage['importance']): number;
    update(id: number, message: string, status: StepMessage['status']): void;
}

interface Stage extends ProgressStage {
    settled: number;
    live: number;
    message: string;
    taskId: number | null;
}

const TRANSFER_STAGES = new Set<ProgressStageKey>(['download', 'folders', 'files']);
const EMIT_EVERY_MS = 150;

const IDLE: SessionProgress = {
    active: false, title: '', message: '', unitsDone: 0, unitsTotal: 0, fraction: 0, stages: [],
    outcome: 'done', startedAt: null, endedAt: null, note: null, kind: null, serverId: null,
};

export class OrchestrationProgress implements ProgressSink {
    private title = '';
    private stages: Stage[] = [];
    private current: Stage | null = null;
    private fraction = 0;
    private active = false;
    private outcome: SessionProgress['outcome'] = 'done';
    private startedAt: string | null = null;
    private endedAt: string | null = null;
    private failureMessage: string | null = null;
    private note: string | null = null;
    private kind: RunKind | null = null;
    private serverId: string | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private lastEmit = 0;
    private readonly now: () => number;

    constructor(private readonly d: {
        emit: (progress: SessionProgress) => void;
        log: TaskLog;
        now?: () => number;
        emitEveryMs?: number;
    }) {
        this.now = d.now ?? Date.now;
    }

    /** Starts a new run. Stages with total 0 are kept (their size may become known) but weigh nothing yet. */
    begin(title: string, plan: StagePlan[], run: RunInfo = {}): void {
        this.title = title;
        this.note = run.note ?? null;
        this.kind = run.kind ?? null;
        this.serverId = run.serverId ?? null;
        this.stages = plan.map((p) => ({
            key: p.key, label: p.label, total: Math.max(0, p.total), done: 0, settled: 0, live: 0,
            state: 'pending', message: p.label, taskId: null,
        }));
        this.current = null;
        this.fraction = 0;
        this.active = true;
        this.outcome = 'running';
        this.startedAt = new Date(this.now()).toISOString();
        this.endedAt = null;
        this.failureMessage = null;
        this.flush();
    }

    isActive(): boolean {
        return this.active;
    }

    /** The hint under the bar, changed while the run goes on (null removes it). */
    setNote(note: string | null): void {
        if (!this.active) return;
        this.note = note;
        this.flush();
    }

    enter(key: ProgressStageKey, message: string): void {
        if (!this.active) return;
        const stage = this.stage(key);
        if (this.current && this.current !== stage && this.current.state === 'active') this.closeTask(this.current, 'done');
        this.current = stage;
        stage.state = 'active';
        stage.message = message;
        if (stage.taskId === null) stage.taskId = this.d.log.open(message, 'major');
        else this.d.log.update(stage.taskId, message, 'loading');
        this.flush();
    }

    setTotal(key: ProgressStageKey, units: number): void {
        if (!this.active) return;
        const stage = this.stage(key);
        stage.total = Math.max(0, units, stage.settled);
        this.schedule();
    }

    report(key: ProgressStageKey, done: number, of: number, message: string): void {
        if (!this.active) return;
        const stage = this.stage(key);
        const share = of > 0 ? Math.min(1, Math.max(0, done / of)) : 0;
        stage.live = share * Math.max(0, stage.total - stage.settled);
        stage.message = message;
        this.schedule();
    }

    settle(key: ProgressStageKey, units: number): void {
        if (!this.active) return;
        const stage = this.stage(key);
        stage.settled = Math.min(stage.total, stage.settled + Math.max(0, units));
        stage.live = 0;
        this.schedule();
    }

    /** Transfer snapshots move the current transfer stage: finished files plus the share of files in lanes. */
    applyTransfer(snapshot: TransferSnapshot): void {
        if (!this.active || !this.current || !TRANSFER_STAGES.has(this.current.key) || !snapshot.active) return;
        const stage = this.current;
        let inLanes = 0;
        for (const lane of snapshot.lanes) {
            if (lane.state === 'active' && lane.size > 0) inLanes += Math.min(1, lane.bytesDone / lane.size);
        }
        const finished = snapshot.filesDone + snapshot.filesFailed;
        stage.live = Math.min(Math.max(0, stage.total - stage.settled), finished + inLanes);
        stage.message = `${snapshot.label} (${count(finished)} of ${count(snapshot.filesTotal)})`;
        this.schedule();
    }

    complete(key: ProgressStageKey, message?: string): void {
        if (!this.active) return;
        const stage = this.stage(key);
        stage.settled = stage.total;
        stage.live = 0;
        if (message) stage.message = message;
        this.closeTask(stage, 'done');
        if (this.current === stage) this.current = null;
        this.flush();
    }

    skip(key: ProgressStageKey): void {
        if (!this.active) return;
        const stage = this.stage(key);
        if (stage.state === 'active' || stage.state === 'done') return;
        stage.state = 'skipped';
        stage.total = 0;
        stage.settled = 0;
        stage.live = 0;
        this.schedule();
    }

    /** Ends the run. A failure marks the stage that was running as failed in the log, a cancel as cancelled. */
    finish(outcome: Exclude<SessionProgress['outcome'], 'running'>, message?: string): void {
        if (!this.active) return;
        let closedCurrent = false;
        for (const stage of this.stages) {
            if (stage.state !== 'active') continue;
            if (stage === this.current) closedCurrent = true;
            if (outcome === 'done') {
                stage.settled = stage.total;
                stage.live = 0;
            }
            if (message && outcome !== 'done' && stage === this.current) stage.message = message;
            this.closeTask(stage, outcome === 'done' ? 'done' : outcome === 'cancelled' ? 'cancelled' : 'error');
        }
        if (outcome === 'done') {
            for (const stage of this.stages) if (stage.state === 'pending') stage.state = 'skipped';
            this.fraction = 1;
        } else if (message && !closedCurrent) {
            // It failed before (or between) stages: the reason still belongs in the log.
            const id = this.d.log.open(message, 'major');
            this.d.log.update(id, message, outcome === 'cancelled' ? 'cancelled' : 'error');
            this.failureMessage = message;
        }
        this.snapshot();                                // takes in what settled since the last emit, while still active
        this.outcome = outcome;
        this.active = false;
        this.current = null;
        this.endedAt = new Date(this.now()).toISOString();
        this.flush();
    }

    snapshot(): SessionProgress {
        if (this.startedAt === null) return { ...IDLE };
        const { done, total } = this.units();
        if (this.active) this.fraction = Math.max(this.fraction, total > 0 ? Math.min(1, done / total) : 0);
        const message = this.current?.message ?? this.lastMessage();
        return {
            active: this.active,
            title: this.title,
            message,
            unitsDone: Math.floor(done),
            unitsTotal: total,
            fraction: this.fraction,
            stages: this.stages.map((s) => ({ key: s.key, label: s.label, done: Math.floor(s.settled + s.live), total: s.total, state: s.state })),
            outcome: this.outcome,
            startedAt: this.startedAt,
            endedAt: this.endedAt,
            note: this.note,
            kind: this.kind,
            serverId: this.serverId,
        };
    }

    dispose(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    private units(): { done: number; total: number } {
        let done = 0;
        let total = 0;
        for (const s of this.stages) {
            if (s.state === 'skipped') continue;
            total += s.total;
            done += Math.min(s.total, s.settled + s.live);
        }
        return { done, total };
    }

    private lastMessage(): string {
        if (this.failureMessage) return this.failureMessage;
        for (let i = this.stages.length - 1; i >= 0; i--) {
            const s = this.stages[i];
            if (s.state === 'failed' || s.state === 'cancelled' || s.state === 'done') return s.message;
        }
        return this.title;
    }

    private stage(key: ProgressStageKey): Stage {
        let stage = this.stages.find((s) => s.key === key);
        if (!stage) {
            // A stage the plan did not expect (one fixed action): add it rather than lose it.
            stage = { key, label: key, total: 1, done: 0, settled: 0, live: 0, state: 'pending', message: key, taskId: null };
            this.stages.push(stage);
        }
        return stage;
    }

    private closeTask(stage: Stage, status: 'done' | 'error' | 'cancelled'): void {
        stage.state = status === 'error' ? 'failed' : status;
        if (stage.taskId !== null) this.d.log.update(stage.taskId, stage.message, status);
    }

    private schedule(): void {
        if (this.timer) return;
        const wait = Math.max(0, (this.d.emitEveryMs ?? EMIT_EVERY_MS) - (this.now() - this.lastEmit));
        this.timer = setTimeout(() => this.flush(), wait);
    }

    private flush(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.lastEmit = this.now();
        const snapshot = this.snapshot();
        if (this.current?.taskId !== null && this.current?.taskId !== undefined && this.current.state === 'active') {
            this.d.log.update(this.current.taskId, this.current.message, 'loading');
        }
        this.d.emit(snapshot);
    }
}

function count(n: number): string {
    return n.toLocaleString('en-US');
}
