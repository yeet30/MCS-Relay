// The appProperties every file and folder the app creates carries, so a later run can recognise its own work
// (an interrupted upload, a create whose answer got lost, leftovers to clean up).
import { createHash } from 'node:crypto';
import { APP_PROPS } from '../../shared/types';

/** Drive's limit per property: key and value together, in UTF-8 (403 propertyLengthLimitExceeded beyond it). */
const MAX_PROPERTY_BYTES = 124;

export function pathHash(relPath: string): string {
    return createHash('sha1').update(relPath, 'utf8').digest('hex');
}

/** Server id and path hash always; the readable path too when it fits the limit (deep mod paths often do not). */
export function creationTags(serverId: string, relPath: string): Record<string, string> {
    const tags: Record<string, string> = { [APP_PROPS.server]: serverId, [APP_PROPS.pathHash]: pathHash(relPath) };
    if (Buffer.byteLength(APP_PROPS.path + relPath, 'utf8') <= MAX_PROPERTY_BYTES) tags[APP_PROPS.path] = relPath;
    return tags;
}

/** True when `props` mark a live (not deleted) item this app created for `relPath` in `serverId`.
 *  Files from before the hash existed only carry mdhPath. */
export function taggedAs(props: Record<string, string> | undefined, serverId: string, relPath: string): boolean {
    if (!props || props[APP_PROPS.server] !== serverId || props[APP_PROPS.tombstone] === '1') return false;
    const hash = props[APP_PROPS.pathHash];
    return hash !== undefined ? hash === pathHash(relPath) : props[APP_PROPS.path] === relPath;
}
