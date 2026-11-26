/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Runs in Discord's main process. Every media file this module touches lives in its own
// temp folder and is referenced by an opaque id, so the renderer can never point it at
// arbitrary paths on disk.

import { ChildProcess, execFile, spawn } from "child_process";
import { randomBytes } from "crypto";
import { app, IpcMainInvokeEvent, shell } from "electron";
import { existsSync } from "fs";
import { appendFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { delimiter, dirname, join } from "path";

import type { EncodeLogEntry, EncodeOptions, EncoderName, EncoderPref, EncoderStats, JobStatus, LogEntry, LogStats, ProbeResult, TrackMix, UploadLine, UploadLogEntry } from "./types";

const WORK_DIR = join(tmpdir(), "vencord-videocompressor");
const LOG_DIR = join(app.getPath("userData"), "VideoCompressor");
const LOG_FILE = join(LOG_DIR, "log.jsonl");

const files = new Map<string, string>();

interface Job extends JobStatus {
    proc: ChildProcess | null;
}
const jobs = new Map<string, Job>();

const newId = () => randomBytes(12).toString("hex");

function pathFor(id: string) {
    const p = files.get(id);
    if (!p) throw new Error("Unknown file id");
    return p;
}

// ---------- ffmpeg discovery ----------

const exe = (name: string) => process.platform === "win32" ? `${name}.exe` : name;

function findTool(name: "ffmpeg" | "ffprobe", configuredPath: string) {
    const candidates: string[] = [];
    if (configuredPath) {
        // Accept either the folder or the ffmpeg.exe path itself
        const dir = /\.exe$|ffmpeg$|ffprobe$/i.test(configuredPath) ? dirname(configuredPath) : configuredPath;
        candidates.push(join(dir, exe(name)));
    }
    if (process.platform === "win32") {
        const local = process.env.LOCALAPPDATA ?? "";
        candidates.push(
            join(local, "Microsoft", "WinGet", "Links", exe(name)),
            join(process.env.USERPROFILE ?? "", "scoop", "shims", exe(name)),
            join(process.env.ProgramData ?? "C:\\ProgramData", "chocolatey", "bin", exe(name)),
            join(process.env.ProgramFiles ?? "C:\\Program Files", "ffmpeg", "bin", exe(name)),
            join("C:\\ffmpeg", "bin", exe(name)),
        );
    }
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
        if (dir) candidates.push(join(dir, exe(name)));
    }
    if (process.platform !== "win32") candidates.push(`/usr/bin/${name}`, `/usr/local/bin/${name}`, `/opt/homebrew/bin/${name}`);

    return candidates.find(c => existsSync(c)) ?? null;
}

function tools(configuredPath: string) {
    const ffmpeg = findTool("ffmpeg", configuredPath);
    const ffprobe = findTool("ffprobe", configuredPath);
    if (!ffmpeg || !ffprobe) throw new Error("ffmpeg/ffprobe not found. Set its folder in the VideoCompressor plugin settings.");
    return { ffmpeg, ffprobe };
}

export function checkFfmpeg(_: IpcMainInvokeEvent, configuredPath: string) {
    try {
        return { ok: true, path: tools(configuredPath).ffmpeg, error: null };
    } catch (e) {
        return { ok: false, path: null, error: String((e as Error).message) };
    }
}

let nvencAvailable: boolean | null = null;
function hasNvenc(ffmpeg: string): Promise<boolean> {
    if (nvencAvailable != null) return Promise.resolve(nvencAvailable);
    return new Promise(resolve => {
        execFile(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=black:s=256x256:d=0.2", "-c:v", "h264_nvenc", "-f", "null", "-"],
            { timeout: 15000, windowsHide: true },
            err => resolve(nvencAvailable = !err));
    });
}

async function pickEncoder(pref: EncoderPref, ffmpeg: string): Promise<EncoderName> {
    if (pref !== "auto") return pref;
    return await hasNvenc(ffmpeg) ? "nvenc" : "x264";
}

