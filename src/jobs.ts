/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Background compress-and-send jobs. While a job runs, a local "sending" message sits in the
// channel with a progress bar (rendered by the message accessory in index.tsx), so Discord stays
// usable. When the encode finishes, the placeholder is swapped for a real send through Discord's
// own upload path, which shows its normal upload progress.

import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";
import { Channel } from "@vencord/discord-types";
import { findByCodeLazy } from "@webpack";
import { DraftType, FluxDispatcher, MessageActions, showToast, UploadHandler, UserStore, useEffect, useState } from "@webpack/common";

import { formatBytes, markOwnFile, UploadLimit } from "./limits";
import type { EncodeOptions, JobStatus } from "./types";

const Native = VencordNative.pluginHelpers.VideoCompressor as PluginNative<typeof import("./native")>;
const logger = new Logger("VideoCompressor");
const createBotMessage = findByCodeLazy('username:"Clyde"');
const CHUNK = 8 * 1024 * 1024;

export interface BackgroundJob {
    messageId: string;
    channelId: string;
    fileName: string;
    originalSize: number;
    stage: string;
    progress: number;
    error: string | null;
    nativeJobId: string | null;
    cancelled: boolean;
}

const jobs = new Map<string, BackgroundJob>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

export function useJob(messageId: string) {
    const [, force] = useState(0);
    useEffect(() => {
        const l = () => force(n => n + 1);
        listeners.add(l);
        return () => void listeners.delete(l);
    }, []);
    return jobs.get(messageId);
}

function update(job: BackgroundJob, patch: Partial<BackgroundJob>) {
    Object.assign(job, patch);
    emit();
}

// ---------- upload outcome tracking (for the size-limit log) ----------

interface PendingUpload { size: number; limit: UploadLimit; expires: number; }
const pendingUploads = new Map<string, PendingUpload>();

function takePending(channelId: string) {
    const p = pendingUploads.get(channelId);
    pendingUploads.delete(channelId);
    return p && p.expires > Date.now() ? p : null;
}

export function onUploadComplete(channelId: string) {
    const p = takePending(channelId);
    if (p) Native.logUpload({ ok: true, size: p.size, limitBytes: p.limit.bytes, limitLabel: p.limit.label });
}

export function onUploadError(channelId: string, code: unknown, reason: unknown) {
    const p = takePending(channelId);
    if (!p) return;
    const c = typeof code === "number" ? code : Number(code) || null;
    Native.logUpload({ ok: false, size: p.size, limitBytes: p.limit.bytes, limitLabel: p.limit.label, code: c, reason: reason == null ? null : String((reason as any)?.msg ?? reason) });
    if (c === 40005) showToast({ text: `Discord rejected ${formatBytes(p.size)} as too large. Logged; the next compress will aim lower.`, variant: "critical" });
}

// ---------- placeholder message ----------

function createPlaceholder(channelId: string, content: string) {
    const user = UserStore.getCurrentUser();
    const msg = createBotMessage({ channelId, content, embeds: [] });
    Object.assign(msg, {
        author: {
            id: user.id,
            username: user.username,
            discriminator: user.discriminator,
            avatar: user.avatar,
            global_name: (user as any).globalName ?? null,
            public_flags: (user as any).publicFlags ?? 0,
            bot: false,
        },
        flags: 0,
        type: 0,
        state: "SENDING",
    });
    MessageActions.receiveMessage(channelId, msg);
    return msg.id as string;
}

function removePlaceholder(job: BackgroundJob) {
    jobs.delete(job.messageId);
    FluxDispatcher.dispatch({ type: "MESSAGE_DELETE", channelId: job.channelId, id: job.messageId, mlDeleted: true });
    emit();
}

// ---------- running ----------

export interface BackgroundRequest {
    encode: EncodeOptions;
    channel: Channel;
    caption: string;
    /** send immediately, or add to the message box for the user to send */
    mode: "send" | "attach";
    outputName: string;
    originalSize: number;
    limit: UploadLimit;
}

export async function runInBackground(req: BackgroundRequest) {
    const messageId = createPlaceholder(req.channel.id, req.caption);
    const job: BackgroundJob = {
        messageId,
        channelId: req.channel.id,
        fileName: req.outputName,
        originalSize: req.originalSize,
        stage: "Starting",
        progress: 0,
        error: null,
        nativeJobId: null,
        cancelled: false,
    };
    jobs.set(messageId, job);
    emit();

    const inputId = req.encode.inputId;
    let outputId: string | null = null;
    try {
        job.nativeJobId = await Native.startEncode(req.encode);
        let status: JobStatus | null = null;
        while (!job.cancelled) {
            await new Promise(r => setTimeout(r, 400));
            status = await Native.getJob(job.nativeJobId);
            if (!status) throw new Error("Lost track of the compression job");
            update(job, { stage: status.stage, progress: status.progress });
            if (status.done) break;
        }
        if (job.cancelled) return;
        if (status!.error) throw new Error(status!.error);
        outputId = status!.outputId!;
        const size = status!.outputSize;

        update(job, { stage: "Preparing upload", progress: 1 });
        const parts: BlobPart[] = [];
        for (let off = 0; off < size; off += CHUNK) {
            if (job.cancelled) return;
            parts.push(await Native.readChunk(outputId, off, Math.min(CHUNK, size - off)) as Uint8Array<ArrayBuffer>);
        }
        const file = markOwnFile(new File(parts, req.outputName, { type: "video/mp4" }));

        removePlaceholder(job);
        pendingUploads.set(req.channel.id, { size, limit: req.limit, expires: Date.now() + 30 * 60 * 1000 });

        if (req.mode === "send") {
            // requireConfirm:false is Discord's instant-upload path: sends right away with its own
            // upload progress. vcCaption is read by this plugin's patch to fill in the message text.
            (UploadHandler.promptToUpload as any)([file], req.channel, DraftType.ChannelMessage, { requireConfirm: false, vcCaption: req.caption });
        } else {
            UploadHandler.promptToUpload([file], req.channel, DraftType.ChannelMessage);
            showToast({ text: `Compressed ${formatBytes(req.originalSize)} → ${formatBytes(size)}. Added to your message.`, variant: "success" });
        }
    } catch (e) {
        if (job.cancelled) return;
        const message = String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
        logger.error("Background compression failed", e);
        update(job, { error: message, stage: "Failed" });
    } finally {
        Native.deleteFile(inputId);
        if (outputId) Native.deleteFile(outputId);
    }
}

export function cancelJob(messageId: string) {
    const job = jobs.get(messageId);
    if (!job) return;
    job.cancelled = true;
    if (job.nativeJobId) Native.cancelJob(job.nativeJobId);
    removePlaceholder(job);
}

export function dismissJob(messageId: string) {
    const job = jobs.get(messageId);
    if (job) removePlaceholder(job);
}
