/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { classNameFactory } from "@utils/css";
import { OptionType, PluginNative } from "@utils/types";
import { useEffect, useState } from "@webpack/common";

import type { LogStats } from "./types";

const Native = VencordNative.pluginHelpers.VideoCompressor as PluginNative<typeof import("./native")>;
const cl = classNameFactory("vc-vidcomp-");

// Local copy so this file doesn't import limits.ts (which imports settings)
const fmt = (b: number) => b >= 1024 ** 3 ? `${+(b / 1024 ** 3).toFixed(2)} GB` : `${+(b / 1024 ** 2).toFixed(2)} MB`;

export const RESTART_HINT = "VideoCompressor was updated. Fully quit Discord (tray icon → Quit Discord) and reopen it; Ctrl+R isn't enough.";

function StatsPanel() {
    const [stats, setStats] = useState<LogStats | null>(null);
    const [error, setError] = useState<string | null>(null);
    const load = () => {
        // Ctrl+R reloads only the renderer; the main-process half stays old until Discord fully restarts
        if (typeof Native.getStats !== "function") return setError(RESTART_HINT);
        Native.getStats().then(setStats, e => setError(String(e?.message ?? e)));
    };
    useEffect(() => { load(); }, []);

    const encoderNames = { nvenc: "GPU (NVENC)", x264: "CPU (x264)" };
    return (
        <div className={cl("stats")}>
            <div className={cl("heading")}>Compression log</div>
            {error && <div className={cl("error")}>{error}</div>}
            {stats && <>
                <div className={cl("muted")}>
                    Every encode and every upload of a compressed video is logged, so the plugin learns how close each
                    encoder lands to its target and where Discord's real size limit is. {stats.encodes} encode{stats.encodes === 1 ? "" : "s"} logged.
                </div>
                {Object.entries(stats.encoders).map(([name, e]) => e && (
                    <div key={name} className={cl("stat-row")}>
                        <b>{encoderNames[name as keyof typeof encoderNames] ?? name}</b>
                        {`: output is ${(e.medianRatio * 100).toFixed(1)}% of the planned size (median of ${e.samples}), `}
                        {`fits on the first try ${Math.round(e.firstTryRate * 100)}% of the time.`}
                    </div>
                ))}
                {stats.uploadLines.map(l => (
                    <div key={l.limitBytes} className={cl("stat-row")}>
                        <b>{l.limitLabel} ({fmt(l.limitBytes)})</b>
                        {`: ${l.uploads} upload${l.uploads === 1 ? "" : "s"}. Largest accepted: ${l.largestAccepted != null ? fmt(l.largestAccepted) : "none yet"}. `}
                        {`Smallest rejected as too large: ${l.smallestRejected != null ? fmt(l.smallestRejected) : "none"}.`}
                    </div>
                ))}
                {!stats.uploadLines.length && <div className={cl("muted")}>No uploads logged yet.</div>}
                <div className={cl("muted")}>Log file: {stats.logPath}</div>
            </>}
            <div className={cl("row")}>
                <Button size="small" variant="secondary" onClick={() => Native.openLogFolder()}>Open log folder</Button>
                <Button size="small" variant="secondary" onClick={load}>Refresh</Button>
                <Button size="small" variant="dangerPrimary" onClick={() => Native.clearLog().then(load)}>Clear log</Button>
            </div>
        </div>
    );
}

export const settings = definePluginSettings({
    autoIntercept: {
        type: OptionType.BOOLEAN,
        description: "When you drop, paste or attach a video that's over your upload limit, open the compressor instead of Discord's \"file too large\" popup",
        default: true,
    },
    tierOverride: {
        type: OptionType.SELECT,
        description: "Which upload limit to aim for. Auto reads your Nitro tier from your account",
        options: [
            { label: "Auto-detect", value: "auto", default: true },
            { label: "No Nitro", value: "free" },
            { label: "Nitro Basic / Classic", value: "basic" },
            { label: "Nitro", value: "nitro" },
        ],
    },
    freeLimitMb: {
        type: OptionType.NUMBER,
        description: "Upload limit without Nitro, in MB",
        default: 10,
    },
    basicLimitMb: {
        type: OptionType.NUMBER,
        description: "Upload limit with Nitro Basic or Classic, in MB",
        default: 50,
    },
    nitroLimitMb: {
        type: OptionType.NUMBER,
        description: "Upload limit with Nitro, in MB (1024 = 1 GB)",
        default: 1024,
    },
    useServerBoosts: {
        type: OptionType.BOOLEAN,
        description: "Use a server's boosted limit when it's higher than yours (level 2: 50 MB, level 3: 100 MB)",
        default: true,
    },
    safetyMarginPercent: {
        type: OptionType.NUMBER,
        description: "Aim this many percent under the limit, so the file never ends up a few bytes too big",
        default: 3,
    },
    encoder: {
        type: OptionType.SELECT,
        description: "Video encoder. Auto uses your NVIDIA GPU (fast) when available, otherwise the CPU (slower, slightly better quality per MB)",
        options: [
            { label: "Auto", value: "auto", default: true },
            { label: "NVIDIA GPU (NVENC)", value: "nvenc" },
            { label: "CPU (x264, 2-pass)", value: "x264" },
        ],
    },
    ffmpegPath: {
        type: OptionType.STRING,
        description: "Folder containing ffmpeg.exe and ffprobe.exe. Leave empty to find it automatically",
        default: "",
    },
    stats: {
        type: OptionType.COMPONENT,
        component: () => <StatsPanel />,
    },
});
