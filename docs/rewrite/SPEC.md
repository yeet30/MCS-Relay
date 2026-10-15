# Drive Launcher rewrite: implementation spec

Repository: `C:/Users/ygtyi/Desktop/Code/minecraft-distributed-hosting` (branch `main`).
Electron 30.5 (Node 20.16), React 18, zustand 5, TypeScript strict, Vite 5 + vite-plugin-electron.
Installed: `google-auth-library@10`, `bottleneck@2.19.5`, `chokidar@4` (NOT 5), `vitest@3`.

Background documents (read the parts relevant to your unit):
- Review of the old code with findings F1-F41: `C:/Users/ygtyi/Desktop/Code/minecraft-distributed-hosting/docs/architecture-review/01-current-structure.html`
- Target design: `C:/Users/ygtyi/Desktop/Code/minecraft-distributed-hosting/docs/architecture-review/02-better-structure.html`
  (where this spec and the design doc differ, THIS SPEC WINS)

Already written, do not change without telling the integrator (they are the contract):
- `shared/types.ts`, `shared/ipc.ts`
- `electron/drive/types.ts` (DriveApi, DriveError, isRetryable, isRateLimit, ChecksumError)
- `electron/errors.ts` (AppError, toAppError)
- `test/fakes/FakeDrive.ts` (in-memory DriveApi; `new FakeDriveStore()`, `store.as(email)`)

## Conventions
- 4-space indentation, semicolons, single quotes, `import type` for type-only imports.
- No `any` (use `unknown` + narrowing). No module-level mutable state except what a module documents as a singleton created in main.ts. Classes get their dependencies through the constructor (dependency injection) so tests can pass fakes.
- Every async call is awaited or deliberately handed to something that handles its errors (`void promise.catch(log)` with a comment).
- Throw `AppError(code, userMessage, detail?)` for expected failures; never return `{ success: false }`.
- Paths: every stored/transmitted path is POSIX and relative to the server folder, made with `toPosix()` from `shared/paths.ts`. Use `path.join(root, ...rel.split('/'))` to get an absolute OS path.
- Big files are streamed; no `readFileSync`/`writeFileSync` on world files. Small JSON files (settings, base, journal) may use synchronous fs with an atomic write (write `*.tmp`, then rename).
- Log with `console.log/warn/error` prefixed by the module, e.g. `[sync]`.
- Tests: vitest, colocated as `*.test.ts` next to the module (electron side) or in `test/`. Use temp dirs from `fs.mkdtemp(os.tmpdir())`. No real network.

## Drive layout (per server folder)
```
<server folder>/                      shared with members as "writer"
  .launcher/                          the app's own files, never part of the world
    lock.json                         LockContent (format 2)
    manifest.json                     Manifest (format 2), written only by a commit
    sync-rules.json                   SyncRules without "builtin": { format: 1, ignore: [...] }
  server.properties, world/..., ...   the server files, mirrored from the manifest
```
Drive allows two files with the same name in one folder. Whenever the app looks up `.launcher`, `lock.json`, `manifest.json`, `sync-rules.json` or a world folder by name, it takes the OLDEST non-trashed match (`listChildren` returns oldest first). After CREATING one of these, re-list; if the one you created is not the oldest, trash yours (you own it) and use the oldest.
Old app files at the server folder root (`lock.json`, `manifest.json`) are ignored (builtin rules) and never read.

