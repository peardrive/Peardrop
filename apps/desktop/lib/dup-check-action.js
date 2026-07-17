/**
 * MODULE: lib/dup-check-action.js
 * PURPOSE: Pure mapping from a `hyperdrive-check-duplicate` IPC result to the
 *          renderer's action decision. Extracted so the branch logic can be
 *          unit-tested under `node --test` without launching Electron.
 * DESIGN NOTE:
 *   The pre-sprint renderer treated `isDuplicate: true` uniformly — it always
 *   showed "Already downloaded" and returned. This ignored `localStatus`,
 *   which the backend already computes: `available` when the drive's files
 *   are still on disk, `missing` when the manifest entry survives but the
 *   files are gone. The gap masked the "cancelled/crashed open leaves a
 *   stub" bug — a stub entry with empty files would report `localStatus:
 *   'missing'`, and a paste of the same link got a dead "Already
 *   downloaded" toast that blocked re-download.
 *   This module encodes the honest three-way decision:
 * Not a duplicate → proceed with the normal open flow (`proceed`).
 * Duplicate + files present → the drive is really already downloaded;
 *     show the "Already downloaded" hint and don't re-download (`block`).
 * Duplicate + files missing → the manifest entry is a leftover (from a
 *     cancelled open, a manual file deletion, or an interrupted crash); ask
 *     the user whether to re-download and, on confirm, use `forceOpen: true`
 *     so the open path skips its own duplicate check (`confirm-redownload`).
 * EXPORTS (via window.PearDupCheckAction, also module.exports for tests):
 * decideDupCheckAction(dupCheckResult)
 *       → { action: 'proceed' | 'block' | 'confirm-redownload',
 *           reason?: 'seeking', driveId?, existingDrive? }
 * KEY STATE: none (pure functions)
 */
(function (root) {
    'use strict';

    function decideDupCheckAction(dupCheckResult) {
        const result = dupCheckResult || {};

        if (!result.isDuplicate) {
            return { action: 'proceed' };
        }

        // Duplicate — branch on localStatus.

        // Still seeking (provider never seen; manifestLoaded === false on the
        // backend entry): the drive is already in the list waiting for its
        // sender. Block the re-open and let the renderer highlight the
        // existing row — this is NOT the "files missing, offer re-download"
        // case, which is reserved for drives that actually downloaded once.
        if (result.localStatus === 'seeking') {
            return {
                action: 'block',
                reason: 'seeking',
                driveId: result.driveId,
                existingDrive: result.existingDrive || null,
            };
        }

        if (result.localStatus === 'missing') {
            return {
                action: 'confirm-redownload',
                driveId: result.driveId,
                existingDrive: result.existingDrive || null,
            };
        }

        // Treat any other localStatus (including `available`, or missing/absent
        // defensive default matching the pre-sprint blocking behavior) as
        // block. The pre-sprint code blocked on every duplicate; keeping that
        // as the fallback ensures we never silently start a re-download when
        // the caller can't confirm files are gone.
        return {
            action: 'block',
            driveId: result.driveId,
            existingDrive: result.existingDrive || null,
        };
    }

    const PearDupCheckAction = { decideDupCheckAction };

    if (typeof module === 'object' && module.exports) module.exports = PearDupCheckAction;
    if (root) root.PearDupCheckAction = PearDupCheckAction;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