export async function resolveEncoder(_: IpcMainInvokeEvent, pref: EncoderPref, configuredPath: string) {
    return pickEncoder(pref, tools(configuredPath).ffmpeg);
}

// ---------- temp file handling ----------

export async function cleanupStale() {
    await mkdir(WORK_DIR, { recursive: true });
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of await readdir(WORK_DIR)) {
        const p = join(WORK_DIR, name);
        try {
            if ((await stat(p)).mtimeMs < cutoff) await rm(p, { force: true });
        } catch { }
    }
}

export async function createInput(_: IpcMainInvokeEvent, ext: string) {
    await mkdir(WORK_DIR, { recursive: true });
    const safeExt = /^[a-z0-9]{1,8}$/i.test(ext) ? ext : "bin";
    const id = newId();
    const p = join(WORK_DIR, `${id}-in.${safeExt}`);
    await writeFile(p, new Uint8Array(0));
    files.set(id, p);
    return id;
}

export async function appendInput(_: IpcMainInvokeEvent, id: string, chunk: Uint8Array) {
    await appendFile(pathFor(id), chunk);
}

export async function readChunk(_: IpcMainInvokeEvent, id: string, offset: number, length: number) {
    const fh = await open(pathFor(id), "r");
    try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, offset);
        return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
    } finally {
        await fh.close();
    }
}

export async function deleteFile(_: IpcMainInvokeEvent, id: string) {
    const p = files.get(id);
    files.delete(id);
    if (p) await rm(p, { force: true }).catch(() => { });
}

// ---------- probing ----------