## Deletion on Drive (ownership rule) — RESEARCH-CONFIRMED, see APP_PROPS in shared/types.ts
Facts (Google docs, Oct 2026): in a My Drive folder only a file's OWNER may trash or delete it (403 insufficientFilePermissions for anyone else, including the folder creator). Any writer may replace content, change metadata (including appProperties) and, by default, move items inside the shared tree. Storage is charged to the file's owner; trashed files keep counting for 30 days; old revisions are purged within ~30 days unless keepForever (NEVER set keepRevisionForever).
Design:
1. Updates are always in place (`updateContent` on the manifest's driveId). Only real deletions need this section.
2. Every file the app creates gets `appProperties { mdhServer: <serverId>, mdhPath: <relPath> }`.
3. `delete-remote` job: `getMeta(id)` (404 -> already gone, success) ->
   - `capabilities.canTrash` (I own it) -> `trash(id)` (30-day undo for direct deletes) -> outcome `method: 'trashed'`;
   - else if `capabilities.canModifyContent` -> `markDeleted(id, { mdhTombstone: '1', mdhServer, mdhDeletedBy: me.email, mdhDeletedAt: iso }, moveTo)` where moveTo = { addParent: <.launcher/pending-delete folder id>, removeParent: meta.parents[0] } when `capabilities.canMoveItemWithinDrive` and a pending folder id is known; on a 403 caused by the move, retry once WITHOUT moveTo -> outcome `method: 'placeholder'` (0 bytes; the file waits for its owner);
   - else -> AppError('FORBIDDEN').
   A 403 storageQuotaExceeded (DriveError.quotaFull) on any write -> do NOT retry; `getMeta` the file and fail with AppError('QUOTA_FULL', "<owner name>'s Google Drive is full, so nobody can change the files they own.").
4. Placeholders are NOT listed in the manifest (the commit removes the path). Nothing shared has to be written to track them: they are found with `drive.listTombstones(...)`.
5. Owner cleanup (`SyncEngine.cleanupMyPlaceholders()`), no lock needed: `listTombstones({ mineOnly: true })` across ALL servers; group by `appProperties.mdhServer`; read that server's remote manifest once (404 / unreadable / no mdhServer -> nothing references it); skip any placeholder whose id is still referenced by `manifest.files` (an upload that has not committed yet); `deleteForever` the rest (permanent, because trash would keep costing storage; ignore 404). Runs at startup (after resuming uploads) and after each successful upload. Never runs twice at the same time.
6. Preflight reports `cleanup: { mine, others[] }` from one `listTombstones({ mineOnly: false, serverId })` call, so the UI can say "3 deleted files wait for Alex to open the app".
7. Deleting a whole server (owner): first `markDeleted` (no move) every manifest file the owner does NOT own, so each owner's app deletes it for good later; then `trash` the server folder.
Rejected (documented in the report): ownership transfer (one email per file that cannot be turned off, all storage lands on one person, writers still cannot delete afterwards); shared drives (need paid Workspace); plain "remove from folder" (the file lands in the owner's root and other members lose sight of it).

## Module list, ownership and exact API

### shared/paths.ts  (unit: sync-core)
```ts
export function toPosix(relPath: string): string;              // "\\" -> "/", strip leading "./" and "/", collapse "//"
export function parentOf(relPath: string): string;             // "world/region/r.0.0.mca" -> "world/region"; top-level -> ""
export function baseName(relPath: string): string;
export function ancestorsOf(relDir: string): string[];          // "a/b/c" -> ["a", "a/b", "a/b/c"]
export const BUILTIN_IGNORES: string[];                         // [".launcher/", "manifest.json", "manifest.tmp", "lock.json", "*.part", "**/session.lock"]
export const DEFAULT_SHARED_IGNORES: string[];                  // ["logs/", "crash-reports/", "debug/", "*.tmp"]
export function normalizeRule(rule: string): string | null;     // trims, toPosix, rejects empty/".."; keeps a trailing "/" for folders
export function compileRules(rules: string[]): (relPath: string) => boolean;   // true = ignored
// Rule forms: "dir/" -> the folder and everything below it; "*.ext" -> any path ending in ".ext";
// "**/name" -> any path whose last segment is "name"; anything else -> exact path. Case-insensitive on win32 only? -> NO, always case-sensitive except: compare lower-cased when process.platform === 'win32' is NOT available in the renderer, so ALWAYS case-insensitive (Windows users, simpler).
```

### electron/sync/planner.ts  (unit: sync-core) — pure, no I/O
```ts
export function planSync(base: Snapshot, local: Snapshot, remote: Snapshot): SyncPlan;   // exactly the Part 2 table; undefined md5 = missing
export function planUpload(base: Snapshot, local: Snapshot): Pick<SyncPlan, 'upload' | 'deleteRemote'>;
export function planMirrorRemote(local: Snapshot, remote: Snapshot): Pick<SyncPlan, 'download' | 'deleteLocal'>;   // keep-cloud
export function deriveStatus(plan: SyncPlan): Exclude<SyncStatus, 'new-server' | 'unfinished-upload' | 'no-local-path' | 'error'>;
//   conflicts or (any of upload/deleteRemote AND any of download/deleteLocal) -> 'diverged'
//   only upload/deleteRemote -> 'local-changes'; only download/deleteLocal -> 'cloud-newer'; nothing -> 'in-sync'
export function allowedChoices(plan: SyncPlan): ConflictChoice[];   // diverged: conflicts? ['keep-cloud','keep-local'] : ['combine','keep-cloud','keep-local']; else []
export function sumBytes(paths: string[], snap: Snapshot): number;
export function emptyPlan(): SyncPlan;
```
All path lists sorted ascending for stable output.

### electron/sync/scanner.ts  (unit: sync-core)
```ts
export async function md5OfFile(absPath: string, signal?: AbortSignal): Promise<string>;   // streamed
export async function scanLocal(root: string, base: Snapshot, isIgnored: (rel: string) => boolean, signal?: AbortSignal): Promise<Snapshot>;
```
Walk with `fs.promises.readdir(dir, { withFileTypes: true })` recursively (do not follow symlinks; skip ignored folders without descending). For each file `stat`; fast path: same size and mtimeMs as base entry -> reuse base md5 (and keep base driveId); else hash. A file that vanishes between readdir and stat/hash is skipped (ENOENT), never a crash (F35). Hash with limited concurrency (8 at a time). Missing root -> empty snapshot.

### electron/sync/launcherFiles.ts  (ALREADY WRITTEN by the integrator — read it, do not rewrite)
`LauncherFiles(drive)`: findFolder, ensureFolder, findFile(serverId, 'lock.json'|'manifest.json'|'sync-rules.json'), ensureFile(serverId, name, initial), ensureSubfolder(serverId, 'pending-delete'), readText(serverId, name) -> { id, text } | null, writeText(serverId, name, text) -> id, forget(serverId). Handles duplicate names (oldest wins) and stale cached ids (404 -> forget, retry once).

### electron/sync/manifest.ts  (unit: sync-core)
Parsing and conversions only; all Drive access goes through LauncherFiles.
```ts
export function emptyManifest(author: { name: string; email: string }): Manifest;          // revision 0, no files, no folders
export function parseManifest(text: string): Manifest;      // validates format 2 and field types, fills a missing "folders" with {}; throws AppError('INVALID')
export function serializeManifest(m: Manifest): string;     // stable key order (files sorted by path), 2-space JSON
export function manifestToSnapshot(m: Manifest | null): Snapshot;
export function baseToSnapshot(b: BaseSnapshot | null): Snapshot;
export function parseRules(text: string): string[];         // the "ignore" list, normalized with normalizeRule; bad JSON -> DEFAULT_SHARED_IGNORES
export function serializeRules(ignore: string[]): string;   // { format: 1, ignore }
export async function readManifest(launcher: LauncherFiles, serverId: string): Promise<Manifest | null>;
export async function writeManifest(launcher: LauncherFiles, serverId: string, m: Manifest): Promise<void>;
export async function readRules(launcher: LauncherFiles, serverId: string): Promise<string[] | null>;   // null if missing
export async function writeRules(launcher: LauncherFiles, serverId: string, ignore: string[]): Promise<void>;
```
(`parseLock` lives in LockService.ts, not here.)

### electron/lock/LockService.ts  (unit: lock)
```ts
export interface LockServiceDeps {
    drive: DriveApi;
    launcher: LauncherFiles;           // electron/sync/launcherFiles.ts
    me: () => Promise<UserInfo>;
    onLost: (serverId: string, reason: string) => void;
    sleep?: (ms: number) => Promise<void>;     // default real timer; tests pass a fake
    renewEveryMs?: number;                     // 15000
    leaseSeconds?: number;                     // 45
    claimSettleMs?: number;                    // 3000
}
export class LockService {
    constructor(deps: LockServiceDeps);
    readonly sessionId: string;                // crypto.randomUUID(), new per claim (regenerate in claim())
    inspect(serverId: string): Promise<LockView>;        // READ-ONLY. Missing file/folder or phase "free" -> { state:'free' }.
    claim(serverId: string, baseRevision: number, opts?: { phase?: LockPhase; allowStaleFromMe?: boolean }): Promise<void>;
    update(serverId: string, patch: Partial<Pick<LockContent, 'phase' | 'address' | 'players' | 'startedAt' | 'baseRevision'>>): Promise<void>;
    release(serverId: string): Promise<void>;            // writes phase "free" (keeps host for history), stops renewing
    releaseIfMine(serverId: string): Promise<void>;      // inspect first; only release when state === 'mine'
    isHolding(serverId: string): boolean;
    dispose(): void;                                      // stop timers
}
```
Rules: `inspect` = `getMeta(lockId)` (modifiedTime + serverNow) + `readText(lockId)`; `ageSeconds = (serverNow - Date.parse(modifiedTime)) / 1000`; sessionId equal to the current claim's -> 'mine' (regardless of age); else age > leaseSeconds -> 'stale'; else 'held'.
`claim`: inspect; 'held' -> AppError('LOCK_HELD', `${host.name} is ${phaseText}.`); 'stale' with phase 'uploading' -> AppError('UNFINISHED_UPLOAD', ...) unless `allowStaleFromMe` and host.email === me.email; ensure .launcher + lock.json exist (ensureFile with a free lock); write claim (phase from opts or 'claiming'); `sleep(claimSettleMs)`; inspect again; not 'mine' -> AppError('LOCK_HELD', 'Someone else started at the same moment.'); start renewal.
Renewal: `setTimeout` chain every renewEveryMs: inspect -> not 'mine' -> stop renewing, `onLost(serverId, 'Another member took over the server.')`; else rewrite current content (fresh modifiedTime). Network errors: log and keep going (the lease survives two misses).
Writes: `drive.updateContent(lockId, { kind:'bytes', data: utf8 JSON })`. Never trash or delete lock.json. Never write from inspect (F11).
Fixes: F6, F7, F11, F27, F34 (and the lock half of F8).

### electron/transfer/LaneController.ts, progress.ts, TransferEngine.ts  (unit: transfer)
```ts
// LaneController.ts
export class LaneController {
    constructor(opts: { start: number; min: number; max: number; cleanJobsPerStep?: number /*20*/ });
    get lanes(): number;
    onSuccess(): void;          // +1 after N clean jobs, up to ceiling
    onThrottled(): void;        // halve (>= min), reset streak
    onNoSpeedGain(): void;      // ceiling = max(min, lanes - 1); set(ceiling)
    onChange(listener: (lanes: number) => void): () => void;
}

// progress.ts
export class ProgressReporter {
    constructor(opts: { now?: () => number });
    begin(label: string, jobs: Array<{ path: string; kind: TransferKind; size: number }>, laneLimit: number): void;
    jobStarted(path: string): number;               // returns lane slot (lowest free)
    jobProgress(path: string, bytesDone: number): void;
    jobBackoff(path: string, retryInMs: number): void;
    jobDone(path: string): void;
    jobFailed(path: string, kind: TransferKind, message: string): void;
    setLaneLimit(n: number): void;
    tick(): void;                                    // EWMA update: speed = 0.8*speed + 0.2*sample (seconds since last tick)
    end(): void;
    snapshot(): TransferSnapshot;                    // etaSec = max(remainingBytes/bytesPerSec, remainingFiles/filesPerSec), null until speeds > 0
    speedGainCheck(): 'gain' | 'no-gain' | 'unknown';  // compares bytesPerSec now vs when the last lane was added (10 s window, 5% threshold)
}

// TransferEngine.ts
export type TransferJob =
    | { kind: 'download'; path: string; driveId: string; size: number; md5: string; dest: string }
    | { kind: 'upload'; path: string; name: string; size: number; md5: string; source: string; driveId?: string; parentId?: string; appProperties?: Record<string, string> }
    | { kind: 'delete-remote'; path: string; driveId: string; serverId: string; pendingFolderId: string | null }
    | { kind: 'delete-local'; path: string; target: string };
export type JobOutcome =
    | { kind: 'download'; path: string; driveId: string; md5: string; size: number; mtimeMs: number }
    | { kind: 'upload'; path: string; driveId: string; md5: string; size: number }
    | { kind: 'delete-remote'; path: string; method: 'trashed' | 'placeholder' | 'already-gone' }
    | { kind: 'delete-local'; path: string };
export interface TransferResult { done: JobOutcome[]; failed: Array<{ job: TransferJob; error: AppErrorInfo }> }
export interface TransferEngineDeps {
    drive: DriveApi;
    me: () => Promise<UserInfo>;
    emit: (snapshot: TransferSnapshot) => void;     // throttled by the engine: every tickMs while active, plus once at the end
    lanes?: { start: number; min: number; max: number };   // default 4 / 1 / 12
    maxAttempts?: number;                           // 5
    backoffMs?: (attempt: number) => number;        // default min(2^n*1000 + random*1000, 32000)
    tickMs?: number;                                // 250
    now?: () => number;
}
export class TransferEngine {
    constructor(deps: TransferEngineDeps);
    run(label: string, jobs: TransferJob[], signal?: AbortSignal): Promise<TransferResult>;   // never rejects for job failures; rejects only on abort
    snapshot(): TransferSnapshot;
}
```
Engine: one `Bottleneck({ maxConcurrent })` per `run`; `limiter.on('failed')` -> rate limit -> `lanes.onThrottled()`; retryable and `retryCount < maxAttempts-1` -> return backoff ms (and `progress.jobBackoff`). `lanes.onChange` -> `limiter.updateSettings({ maxConcurrent })`. After each lane increase, 10 s later call `progress.speedGainCheck()`; 'no-gain' -> `lanes.onNoSpeedGain()`. Abort: `signal` aborts in-flight requests (pass to DriveApi) and `limiter.stop({ dropWaitingJobs: true })`.
Job semantics:
- download: `drive.download(driveId, dest + '.part')`; md5 !== job.md5 -> throw ChecksumError (retryable); rename `.part` over `dest` (mkdir parent first); `stat` -> mtimeMs.
- upload: `driveId ? updateContent(driveId, file) : createFile(name, parentId!, file, opts, appProperties)`; result md5 !== job.md5 -> ChecksumError.
- delete-remote: the ownership rule above (trash, or placeholder via markDeleted).
- quotaFull errors are never retried and are reported with the owner's name (see the deletion section).
- delete-local: `fs.rm(target, { force: true })`, then remove now-empty parent folders up to (not including) the server root (best effort).
Fixes: F18, F19, part of F12.

### electron/sync/changeTracker.ts  (unit: sync-engine)
```ts
export class ChangeTracker {
    constructor(deps: { emit: (batch: ChangeBatch) => void; reset: () => void; flushMs?: number /*500*/ });
    start(root: string, isIgnored: (rel: string) => boolean): Promise<void>;   // chokidar 4, ignoreInitial: true, awaitWriteFinish { stabilityThreshold: 2000 }
    stop(): Promise<void>;                     // awaits watcher.close(), flushes, keeps the map
    clear(): void;                             // empties the map and calls reset()
    all(): ChangeBatch;                        // everything since start
}
```
A file that was 'added' and then 'changed' stays 'added'; 'added' then 'removed' disappears from the map.

### electron/sync/SyncEngine.ts  (unit: sync-engine)
```ts
export interface SyncEngineDeps {
    drive: DriveApi;
    launcher: LauncherFiles;
    lock: LockService;                 // only inspect() is used here
    transfers: TransferEngine;
    appData: AppData;
    settings: SettingsService;         // for the local path
    me: () => Promise<UserInfo>;
    step: (message: string, status?: StepMessage['status'], importance?: StepMessage['importance']) => void;
    now?: () => number;
}
export class SyncEngine {
    constructor(deps: SyncEngineDeps);
    preflight(serverId: string, signal?: AbortSignal): Promise<SyncReport>;     // READ-ONLY on Drive and disk
    resolve(serverId: string, choice: ConflictChoice): Promise<SyncReport>;     // see below
    pendingChoice(serverId: string): ConflictChoice | null;
    /** Under the lock (phase downloading): brings the local folder to the cloud's state for this session. */
    download(serverId: string, report: SyncReport, signal?: AbortSignal): Promise<void>;
    /** Under the lock (phase uploading): scan, plan vs base, journal, ensure folders, transfer, verify, commit, base, journal delete. */
    uploadSession(serverId: string, signal?: AbortSignal): Promise<{ uploaded: number; deleted: number; revision: number }>;
    /** No lock needed: permanently deletes my placeholders that no manifest references any more. Returns how many. */
    cleanupMyPlaceholders(signal?: AbortSignal): Promise<number>;
    /** Owner deleting a whole server: marks every manifest file I do not own as a placeholder (so its owner deletes it). */
    markForeignFilesDeleted(serverId: string): Promise<number>;
    hasJournal(serverId: string): boolean;
    serversWithJournal(): string[];
    getRules(serverId: string): Promise<SyncRules>;
    setRules(serverId: string, ignore: string[]): Promise<SyncRules>;
    loadRules(serverId: string): Promise<(rel: string) => boolean>;           // builtin + shared (creates sync-rules.json with defaults + AppData.legacyBlacklist() if missing)
}
```
preflight: local path missing -> status 'no-local-path'. Read base (AppData), remote manifest (LauncherFiles), lock (LockService.inspect), rules; scan local with base fast path. If remote is null -> status 'new-server' with plan.upload = all local files. Else plan = planSync(base ?? empty, local, remote); status = deriveStatus(plan); a stale lock in phase 'uploading' that is not mine -> 'unfinished-upload'. `cleanup` from one `listTombstones({ mineOnly: false, serverId })` (mine vs others grouped by owner email). `allowedChoices` from the planner. `pendingChoice` from memory. Sizes from the snapshots. Never writes anything.
resolve: 'keep-local' -> write base := remote manifest entries (mtimeMs -1 for files whose local md5 differs, real local mtime where equal), revision = remote.revision; clear choice; return preflight. 'keep-cloud' -> copy every local file that differs from the cloud (or exists only locally) into `AppData.backupDir(serverId, 'keep-cloud')` preserving relative paths, remember the choice; return preflight (status stays 'diverged' but pendingChoice is set). 'combine' -> only allowed when there are no conflicts; remember the choice.
download: re-run the planning under the lock (the cloud may have changed since preflight). If status is 'diverged' and no pending choice -> AppError('CONFLICT'). keep-cloud -> planMirrorRemote; otherwise use plan.download/deleteLocal (combine keeps local changes for the upload). Jobs: download -> TransferEngine (`dest` = absolute path); deleteLocal -> delete-local jobs. Any failure -> AppError('DOWNLOAD_INCOMPLETE'). Then write the new base: for every remote file present locally with matching md5 -> remote entry + local mtimeMs; for local-changed files (combine) keep the remote entry with mtimeMs -1; revision = remote.revision; folders = remote.folders. If remote is null (new server) write a base with revision 0 and no files. Clear the pending choice.
uploadSession: if a journal exists for the server we are resuming: before uploading an `update` job, `getMeta(driveId)` and skip it when `md5Checksum` already equals the local md5. Steps: rules -> scan -> planUpload(base, local) -> if nothing to do: return (still write base if revision differs). Write journal `{ format:1, serverId, startedAt, baseRevision, sessionId }`. Ensure folders: for every parent dir of uploads, depth order, use `remote.folders` / created map; create missing with `drive.createFolder` (dedupe by listing the parent for an existing folder with that name first). Ensure `.launcher/pending-delete` exists when there are deletions (LauncherFiles.ensureSubfolder). Upload jobs: existing path -> driveId from remote manifest (update in place); else create in parentId with appProperties { mdhServer, mdhPath }. deleteRemote -> delete-remote jobs. Any failure -> AppError('UPLOAD_INCOMPLETE', `${n} files failed to upload.`) (journal stays). Re-read the remote manifest: revision !== base.revision -> AppError('CONFLICT', 'The cloud changed during your upload.'). Build the next manifest: revision+1, parentRevision = base.revision, files = remote files + uploads - deleted paths (every delete outcome removes the path), folders merged. `launcher.writeManifest` (THE COMMIT). Write base = next manifest + local mtimes. Delete journal. Then `cleanupMyPlaceholders()` in the background (log errors).
cleanupMyPlaceholders / markForeignFilesDeleted: see the deletion section (points 5 and 7).
Fixes: F1, F2, F3, F4, F13, F14, F15, F16, F22, F23, F24, F25, F35, and the ownership problem the author reported.

### electron/processes/MinecraftProcess.ts, PlayitProcess.ts  (unit: processes)
```ts
export interface MinecraftProcessDeps {
    onOutput: (lines: string[]) => void;          // console lines, without the hidden "list" replies
    onPlayers: (players: string[]) => void;
    onExit: (code: number | null, expected: boolean) => void;   // expected = we asked it to stop
    spawnImpl?: typeof import('node:child_process').spawn;
    playerPollMs?: number;                        // 20000
}
export class MinecraftProcess {
    constructor(deps: MinecraftProcessDeps);
    /** Resolves when the server prints "Done (". Rejects with AppError('JAVA' | 'TIMEOUT') if it exits first or times out (then kills it). */
    start(opts: { serverPath: string; javaFlags: JavaFlags; readyTimeoutMs: number; signal?: AbortSignal }): Promise<void>;
    isRunning(): boolean;
    send(command: string): void;                  // AppError('INVALID') when not running
    /** Sends "stop", waits for the process to exit; after timeoutMs kills the process tree. No-op when not running. */
    stopAndWait(timeoutMs?: number): Promise<void>;
    static readMaxPlayers(serverPath: string): number | null;
    static buildLaunchArgs(serverPath: string, javaFlags: JavaFlags): string[];   // exported for tests
}
export class PlayitProcess {
    constructor(deps?: { spawnImpl?: typeof import('node:child_process').spawn });
    /** Starts the agent and resolves with the "*.joinmc.link" address; AppError('PLAYIT'|'TIMEOUT') otherwise (kills it). */
    start(executable: string, timeoutMs: number, signal?: AbortSignal): Promise<string>;
    stop(): Promise<void>;                        // Windows: `taskkill /PID <pid> /T /F` awaited; else SIGTERM then SIGKILL
    isRunning(): boolean;
}
```
Launch args (carried over from the old `main` commit eb7ec4f): if `run.bat` (win32) / `run.sh` exists, parse its first line starting with `java ` (strip `%*`, `"$@"`), split respecting quotes, use those args after `java`; else exactly one `*.jar` -> `-jar <jar>`; prefix `-Xmx{max}M -Xms{min}M` and the custom flags (split respecting quotes); append `nogui` if missing. Java check: `execFile('java', ['-version'])` (async). eula.txt: write `eula=true` only if missing or different (F39). Player polling: every playerPollMs write `list`; hide the "There are N of a max of M players online" line from output; ANSI codes stripped. Console output batched (flush every 100 ms). Fixes: F5 (stopAndWait), F21 (timeouts), F39, F41.

### electron/auth/GoogleAuth.ts  (unit: drive-auth)
```ts
export const SCOPES: { base: string[]; collaboration: string };
export class GoogleAuth {
    constructor(deps: { userDataDir: string; credentialsPath: string; openExternal: (url: string) => Promise<void>; safeStorage?: { isEncryptionAvailable(): boolean; encryptString(s: string): Buffer; decryptString(b: Buffer): string } });
    status(): Promise<AuthStatus>;
    login(): Promise<AuthStatus>;               // ONE consent with drive + userinfo.email + userinfo.profile (research: drive.file cannot see other members' files); loopback on 127.0.0.1 with a random free port, PKCE + state, 5 min timeout, server always closed
    enableCollaboration(): Promise<AuthStatus>; // only for tokens from the old two-step login that lack the drive scope: incremental auth (include_granted_scopes)
    logout(): Promise<void>;                    // revoke the refresh token at Google (fixes F36's acces_token), delete stored tokens, clear caches
    getAccessToken(): Promise<string>;          // single in-flight refresh shared by all callers (F28); AppError('NOT_SIGNED_IN')
    invalidateAccessToken(): void;              // after a 401
    me(): Promise<UserInfo>;                    // cached per login
    hasScope(scope: string): boolean;
}
```
One OAuth2Client for the app's lifetime. A refresh that fails with invalid_grant (revoked, 6 months unused, or the 7-day expiry of an OAuth app left in Testing mode) deletes the stored tokens and throws AppError('NOT_SIGNED_IN') so the UI returns to the login page. Tokens saved encrypted with Electron safeStorage to `tokens.bin` when available, else `token.json`; on startup migrate a legacy plaintext `token.json` into `tokens.bin` and delete the plaintext file.

### electron/drive/DriveClient.ts, DriveFiles.ts  (unit: drive-auth)
```ts
export class DriveClient {
    constructor(deps: { auth: { getAccessToken(): Promise<string>; invalidateAccessToken(): void }; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; maxRetries?: number /*4*/ });
    request(method: string, url: string, init?: {
        query?: Record<string, string | number | boolean | undefined>;
        headers?: Record<string, string>;
        body?: BodyInit | null;
        json?: unknown;                         // sets body + content-type
        retry?: boolean;                        // default true: retry retryable errors with backoff; transfers pass false
        signal?: AbortSignal;
        expect?: 'json' | 'text' | 'none' | 'response';
    }): Promise<{ data: unknown; response: Response; serverNow: number }>;
}
export class DriveFiles implements DriveApi {
    constructor(client: DriveClient);
    // DriveApi (see electron/drive/types.ts), plus admin operations used by ServersService:
    findFolders(query: string): Promise<DriveFileMeta[]>;                        // raw q, non-trashed
    listPermissions(fileId: string): Promise<Array<{ id: string; emailAddress: string; displayName: string; role: string; photoLink?: string }>>;
    addPermission(fileId: string, email: string, role: 'writer' | 'reader', message: string): Promise<void>;
    deletePermission(fileId: string, permissionId: string): Promise<void>;
}
```
Errors: non-2xx -> parse Google's JSON error (`error.errors[0].reason`, `error.message`) into `DriveError(message, status, reason)`; network failure -> `DriveError(message, 0)`. 401 -> `auth.invalidateAccessToken()` and repeat once. Retry (when `retry` is true) retryable errors with Google's backoff, max `maxRetries`.
Uploads: size <= 5 MiB -> one request (`uploadType=multipart` for create, `uploadType=media` PATCH for update); larger -> resumable session, 8 MiB chunks (multiple of 256 KiB) read from disk, `Content-Range`, handle 308 (Range header) and resume after a dropped chunk by querying `bytes */total`. Always request `fields=id,md5Checksum,size`. Report progress through `onProgress`. Download: `alt=media`, stream the body to destPath while hashing (pipeline), report progress. All requests use `supportsAllDrives=true`. Metadata field list: `id,name,mimeType,size,md5Checksum,createdTime,modifiedTime,trashed,ownedByMe,owners(emailAddress,displayName,me),capabilities(canTrash,canDelete,canModifyContent,canRename,canAddChildren),parents`. Escape single quotes in `q` names.
Fixes: F18, F19, F26, F28.

### electron/store/appData.ts, electron/settings/SettingsService.ts, electron/servers/ServersService.ts  (unit: services)
```ts
// appData.ts
export interface UploadJournal { format: 1; serverId: string; startedAt: string; baseRevision: number; sessionId: string }
export class AppData {
    constructor(root: string);                       // app.getPath('userData')
    readSettings(): AppSettings; writeSettings(s: AppSettings): void;
    readServerSettings(id: string): ServerSettings; writeServerSettings(id: string, s: ServerSettings): void;
    removeServer(id: string): void;                  // deletes servers/<id> except backups
    readBase(id: string): BaseSnapshot | null; writeBase(id: string, b: BaseSnapshot): void;
    readJournal(id: string): UploadJournal | null; writeJournal(id: string, j: UploadJournal): void; deleteJournal(id: string): void;
    serversWithJournal(): string[];
    backupDir(id: string, label: string): string;    // servers/<id>/backups/<yyyy-mm-dd_hh-mm-ss>-<label>/ (created)
    migrateLegacy(): void;                           // one-time import of localStore.json (see below), idempotent
    legacyBlacklist(): string[];
}
```
Layout: `<userData>/settings.json`, `<userData>/servers/<id>/{settings.json, base.json, journal.json, backups/}`. Atomic JSON writes. Corrupt JSON -> defaults (and keep a `.corrupt` copy).
Legacy import (`localStore.json`, written by the old app): `paths[id]` -> server settings localPath; `joinedServerIds`; `localVariables.playitggPath`; `checklist.playitgg` -> usePlayitgg; `checklist.serverConsole` -> launchServer; `allocatedRAM {MIN,MAX}` or `javaFlags {minRAM,maxRAM,customFlags}` -> every migrated server's javaFlags; `watcherBlacklist` -> legacyBlacklist (normalized, minus manifest.json/lock.json). Rename the old file to `localStore.migrated.json`.
```ts
// SettingsService.ts
export class SettingsService {
    constructor(deps: { appData: AppData; dialogs: Dialogs });
    get(): AppSettings; set(patch): AppSettings;                       // validates
    getServer(id): ServerSettings; setServer(id, patch): ServerSettings;   // minRAM <= maxRAM, 256..65536, integers
    setLocalPath(id: string, localPath: string | null): void;
    addJoined(id: string): void; removeJoined(id: string): void;
    choosePlayitPath(): Promise<string | null>;
}
export interface Dialogs { chooseFolder(title: string): Promise<string | null>; chooseFile(title: string, filters?: Array<{ name: string; extensions: string[] }>): Promise<string | null>; openPath(p: string): Promise<void> }

// ServersService.ts
export class ServersService {
    constructor(deps: { drive: DriveFiles; launcher: LauncherFiles; auth: GoogleAuth; settings: SettingsService; appData: AppData; dialogs: Dialogs });
    list(): Promise<ServerSummary[]>;     // owned: children of "Minecraft Shared Servers"; joined: settings.joinedServerIds; members via listPermissions ONCE per folder; me() ONCE (F40)
    create(): Promise<ServerSummary>;     // max 3 owned; "Server-N"; then .launcher with lock.json (free), sync-rules.json (defaults + legacy blacklist)
    delete(id: string): Promise<void>;    // owner only: markForeignFilesDeleted(id) first (injected callback from SyncEngine), then trash the folder + appData.removeServer
    rename(id: string, name: string): Promise<void>;
    invite(id: string, email: string, role: 'writer' | 'reader', message: string): Promise<void>;   // the role is actually used (old code ignored it)
    removeMember(id: string, permissionId: string): Promise<void>;
    leave(id: string): Promise<void>;     // remove my own permission + forget the server locally
    join(folderId: string): Promise<ServerSummary>;   // accepts an ID or a Drive folder URL
    chooseLocalPath(id: string): Promise<string | null>;
    openFolder(id: string): Promise<void>;
    info(id: string): ServerInfo;         // maxPlayers from the local server.properties
}
```
Fixes: F24 (shared rules created), F33 support (myRole), F40.

### electron/session/SessionController.ts  (unit: session)
```ts
export interface EventSink { emit<E extends EventName>(event: E, payload: Events[E]): void }
export interface SessionDeps {
    lock: LockService; sync: SyncEngine; transfers: TransferEngine; changes: ChangeTracker;
    minecraft: MinecraftProcess; playit: PlayitProcess; settings: SettingsService;
    events: EventSink; now?: () => number; lockPollMs?: number /*20000*/;
}
export class SessionController {
    constructor(deps: SessionDeps);
    getState(): SessionState;
    lastReport(): SyncReport | null;
    steps(): StepMessage[];                     // last 50
    consoleLines(): string[];                   // last 1000
    select(serverId: string | null): Promise<void>;       // remembers selection, preflight, polls lock every lockPollMs while idle (emits lock:update)
    preflight(serverId: string): Promise<SyncReport>;     // emits sync:report
    start(serverId: string): Promise<void>;
    stop(): Promise<void>;                     // idempotent; only acts in "running"
    resolve(serverId: string, choice: ConflictChoice): Promise<SyncReport>;
    retryUpload(): Promise<void>;              // only in "upload-pending"
    dismiss(): void;                           // failed -> idle
    command(text: string): void;
    onMinecraftOutput(lines: string[]): void;  // wired by main.ts
    onMinecraftExit(code: number | null, expected: boolean): void;   // running + unexpected -> stop() (crash path)
    onPlayers(players: string[]): void;        // updates state + lock (update players)
    onLockLost(serverId: string, reason: string): void;   // abort transfers, stop Java WITHOUT uploading, phase failed (LOCK_LOST)
    resumeUnfinishedUploads(): Promise<void>;  // on startup: for each journal -> claim (allowStaleFromMe) -> uploading -> release
    shutdown(): Promise<void>;                 // for quit/logout: running -> stop(); waits until idle/upload-pending/failed
    isBusy(): boolean;                         // anything other than idle/failed
}
```
Phases exactly as Part 2 Figure 3. After resumeUnfinishedUploads() at startup, call sync.cleanupMyPlaceholders() in the background and emit a step when it deleted something. start(): checking (preflight; 'unfinished-upload' -> AppError('UNFINISHED_UPLOAD'); 'no-local-path' -> AppError('NO_LOCAL_PATH'); 'diverged' without a pending choice -> AppError('CONFLICT')) -> claiming (`lock.claim(serverId, baseRevision)`) -> downloading (`lock.update({phase})`, `sync.download`) -> launching (playit when settings.usePlayitgg and a path is set, with a 60 s timeout; Minecraft when settings.launchServer, 180 s timeout) -> running (`lock.update({phase:'running', startedAt, address})`, `changes.start(root, rules)`). Any failure before running: stop Java and playit, `lock.releaseIfMine`, phase failed, rethrow. stop(): only from running; stopping (`changes.stop()`, `minecraft.stopAndWait(60000)`, `playit.stop()`) -> uploading (`sync.uploadSession`; failure -> phase upload-pending, keep the lock renewing, return) -> releasing (`lock.release`) -> idle -> preflight again. Every phase change: emit session:state, `lock.update({ phase })` while holding, and a StepMessage. Fixes: F5, F8, F9, F21, F30.

### electron/ipc/handle.ts, handlers.ts, electron/main.ts, electron/preload.ts  (unit: wiring)
```ts
// handle.ts
export function handle<C extends CommandName>(channel: C, run: (...args: CommandArgs<C>) => CommandResult<C> | Promise<CommandResult<C>>): void;   // try/catch -> Result; logs errors
export function createEventSink(getWindow: () => BrowserWindow | null): EventSink;    // safe when the window is gone
// handlers.ts
export function registerHandlers(deps: { auth; servers; session; settings; sync; app: { quitResponse(confirmed: boolean): void; openExternal(url: string): Promise<void> } }): void;   // one line per Commands entry; validates arguments (strings non-empty, choice in the enum)
```
preload.ts exposes ONLY `window.api: BridgeApi` (invoke + on returning an unsubscribe). Remove `window.ipcRenderer` (F31). `app:openExternal` only allows https URLs.
main.ts: composition root + window (800x600, not resizable, icon, preload) + tray + minimize-to-tray + quit flow: close/tray-quit -> if `session.isBusy()` emit `app:confirmQuit` and wait for `app:quitResponse`; confirmed -> emit `app:quitting`, `await session.shutdown()`, `lock.dispose()`, then quit. Not busy -> quit directly. On startup: `appData.migrateLegacy()`, then after the window loads `session.resumeUnfinishedUploads()`.

### src/** renderer  (unit: renderer)
See the separate section in the task prompt.

## Findings -> where they are fixed
F1 TransferEngine/SyncEngine flat job lists (no Object.entries on a Map) · F2 SyncEngine commit writes .launcher/manifest.json last · F3 md5 instead of counters · F4 full relative paths everywhere · F5 MinecraftProcess.stopAndWait + SessionController.stop · F6 LockService renewal for the whole session · F7 claim only when free/stale · F8 SessionController decides upload from its own phase · F9 stop() idempotent · F10 manual Download/Upload removed from the UI · F11 inspect never writes · F12 everything awaited · F13 errors thrown as AppError, deletes applied · F14 per-server base files, no globals · F15 three-way plan warns before overwriting · F16 base stores local mtimes after download · F17 ignoreInitial true + batching + no Set copying · F18 streaming + async fs · F19 lanes + one request per small file + driveIds in manifest · F20 build fixed, typecheck script · F21 timeouts + finally cleanup · F22 builtin rules in code · F23/F25 toPosix everywhere · F24 shared sync-rules.json · F26 one error convention (AppError -> Result) · F27 setTimeout renewal chain, failures handled · F28 one OAuth client + single-flight refresh · F29 no circular imports · F30 main.ts only wires · F31 typed IPC contract · F32 one owner per fact · F33 ownership from myRole/session phase, DirectoryMenu prop fixed · F34 Google's clock for expiry · F35 ENOENT tolerated · F36 typos fixed incl. token revoke · F37 effects unsubscribe · F38 progress closes via state, not events · F39 eula written only when needed · F40 leftovers removed, permissions fetched once · F41 playit condition fixed.
