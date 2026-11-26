/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Shared between native.ts (main process) and the renderer. Keep this file import-free.

export interface AudioTrack {
    /** index among the file's audio streams (ffmpeg's 0:a:N) */
    index: number;
    codec: string;
    channels: number;
    layout: string;
    title: string;
    language: string;
    isDefault: boolean;
}

export interface ProbeResult {
    duration: number;
    width: number;
    height: number;
    fps: number;
    /** total bits/s, 0 if unknown */
    bitrate: number;
    /** video stream bits/s, 0 if unknown */
    videoBitrate: number;
    videoCodec: string;
    audioTracks: AudioTrack[];
}

export interface TrackMix {
    index: number;
    /** 1 = unchanged */
    volume: number;
}

export type EncoderName = "nvenc" | "x264";
export type EncoderPref = "auto" | EncoderName;

export interface EncodeOptions {
    inputId: string;
    start: number;
    duration: number;
    targetBytes: number;
    videoKbps: number;
    audioKbps: number;
    /** empty = no audio */
    audioTracks: TrackMix[];
    scaleShortSide: number | null;
    fps: number | null;
    portrait: boolean;
    encoder: EncoderPref;
    /** bitrate was capped at the source's, so the output is expected to undershoot (excluded from calibration) */
    cappedBySource: boolean;
    /** calibration factor the plan applied, logged so its effect can be judged */
    calibration: number;
    ffmpegPath: string;
}

export interface JobStatus {
    progress: number;
    stage: string;
    done: boolean;
    cancelled: boolean;
    error: string | null;
    outputId: string | null;
    outputSize: number;
    encoder: EncoderName | null;
    attempts: number;
}

export interface EncodeLogEntry {
    kind: "encode";
    time: number;
    encoder: EncoderName;
    attempt: number;
    duration: number;
    outputShortSide: number | null;
    fps: number | null;
    videoKbps: number;
    audioKbps: number;
    audioTracks: number;
    targetBytes: number;
    /** (video+audio kbps) × duration, before container overhead */
    predictedBytes: number;
    actualBytes: number;
    /** actual / predicted */
    ratio: number;
    fits: boolean;
    cappedBySource: boolean;
    calibration: number;
    seconds: number;
}

export interface UploadLogEntry {
    kind: "upload";
    time: number;
    ok: boolean;
    size: number;
    /** the limit the plugin believed applied */
    limitBytes: number;
    limitLabel: string;
    /** Discord error code on failure (40005 = too large) */
    code?: number | null;
    reason?: string | null;
}

export type LogEntry = EncodeLogEntry | UploadLogEntry;

export interface EncoderStats {
    samples: number;
    /** median actual/predicted on first attempts */
    medianRatio: number;
    /** share of encodes that fit on the first attempt */
    firstTryRate: number;
}

export interface UploadLine {
    limitBytes: number;
    limitLabel: string;
    largestAccepted: number | null;
    smallestRejected: number | null;
    uploads: number;
}

export interface LogStats {
    logPath: string;
    encodes: number;
    encoders: Partial<Record<EncoderName, EncoderStats>>;
    uploadLines: UploadLine[];
}
