// Problem reports. MCS-Relay has no server of its own, so a report travels through the reporter's Google Drive: it is
// saved as a text file in a "MCS-Relay problem reports" folder in their My Drive and shared (read only) with the
// developer's inbox, which Google notifies by email with the reporter's own words. Without sign-in, or when the
// reporter prefers, the same text can be saved as a file instead.
import { writeFile } from 'node:fs/promises';
import { REPORT_INBOX } from '../../shared/types';
import type { UserInfo } from '../../shared/types';
import type { DriveFiles } from '../drive/DriveFiles';
import { AppError } from '../errors';
import type { AppLog } from '../log/AppLog';

export const REPORTS_FOLDER = 'MCS-Relay problem reports';
/** The end of the app's log that a report carries: enough for a few sessions. */
const LOG_TAIL_BYTES = 1_500_000;
/** Drive puts this message into the email it sends the inbox; the full description is in the file. */
const EMAIL_MESSAGE_CHARS = 800;

export interface ReportDeps {
    log: Pick<AppLog, 'tail'>;
    drive: Pick<DriveFiles, 'findFolders' | 'createFolder' | 'createFile' | 'addPermission'>;
    me: () => Promise<UserInfo>;
    /** Lines about the app, this PC and what it is doing right now. */
    about: () => string[];
    chooseSaveFile: (title: string, defaultName: string) => Promise<string | null>;
    inbox?: string;
    now?: () => Date;
}

export class ReportService {
    private readonly inbox: string;
    private readonly now: () => Date;

    constructor(private readonly d: ReportDeps) {
        this.inbox = d.inbox ?? REPORT_INBOX;
        this.now = d.now ?? (() => new Date());
    }

    /** The whole report as plain text. */
    compose(description: string, includeLog: boolean, from: UserInfo | null): string {
        const heading = (title: string) => `${title}\n${'-'.repeat(title.length)}`;
        const parts = [
            'MCS-Relay problem report',
            `Written: ${this.now().toISOString()}`,
            `From: ${from ? `${from.name} <${from.email}>` : 'not signed in'}`,
            '',
            heading('What happened'),
            description.trim(),
            '',
            heading('About this PC'),
            ...this.d.about(),
        ];
        if (includeLog) parts.push('', heading('App log (the most recent part)'), this.d.log.tail(LOG_TAIL_BYTES));
        return `${parts.join('\n')}\n`;
    }

    /** Saves the report in the reporter's Drive and shares it with the inbox, which gets an email about it. */
    async send(description: string, includeLog: boolean): Promise<void> {
        if (!this.inbox) throw new AppError('INVALID', 'This version of MCS-Relay cannot send reports. Save the report as a file instead.');
        const from = await this.d.me();
        const text = this.compose(description, includeLog, from);
        const folder = await this.ensureFolder();
        const file = await this.d.drive.createFile(this.fileName(), folder, { kind: 'bytes', data: new TextEncoder().encode(text) });
        const short = description.trim().length > EMAIL_MESSAGE_CHARS
            ? `${description.trim().slice(0, EMAIL_MESSAGE_CHARS)}…`
            : description.trim();
        await this.d.drive.addPermission(file.id, this.inbox, 'reader', `${short}\n\n(MCS-Relay problem report: the full text and the log are in the file.)`);
        console.log(`[report] sent a problem report (${text.length} characters)`);
    }

    /** Asks where to save the report and writes it there. The path, or null when cancelled. */
    async save(description: string, includeLog: boolean): Promise<string | null> {
        let from: UserInfo | null = null;
        try {
            from = await this.d.me();
        } catch {
            // not signed in: the report says so
        }
        const target = await this.d.chooseSaveFile('Save the problem report', `${this.fileName()}`);
        if (!target) return null;
        await writeFile(target, this.compose(description, includeLog, from), 'utf8');
        console.log('[report] saved a problem report to a file');
        return target;
    }

    private fileName(): string {
        const d = this.now();
        const p = (n: number) => String(n).padStart(2, '0');
        return `MCS-Relay problem report ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.txt`;
    }

    /** The reports folder at the top of My Drive. Not inside "Minecraft Shared Servers": every folder there is a server. */
    private async ensureFolder(): Promise<string> {
        const query = `name = '${REPORTS_FOLDER}' and 'root' in parents and 'me' in owners`;
        const existing = await this.d.drive.findFolders(query);
        if (existing.length > 0) return existing[0].id;
        return (await this.d.drive.createFolder(REPORTS_FOLDER, 'root')).id;
    }
}
