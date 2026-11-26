/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { Logger } from "@utils/Logger";
import definePlugin, { PluginNative } from "@utils/types";
import { Channel, Message } from "@vencord/discord-types";
import { Button } from "@components/Button";
import { classNameFactory } from "@utils/css";
import { UploadHandler } from "@webpack/common";

import { openCompressModal } from "./CompressModal";
import { cancelJob, dismissJob, onUploadComplete, onUploadError, useJob } from "./jobs";
import { formatBytes, getUploadLimit, isOwnFile, isVideo } from "./limits";
import { settings } from "./settings";

const cl = classNameFactory("vc-vidcomp-");

const logger = new Logger("VideoCompressor");
const Native = VencordNative.pluginHelpers.VideoCompressor as PluginNative<typeof import("./native")>;

type PromptToUpload = (files: File[], channel: Channel, draftType: number, options?: PromptToUploadOptions) => void;

interface PromptToUploadOptions {
    filesMetadata?: object[];
    [key: string]: unknown;
}

/**
 * Runs at the very start of Discord's promptToUpload, which every upload path goes through
 * (drag & drop, paste, the + button, sharing a Clip). Returning true cancels Discord's handling.
 */
function onPromptToUpload(files: ArrayLike<File>, channel: Channel, draftType: number, options?: PromptToUploadOptions): boolean {
    try {
        if (!settings.store.autoIntercept || !channel || !files?.length) return false;
        const { bytes } = getUploadLimit(channel);
        const all = Array.from(files);
        const isBig = (f: File) => !isOwnFile(f) && isVideo(f) && f.size > bytes;
        if (!all.some(isBig)) return false;

        // Hand everything that fits back to Discord, keeping its per-file metadata (e.g. clip info) aligned
        const keepIdx = all.map((f, i) => isBig(f) ? -1 : i).filter(i => i !== -1);
        if (keepIdx.length) {
            const rest = keepIdx.map(i => all[i]);
            const meta = options?.filesMetadata;
            setTimeout(() => (UploadHandler.promptToUpload as PromptToUpload)(rest, channel, draftType, {
                ...options,
                filesMetadata: meta ? keepIdx.map(i => meta[i]) : undefined,
            }), 0);
        }

        all.filter(isBig).forEach(f => openCompressModal(f, channel));
        return true;
    } catch (e) {
        logger.error("Failed to intercept upload, letting Discord handle it", e);
        return false;
    }
}

/** Progress bar under the placeholder message of a background compress-and-send */
function JobAccessory({ message }: { message: Message; }) {
    const job = useJob(message.id);
    if (!job) return null;
    const pct = Math.round(job.progress * 100);
    return (
        <div className={cl("job")}>
            <div className={cl("job-head")}>
                <span className={cl("job-name")}>{job.fileName}</span>
                <span className={cl("muted")}>{formatBytes(job.originalSize)}</span>
            </div>
            {job.error
                ? <div className={cl("error")}>Compression failed: {job.error}</div>
                : <>
                    <div className={cl("bar")}><div className={cl("bar-fill")} style={{ width: `${pct}%` }} /></div>
                    <div className={cl("muted")}>{job.stage}{job.stage !== "Preparing upload" ? ` · ${pct}%` : ""}</div>
                </>}
            <div className={cl("row")}>
                {job.error
                    ? <Button size="small" variant="secondary" onClick={() => dismissJob(job.messageId)}>Dismiss</Button>
                    : <Button size="small" variant="secondary" onClick={() => cancelJob(job.messageId)}>Cancel</Button>}
            </div>
        </div>
    );
}

export default definePlugin({
    name: "VideoCompressor",
    description: "Compress (and optionally trim) videos so they fit your upload limit. Detects your Nitro tier and catches oversized uploads and Clips before Discord rejects them.",
    authors: [{ name: "CalvBot", id: 0n }],
    settings,


    patches: [
        {
            find: "Unexpected mismatch between files and file metadata",
            replacement: {
                match: /(async function\((\i),(\i),(\i)\)\{)(?=let\{filesMetadata:)/,
                replace: "$1if($self.onPromptToUpload($2,$3,$4,arguments[3]))return;"
            }
        },
        {
            // Instant-upload path (used for background sends): add our caption, and report upload errors
            // (e.g. 40005 "too large") so the size-limit log learns where the real line is
            find: "Unexpected mismatch between files and file metadata",
            replacement: {
                match: /(sendMessage\((\i)\.id,\{content:)""(.{0,300}?onAttachmentUploadError:\((\i),(\i),(\i)\)=>\{)/,
                replace: '$1arguments[3]?.vcCaption??""$3$self.onUploadError($2.id,$4,$5,$6);'
            }
        }
    ],

    flux: {
        UPLOAD_COMPLETE(e: { channelId: string; aborted?: boolean; }) {
            if (!e.aborted) onUploadComplete(e.channelId);
        },
    },

    renderMessageAccessory: props => <JobAccessory message={props.message} />,

    onPromptToUpload,

    onUploadError(channelId: string, _file: unknown, code: unknown, reason: unknown) {
        try { onUploadError(channelId, code, reason); } catch (e) { logger.error("onUploadError failed", e); }
    },

    start() {
        Native.cleanupStale().catch(() => { });
    },
});