export function probe(_: IpcMainInvokeEvent, id: string, configuredPath: string): Promise<ProbeResult> {
    const { ffprobe } = tools(configuredPath);
    return new Promise((resolve, reject) => {
        execFile(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", pathFor(id)],
            { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
            (err, stdout) => {
                if (err) return reject(new Error("ffprobe could not read this file. Is it a video?"));
                try {
                    const info = JSON.parse(stdout);
                    const v = info.streams.find((s: any) => s.codec_type === "video" && !s.disposition?.attached_pic);
                    if (!v) return reject(new Error("No video stream found in this file."));
                    const [n, d] = String(v.avg_frame_rate || v.r_frame_rate || "30/1").split("/").map(Number);
                    // Phone videos store rotation as metadata; swap so width/height match what you see
                    const rot = Math.abs(Number(v.tags?.rotate ?? v.side_data_list?.find((s: any) => s.rotation != null)?.rotation ?? 0));
                    const swap = rot === 90 || rot === 270;
                    const audio = info.streams.filter((s: any) => s.codec_type === "audio");
                    resolve({
                        duration: Number(info.format.duration) || Number(v.duration) || 0,
                        width: swap ? v.height : v.width,
                        height: swap ? v.width : v.height,
                        fps: d ? n / d : 30,
                        bitrate: Number(info.format.bit_rate) || 0,
                        videoBitrate: Number(v.bit_rate) || 0,
                        videoCodec: String(v.codec_name ?? ""),
                        audioTracks: audio.map((s: any, i: number) => ({
                            index: i,
                            codec: String(s.codec_name ?? ""),
                            channels: Number(s.channels) || 0,
                            layout: String(s.channel_layout ?? ""),
                            title: String(s.tags?.title ?? s.tags?.handler_name ?? "").replace(/^.*handler.*$/i, "").trim(),
                            language: String(s.tags?.language ?? "").replace(/^und$/, ""),
                            isDefault: !!s.disposition?.default,
                        })),
                    });
                } catch (e) {
                    reject(e);
                }
            });
    });
}

// ---------- thumbnails & audio preview ----------

function grabFrame(ffmpeg: string, input: string, time: number, height: number): Promise<string | null> {
    return new Promise(resolve => {
        execFile(ffmpeg, [
            "-hide_banner", "-loglevel", "error", "-ss", time.toFixed(3), "-i", input,
            "-frames:v", "1", "-vf", `scale=-2:${height}`, "-q:v", "6", "-f", "image2pipe", "-c:v", "mjpeg", "-"
        ], { encoding: "buffer", maxBuffer: 4 * 1024 * 1024, windowsHide: true, timeout: 20000 },
        (err, stdout) => resolve(err || !stdout.length ? null : `data:image/jpeg;base64,${stdout.toString("base64")}`));
    });
}

/** Evenly spaced frames for the trim timeline, as data URLs (null where a frame failed). */
export async function thumbnails(_: IpcMainInvokeEvent, id: string, duration: number, count: number, height: number, configuredPath: string) {
    const { ffmpeg } = tools(configuredPath);
    const input = pathFor(id);
    const times = Array.from({ length: count }, (_, i) => (i + 0.5) * duration / count);
    const out: (string | null)[] = new Array(count).fill(null);
    let next = 0;
    // 4 at a time: fast keyframe seeks, without hammering the disk
    await Promise.all(Array.from({ length: 4 }, async () => {
        while (next < count) {
            const i = next++;
            out[i] = await grabFrame(ffmpeg, input, times[i], height);
        }
    }));
    return out;
}

function audioGraph(tracks: TrackMix[]) {
    if (!tracks.length) return null;
    const parts = tracks.map((t, i) => `[0:a:${t.index}]volume=${t.volume.toFixed(3)},aformat=channel_layouts=stereo[a${i}]`);
    if (tracks.length === 1) return parts[0].replace(/\[a0\]$/, "[aout]");
    return `${parts.join(";")};${tracks.map((_, i) => `[a${i}]`).join("")}amix=inputs=${tracks.length}:normalize=0:duration=longest[aout]`;
}

/** Renders the chosen audio mix for the whole file, so the trim preview can play it in sync. */
export function renderAudioPreview(_: IpcMainInvokeEvent, id: string, tracks: TrackMix[], configuredPath: string) {
    const { ffmpeg } = tools(configuredPath);
    const graph = audioGraph(tracks);
    if (!graph) throw new Error("No audio tracks selected");
    const outId = newId();
    const out = join(WORK_DIR, `${outId}-preview.ogg`);
    files.set(outId, out);
    return new Promise<{ id: string; size: number; }>((resolve, reject) => {
        execFile(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", pathFor(id), "-filter_complex", graph, "-map", "[aout]", "-vn", "-c:a", "libopus", "-b:a", "96k", out],
            { windowsHide: true, maxBuffer: 1024 * 1024 },
            async (err, _o, stderr) => {
                if (err) {
                    files.delete(outId);
                    return reject(new Error(`Couldn't render the audio preview: ${String(stderr).trim().split("\n").pop()}`));
                }
                resolve({ id: outId, size: (await stat(out)).size });
            });
    });
}

// ---------- logging ----------

async function appendLog(entry: LogEntry) {
    try {
        await mkdir(LOG_DIR, { recursive: true });
        await appendFile(LOG_FILE, JSON.stringify(entry) + "\n");
    } catch { }
}

async function readLog(): Promise<LogEntry[]> {
    try {
        return (await readFile(LOG_FILE, "utf8")).split("\n").filter(Boolean).flatMap(l => {
            try { return [JSON.parse(l)]; } catch { return []; }
        });
    } catch {
        return [];
    }
}

export async function logUpload(_: IpcMainInvokeEvent, entry: Omit<UploadLogEntry, "kind" | "time">) {
    await appendLog({ kind: "upload", time: Date.now(), ...entry });
}

const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2 : 1;
};

