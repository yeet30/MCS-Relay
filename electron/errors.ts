import type { AppErrorInfo, ErrorCode } from '../shared/types';
import { DriveError } from './drive/types';

/** An error whose message is written for the user. Throw these inside the main process;
 *  the IPC boundary (electron/ipc/handle.ts) turns every error into an AppErrorInfo. */
export class AppError extends Error {
    readonly code: ErrorCode;
    readonly detail?: string;

    constructor(code: ErrorCode, message: string, detail?: string) {
        super(message);
        this.name = 'AppError';
        this.code = code;
        this.detail = detail;
    }
}

export function toAppError(err: unknown): AppErrorInfo {
    if (err instanceof AppError) return { code: err.code, message: err.message, detail: err.detail };
    if (err instanceof DriveError) return driveErrorInfo(err);
    if (err instanceof Error) {
        if (err.name === 'ChecksumError') return { code: 'CHECKSUM', message: 'A file arrived damaged and was not used.', detail: err.message };
        if (err.name === 'AbortError') return { code: 'UNKNOWN', message: 'The operation was cancelled.', detail: err.message };
        return { code: 'UNKNOWN', message: 'Something went wrong.', detail: err.message };
    }
    return { code: 'UNKNOWN', message: 'Something went wrong.', detail: String(err) };
}

function driveErrorInfo(err: DriveError): AppErrorInfo {
    const detail = `${err.status}${err.reason ? ` ${err.reason}` : ''}: ${err.message}`;
    if (err.status === 0) return { code: 'NETWORK', message: 'Google Drive could not be reached. Check your connection.', detail };
    if (err.status === 401) return { code: 'NOT_SIGNED_IN', message: 'Your Google sign-in expired. Please log in again.', detail };
    if (err.quotaFull) return { code: 'QUOTA_FULL', message: "The owner's Google Drive storage is full, so nobody can change the files they own until they free up space.", detail };
    if (err.rateLimited) return { code: 'RATE_LIMITED', message: 'Google Drive asked the app to slow down. Try again in a minute.', detail };
    if (err.status === 403) return { code: 'FORBIDDEN', message: 'Google Drive refused this action for your account.', detail };
    if (err.status === 404) return { code: 'NOT_FOUND', message: 'The file or folder was not found on Google Drive.', detail };
    return { code: 'NETWORK', message: 'Google Drive returned an error. Try again.', detail };
}

export function errorMessage(err: unknown): string {
    return toAppError(err).message;
}
