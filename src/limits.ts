/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Channel } from "@vencord/discord-types";
import { GuildStore, UserStore } from "@webpack/common";

import { settings } from "./settings";
import type { LogStats, ProbeResult } from "./types";

export const MB = 1024 * 1024;

export interface UploadLimit {
    bytes: number;
    label: string;
}

function tierFromAccount(): "free" | "basic" | "nitro" {
    // premiumType: 1 = Nitro Classic, 2 = Nitro, 3 = Nitro Basic
    switch (UserStore.getCurrentUser()?.premiumType) {
        case 2: return "nitro";
        case 1:
        case 3: return "basic";
        default: return "free";
    }
}

export function getUploadLimit(channel?: Channel | null): UploadLimit {
    const s = settings.store;
    const override = s.tierOverride as string;
    const tier = override === "auto" ? tierFromAccount() : override as ReturnType<typeof tierFromAccount>;
    const tierInfo = {
        free: { mb: s.freeLimitMb, name: "No Nitro" },
        basic: { mb: s.basicLimitMb, name: "Nitro Basic" },
        nitro: { mb: s.nitroLimitMb, name: "Nitro" },
    }[tier];

    let limit: UploadLimit = { bytes: tierInfo.mb * MB, label: `${tierInfo.name}${override === "auto" ? " (detected)" : ""}` };

    if (s.useServerBoosts && channel?.guild_id) {
        const guild = GuildStore.getGuild(channel.guild_id);
        const boostMb = ({ 2: 50, 3: 100 } as Record<number, number>)[guild?.premiumTier ?? 0];
        if (boostMb && boostMb * MB > limit.bytes) {
            limit = { bytes: boostMb * MB, label: `Server boost level ${guild!.premiumTier}` };
        }
    }
    return limit;
}

/**
 * If Discord has ever rejected an upload as too large below the configured limit,
 * the real line is lower than we think: stay under the smallest rejected size.
 */
export function effectiveLimit(limitBytes: number, stats: LogStats | null) {
    const line = stats?.uploadLines.find(l => l.limitBytes === limitBytes);
    if (line?.smallestRejected != null && line.smallestRejected <= limitBytes) {
        return { bytes: line.smallestRejected - 1, learned: true };
    }
    return { bytes: limitBytes, learned: false };
}

export const LIMIT_PRESETS = [10, 50, 1024];

export function formatBytes(b: number) {
    if (b >= 1024 * MB) return `${+(b / 1024 / MB).toFixed(2)} GB`;
    if (b >= MB) return `${+(b / MB).toFixed(1)} MB`;
    return `${Math.ceil(b / 1024)} KB`;
}

export function formatTime(sec: number, precise = true) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor(sec % 3600 / 60);
    const s = precise ? (sec % 60).toFixed(1).padStart(4, "0") : String(Math.floor(sec % 60)).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Accepts "75", "1:15", "1:15.5", "0:01:15" */
export function parseTime(str: string): number | null {
    const parts = str.trim().split(":");
    if (!parts.length || parts.length > 3 || parts.some(p => !/^\d+(\.\d+)?$/.test(p))) return null;
    return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

const MIN_VIDEO_KBPS = 80;

export interface EncodePlan {
    targetBytes: number;
    videoKbps: number;
    audioKbps: number;
    scaleShortSide: number | null;
    fps: number | null;
    feasible: boolean;
    /** longest clip that still fits at minimum quality */
    maxDuration: number;
    outputShortSide: number;
    cappedBySource: boolean;
    /** actual/predicted size ratio learned from past encodes; bitrate is divided by it */
    calibration: number;
    /** expected output size */
    estimateBytes: number;
}

/**
 * @param calibration median actual/predicted size ratio for this encoder (1 = no history).
 *   Clamped so one odd encode can't swing the plan far.
 */
/** "auto" = pick from the bitrate, "source" = keep the original, number = short side in px / frames per second */
export type Override = "auto" | "source" | number;

export const RESOLUTIONS = [2160, 1440, 1080, 900, 720, 540, 480, 360, 240];
export const FRAME_RATES = [60, 48, 30, 24];

export function planEncode(p: ProbeResult, duration: number, limitBytes: number, hasAudio: boolean, calibration = 1, resolution: Override = "auto", frameRate: Override = "auto"): EncodePlan {
    const cal = Math.min(1.3, Math.max(0.75, calibration || 1));
    const targetBytes = Math.floor(limitBytes * (1 - Math.max(0, settings.store.safetyMarginPercent) / 100));
    const budgetKbits = targetBytes * 8 * 0.98 / 1000; // ~2% mp4 container overhead
    const totalKbps = budgetKbits / Math.max(duration, 0.1) / cal;

    const audioKbps = !hasAudio ? 0
        : totalKbps >= 1500 ? 160
            : totalKbps >= 600 ? 128
                : totalKbps >= 250 ? 96
                    : 64;
    let videoKbps = Math.floor(totalKbps - audioKbps);

    // Never spend more bits than the source has; that just makes a bigger file with no quality gain
    const srcVideoKbps = (p.videoBitrate || Math.max(0, p.bitrate - audioKbps * 1000)) / 1000;
    const cappedBySource = srcVideoKbps > 0 && videoKbps > srcVideoKbps;
    if (cappedBySource) videoKbps = Math.ceil(srcVideoKbps);

    const shortSide = Math.min(p.width, p.height);
    let scaleShortSide: number | null = null;
    let fps: number | null = null;
    if (!cappedBySource) {
        const maxShort = videoKbps >= 6000 ? Infinity
            : videoKbps >= 3000 ? 1080
                : videoKbps >= 1500 ? 720
                    : videoKbps >= 700 ? 480
                        : 360;
        if (shortSide > maxShort) scaleShortSide = maxShort;
        if (videoKbps < 1500 && p.fps > 31) fps = 30;
    }
    // Manual choices win over the automatic ones; never upscale or raise the frame rate
    if (resolution === "source") scaleShortSide = null;
    else if (typeof resolution === "number") scaleShortSide = resolution < shortSide ? resolution : null;
    if (frameRate === "source") fps = null;
    else if (typeof frameRate === "number") fps = frameRate < p.fps - 0.5 ? frameRate : null;

    return {
        targetBytes,
        videoKbps,
        audioKbps,
        scaleShortSide,
        fps,
        feasible: videoKbps >= MIN_VIDEO_KBPS,
        maxDuration: budgetKbits / cal / (MIN_VIDEO_KBPS + (hasAudio ? 64 : 0)),
        outputShortSide: scaleShortSide ?? shortSide,
        cappedBySource,
        calibration: cal,
        estimateBytes: Math.min(targetBytes, (videoKbps + audioKbps) * 125 * duration * (cappedBySource ? 1 : cal)),
    };
}

const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|ts|mts|m2ts|3gp|mpg|mpeg)$/i;
export const isVideo = (f: File) => f.type.startsWith("video/") || VIDEO_EXT.test(f.name);

/** Files we produced ourselves; never intercepted, even if they're over the detected limit */
const ownFiles = new WeakSet<File>();
export const markOwnFile = (f: File) => { ownFiles.add(f); return f; };
export const isOwnFile = (f: File) => ownFiles.has(f);