export async function getStats(): Promise<LogStats> {
    const log = await readLog();
    const encodes = log.filter((e): e is EncodeLogEntry => e.kind === "encode");
    const encoders: LogStats["encoders"] = {};
    for (const name of ["nvenc", "x264"] as EncoderName[]) {
        // Calibrate on the 20 most recent first attempts that weren't capped by the source bitrate
        const first = encodes.filter(e => e.encoder === name && e.attempt === 0 && !e.cappedBySource).slice(-20);
        if (!first.length) continue;
        const stats: EncoderStats = {
            samples: first.length,
            medianRatio: median(first.map(e => e.ratio)),
            firstTryRate: first.filter(e => e.fits).length / first.length,
        };
        encoders[name] = stats;
    }

    const lines = new Map<number, UploadLine>();
    for (const u of log.filter((e): e is UploadLogEntry => e.kind === "upload")) {
        const line = lines.get(u.limitBytes) ?? { limitBytes: u.limitBytes, limitLabel: u.limitLabel, largestAccepted: null, smallestRejected: null, uploads: 0 };
        line.uploads++;
        line.limitLabel = u.limitLabel;
        if (u.ok) line.largestAccepted = Math.max(line.largestAccepted ?? 0, u.size);
        else if (u.code === 40005) line.smallestRejected = Math.min(line.smallestRejected ?? Infinity, u.size);
        lines.set(u.limitBytes, line);
    }

    return { logPath: LOG_FILE, encodes: encodes.length, encoders, uploadLines: [...lines.values()] };
}

export async function openLogFolder() {
    await mkdir(LOG_DIR, { recursive: true });
    await shell.openPath(LOG_DIR);
}

export async function clearLog() {
    await rm(LOG_FILE, { force: true });
}

// ---------- encoding ----------

function runFfmpeg(job: Job, ffmpeg: string, args: string[], duration: number, from: number, span: number) {
    return new Promise<void>((resolve, reject) => {
        const proc = spawn(ffmpeg, ["-hide_banner", "-y", "-nostats", "-progress", "pipe:1", ...args], { windowsHide: true });
        job.proc = proc;
        let stderr = "";
        proc.stdout.on("data", (d: Buffer) => {
            const m = /out_time_us=(\d+)/g;
            let last: RegExpExecArray | null = null, cur: RegExpExecArray | null;
            const s = d.toString();
            while ((cur = m.exec(s))) last = cur;
            if (last && duration > 0) {
                const frac = Math.min(1, Number(last[1]) / 1e6 / duration);
                job.progress = from + frac * span;
            }
        });
        proc.stderr.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000); });
        proc.on("error", reject);
        proc.on("close", code => {
            job.proc = null;
            if (job.cancelled) reject(new Error("Cancelled"));
            else if (code === 0) resolve();
            else reject(new Error(`ffmpeg failed (code ${code}): ${stderr.trim().split("\n").slice(-3).join(" | ")}`));
        });
    });
}

