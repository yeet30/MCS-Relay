import type { CommandArgs, CommandName, CommandResult, Result } from '../../shared/ipc';
import { invoke } from '../api';
import { useNoticeStore } from './noticeStore';

/** invoke() that also shows the error as a toast. Use it for user actions whose failure has no other place to
 *  be shown; use invoke() directly when the caller shows the error itself. */
export async function request<C extends CommandName>(channel: C, ...args: CommandArgs<C>): Promise<Result<CommandResult<C>>> {
    const result = await invoke(channel, ...args);
    // NOT_SIGNED_IN is handled once, centrally, by returning to the login page.
    if (!result.ok && result.error.code !== 'NOT_SIGNED_IN') useNoticeStore.getState().error(result.error);
    return result;
}