async function encode(job: Job, o: EncodeOptions) {
    const { ffmpeg } = tools(o.ffmpegPath);
    const input = pathFor(o.inputId);
    const encoder = await pickEncoder(o.encoder, ffmpeg);
    job.encoder = encoder;

    const outId = newId();
    const out = join(WORK_DIR, `${outId}-out.mp4`);
    files.set(outId, out);

    const v: string[] = [];
    if (o.scaleShortSide) v.push(o.portrait ? `scale=${o.scaleShortSide}:-2` : `scale=-2:${o.scaleShortSide}`);
    if (o.fps) v.push(`fps=${o.fps}`);
    v.push("format=yuv420p");
    const audio = o.audioKbps > 0 ? audioGraph(o.audioTracks) : null;
    const videoGraph = `[0:v:0]${v.join(",")}[vout]`;
    const graph = videoGraph + (audio ? `;${audio}` : "");

    const inputArgs = ["-ss", o.start.toFixed(3), "-i", input, "-t", o.duration.toFixed(3)];
    const common = ["-filter_complex", graph, "-map", "[vout]", "-map_metadata", "-1"];
    // x264 pass 1 writes no audio, and ffmpeg rejects a graph with an unconnected [aout]
    const videoOnly = ["-filter_complex", videoGraph, "-map", "[vout]", "-map_metadata", "-1"];
    const audioOut = audio ? ["-map", "[aout]", "-c:a", "aac", "-b:a", `${o.audioKbps}k`, "-ac", "2"] : ["-an"];

    let videoKbps = o.videoKbps;
    // Up to 3 attempts: if the result overshoots the limit, scale the bitrate down and retry
    for (let attempt = 0; attempt < 3; attempt++) {
        job.attempts = attempt + 1;
        const t0 = Date.now();
        const rate = ["-b:v", `${videoKbps}k`, "-maxrate", `${Math.round(videoKbps * 1.5)}k`, "-bufsize", `${videoKbps * 2}k`];
        const label = attempt ? ` (retry ${attempt})` : "";

        if (encoder === "nvenc") {
            job.stage = `Compressing on GPU${label}`;
            await runFfmpeg(job, ffmpeg, [
                ...inputArgs, ...common,
                "-c:v", "h264_nvenc", "-preset", "p6", "-tune", "hq", "-rc", "vbr", "-multipass", "fullres", ...rate,
                ...audioOut, "-movflags", "+faststart", out
            ], o.duration, 0, 1);
        } else {
            const passlog = join(WORK_DIR, `${outId}-pass`);
            job.stage = `Analyzing (pass 1 of 2)${label}`;
            await runFfmpeg(job, ffmpeg, [
                ...inputArgs, ...videoOnly,
                "-c:v", "libx264", "-preset", "medium", ...rate, "-pass", "1", "-passlogfile", passlog,
                "-an", "-f", "mp4", process.platform === "win32" ? "NUL" : "/dev/null"
            ], o.duration, 0, 0.5);
            job.stage = `Compressing (pass 2 of 2)${label}`;
            await runFfmpeg(job, ffmpeg, [
                ...inputArgs, ...common,
                "-c:v", "libx264", "-preset", "medium", ...rate, "-pass", "2", "-passlogfile", passlog,
                ...audioOut, "-movflags", "+faststart", out
            ], o.duration, 0.5, 0.5);
            for (const f of await readdir(WORK_DIR)) {
                if (f.startsWith(`${outId}-pass`)) await rm(join(WORK_DIR, f), { force: true }).catch(() => { });
            }
        }

        const size = (await stat(out)).size;
        const predictedBytes = (videoKbps + (audio ? o.audioKbps : 0)) * 125 * o.duration;
        await appendLog({
            kind: "encode",
            time: Date.now(),
            encoder,
            attempt,
            duration: o.duration,
            outputShortSide: o.scaleShortSide,
            fps: o.fps,
            videoKbps,
            audioKbps: audio ? o.audioKbps : 0,
            audioTracks: o.audioTracks.length,
            targetBytes: o.targetBytes,
            predictedBytes: Math.round(predictedBytes),
            actualBytes: size,
            ratio: +(size / predictedBytes).toFixed(4),
            fits: size <= o.targetBytes,
            cappedBySource: o.cappedBySource,
            calibration: o.calibration,
            seconds: +((Date.now() - t0) / 1000).toFixed(1),
        });

        job.outputSize = size;
        if (size <= o.targetBytes) {
            job.outputId = outId;
            return;
        }
        videoKbps = Math.max(50, Math.floor(videoKbps * (o.targetBytes / size) * 0.92));
        job.progress = 0;
    }
    files.delete(outId);
    await rm(out, { force: true }).catch(() => { });
    throw new Error("Couldn't get the video under the size limit. Try trimming it shorter.");
}

export function startEncode(_: IpcMainInvokeEvent, opts: EncodeOptions) {
    const id = newId();
    const job: Job = { proc: null, progress: 0, stage: "Starting", done: false, cancelled: false, error: null, outputId: null, outputSize: 0, encoder: null, attempts: 0 };
    jobs.set(id, job);
    encode(job, opts)
        .catch(e => { job.error = String((e as Error).message ?? e); })
        .finally(() => { job.done = true; });
    return id;
}

export function getJob(_: IpcMainInvokeEvent, id: string): JobStatus | null {
    const j = jobs.get(id);
    if (!j) return null;
    const { proc, ...rest } = j;
    if (j.done) jobs.delete(id);
    return rest;
}

export function cancelJob(_: IpcMainInvokeEvent, id: string) {
    const j = jobs.get(id);
    if (!j) return;
    j.cancelled = true;
    j.proc?.kill();
}
