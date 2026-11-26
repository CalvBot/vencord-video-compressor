/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { PluginNative } from "@utils/types";
import { Channel, RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, useEffect, useMemo, useRef, useState } from "@webpack/common";

import { runInBackground } from "./jobs";
import { effectiveLimit, formatBytes, formatTime, FRAME_RATES, getUploadLimit, LIMIT_PRESETS, MB, Override, planEncode, RESOLUTIONS } from "./limits";
import { RESTART_HINT, settings } from "./settings";
import { Timeline } from "./Timeline";
import type { AudioTrack, EncoderName, EncoderPref, LogStats, ProbeResult, TrackMix } from "./types";

const Native = VencordNative.pluginHelpers.VideoCompressor as PluginNative<typeof import("./native")>;
const cl = classNameFactory("vc-vidcomp-");
const CHUNK = 8 * MB;

type Phase =
    | { kind: "loading"; text: string; progress: number; }
    | { kind: "ready"; }
    | { kind: "error"; message: string; };

type TrackState = Record<number, { on: boolean; volume: number; }>;

function errMsg(e: unknown) {
    if (e instanceof TypeError && /is not a function/.test(e.message)) return RESTART_HINT;
    // Electron prefixes errors thrown across IPC; strip that noise
    return String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function trackLabel(t: AudioTrack) {
    // Container tool names ("SoundHandler", "Mainconcept MP4 Sound Media Handler") aren't real titles
    if (/handler/i.test(t.title)) t = { ...t, title: "" };
    const layout = t.layout || (t.channels === 1 ? "mono" : t.channels === 2 ? "stereo" : `${t.channels} ch`);
    return [`Track ${t.index + 1}`, t.title, layout, t.language].filter(Boolean).join(" · ");
}

function AudioTracks({ tracks, state, setState, disabled }: { tracks: AudioTrack[]; state: TrackState; setState(s: TrackState): void; disabled: boolean; }) {
    return (
        <div className={cl("tracks")}>
            {tracks.map(t => {
                const s = state[t.index];
                return (
                    <div key={t.index} className={cl("track-row", !s.on && "track-off")}>
                        <label className={cl("check")}>
                            <input
                                type="checkbox"
                                checked={s.on}
                                disabled={disabled}
                                onChange={e => setState({ ...state, [t.index]: { ...s, on: e.currentTarget.checked } })}
                            />
                            {trackLabel(t)}
                        </label>
                        <input
                            type="range"
                            className={cl("volume")}
                            min={0}
                            max={200}
                            step={5}
                            value={Math.round(s.volume * 100)}
                            disabled={disabled || !s.on}
                            onChange={e => setState({ ...state, [t.index]: { ...s, volume: Number(e.currentTarget.value) / 100 } })}
                        />
                        <span className={cl("volume-label")}>{Math.round(s.volume * 100)}%</span>
                    </div>
                );
            })}
        </div>
    );
}

function CompressModal({ modalProps, file, channel }: { modalProps: RenderModalProps; file: File; channel: Channel; }) {
    const [phase, setPhase] = useState<Phase>({ kind: "loading", text: "Reading file", progress: 0 });
    const [probe, setProbe] = useState<ProbeResult | null>(null);
    const [thumbs, setThumbs] = useState<(string | null)[] | null>(null);
    const [start, setStart] = useState(0);
    const [end, setEnd] = useState(0);
    const detected = useMemo(() => getUploadLimit(channel), [channel]);
    const [targetMb, setTargetMb] = useState(detected.bytes / MB);
    const [customMb, setCustomMb] = useState(String(Math.round(detected.bytes / MB)));
    const [tracks, setTracks] = useState<TrackState>({});
    const [muted, setMuted] = useState(false);
    const [caption, setCaption] = useState("");
    const [resolution, setResolution] = useState<Override>("source");
    const [frameRate, setFrameRate] = useState<Override>("source");
    const [showOptions, setShowOptions] = useState(false);
    const [stats, setStats] = useState<LogStats | null>(null);
    const [encoder, setEncoder] = useState<EncoderName | null>(null);
    const [videoError, setVideoError] = useState(false);
    const [preview, setPreview] = useState<{ key: string; url: string; id: string; } | { key: string; rendering: true; } | null>(null);

    const videoRef = useRef<HTMLVideoElement>(null);
    const audioRef = useRef<HTMLAudioElement>(null);
    const inputId = useRef<string | null>(null);
    const handedOff = useRef(false);
    const alive = useRef(true);
    const previewIds = useRef<string[]>([]);
    const blobUrl = useMemo(() => URL.createObjectURL(file), [file]);

    // Copy the file into the compressor's temp folder, probe it, then fetch thumbnails
    useEffect(() => {
        alive.current = true;
        const ffmpegPath = settings.store.ffmpegPath;
        (async () => {
            try {
                const check = await Native.checkFfmpeg(ffmpegPath);
                if (!check.ok) throw new Error(check.error ?? "ffmpeg not found");
                Native.getStats().then(s => alive.current && setStats(s)).catch(() => { });
                Native.resolveEncoder(settings.store.encoder as EncoderPref, ffmpegPath).then(e => alive.current && setEncoder(e)).catch(() => { });

                const ext = file.name.includes(".") ? file.name.split(".").pop()! : "mp4";
                const id = await Native.createInput(ext);
                inputId.current = id;
                for (let off = 0; off < file.size; off += CHUNK) {
                    if (!alive.current) return;
                    const buf = await file.slice(off, off + CHUNK).arrayBuffer();
                    await Native.appendInput(id, new Uint8Array(buf));
                    setPhase({ kind: "loading", text: "Reading file", progress: Math.min(1, (off + CHUNK) / file.size) });
                }
                setPhase({ kind: "loading", text: "Analyzing video", progress: 1 });
                const p = await Native.probe(id, ffmpegPath);
                if (!alive.current) return;
                setProbe(p);
                setEnd(p.duration);
                const def = p.audioTracks.find(t => t.isDefault) ?? p.audioTracks[0];
                setTracks(Object.fromEntries(p.audioTracks.map(t => [t.index, { on: t === def, volume: 1 }])));
                setPhase({ kind: "ready" });

                const t = await Native.thumbnails(id, p.duration, 16, 54, ffmpegPath);
                if (alive.current) setThumbs(t);
            } catch (e) {
                if (alive.current) setPhase({ kind: "error", message: errMsg(e) });
            }
        })();

        return () => {
            alive.current = false;
            URL.revokeObjectURL(blobUrl);
            previewIds.current.forEach(id => Native.deleteFile(id));
            // Once handed to a background job, the job owns (and deletes) the input
            if (inputId.current && !handedOff.current) Native.deleteFile(inputId.current);
        };
    }, []);

    const mix: TrackMix[] = muted ? [] : probe?.audioTracks.filter(t => tracks[t.index]?.on).map(t => ({ index: t.index, volume: tracks[t.index].volume })) ?? [];
    const mixKey = JSON.stringify(mix);
    // Only the first track plays in the <video>; anything else needs a rendered preview
    const needsPreview = mix.length > 1 || (mix.length === 1 && (mix[0].index !== 0 || mix[0].volume !== 1));
    const previewReady = preview && "url" in preview && preview.key === mixKey ? preview : null;

    // Play the rendered mix in sync with the (muted) video
    useEffect(() => {
        const v = videoRef.current, a = audioRef.current;
        if (!v) return;
        v.muted = !!previewReady || mix.length === 0;
        if (!previewReady || !a) return;
        const sync = () => { if (Math.abs(a.currentTime - v.currentTime) > 0.15) a.currentTime = v.currentTime; };
        const onPlay = () => { sync(); a.play().catch(() => { }); };
        const onPause = () => a.pause();
        const onRate = () => { a.playbackRate = v.playbackRate; };
        v.addEventListener("play", onPlay);
        v.addEventListener("pause", onPause);
        v.addEventListener("seeked", sync);
        v.addEventListener("timeupdate", sync);
        v.addEventListener("ratechange", onRate);
        if (!v.paused) onPlay();
        return () => {
            a.pause();
            v.removeEventListener("play", onPlay);
            v.removeEventListener("pause", onPause);
            v.removeEventListener("seeked", sync);
            v.removeEventListener("timeupdate", sync);
            v.removeEventListener("ratechange", onRate);
        };
    }, [previewReady?.url, mix.length]);

    async function renderPreview() {
        if (!inputId.current || !mix.length) return;
        const key = mixKey;
        setPreview({ key, rendering: true });
        try {
            const { id, size } = await Native.renderAudioPreview(inputId.current, mix, settings.store.ffmpegPath);
            previewIds.current.push(id);
            const parts: BlobPart[] = [];
            for (let off = 0; off < size; off += CHUNK) parts.push(await Native.readChunk(id, off, Math.min(CHUNK, size - off)) as Uint8Array<ArrayBuffer>);
            if (!alive.current) return;
            setPreview({ key, id, url: URL.createObjectURL(new Blob(parts, { type: "audio/ogg" })) });
        } catch (e) {
            if (alive.current) { setPreview(null); setPhase({ kind: "error", message: errMsg(e) }); }
        }
    }

    const duration = Math.max(0, end - start);
    const selectedBytes = targetMb * MB;
    const limit = effectiveLimit(selectedBytes, stats);
    const calibration = (encoder && stats?.encoders[encoder]?.medianRatio) || 1;
    const plan = probe && duration > 0 ? planEncode(probe, duration, limit.bytes, mix.length > 0, calibration, resolution, frameRate) : null;
    const srcShort = probe ? Math.min(probe.width, probe.height) : 0;
    const srcFps = probe ? Math.round(probe.fps) : 0;
    const trimmed = probe != null && (start > 0.05 || end < probe.duration - 0.05);
    const canGo = phase.kind === "ready" && !!plan?.feasible && !!inputId.current;

    function go(mode: "send" | "attach") {
        if (!canGo || !probe || !plan) return;
        handedOff.current = true;
        runInBackground({
            mode,
            channel,
            caption: mode === "send" ? caption.trim() : "",
            outputName: file.name.replace(/\.[^.]+$/, "") + (trimmed ? "-trimmed" : "") + "-compressed.mp4",
            originalSize: file.size,
            limit: { bytes: selectedBytes, label: selectedBytes === detected.bytes ? detected.label : `Custom ${formatBytes(selectedBytes)}` },
            encode: {
                inputId: inputId.current!,
                start,
                duration,
                targetBytes: plan.targetBytes,
                videoKbps: plan.videoKbps,
                audioKbps: plan.audioKbps,
                audioTracks: mix,
                scaleShortSide: plan.scaleShortSide,
                fps: plan.fps,
                portrait: probe.height > probe.width,
                encoder: settings.store.encoder as EncoderPref,
                cappedBySource: plan.cappedBySource,
                calibration: plan.calibration,
                ffmpegPath: settings.store.ffmpegPath,
            },
        });
        modalProps.onClose();
    }

    const sizeChoices = [...new Set([...LIMIT_PRESETS, detected.bytes / MB])].sort((x, y) => x - y);
    const isCustom = !sizeChoices.includes(targetMb);
    const audioLabel = mix.length === 0 ? "no audio" : mix.length > 1 ? `${mix.length} audio tracks mixed` : null;

    return (
        <Modal
            {...modalProps}
            size="lg"
            title="Compress video"
            subtitle={[file.name, formatBytes(file.size), probe && `${srcShort}p${srcFps}`, probe && formatTime(probe.duration, false)].filter(Boolean).join(" · ")}
            actions={[
                { text: "Add to message", variant: "secondary", disabled: !canGo, onClick: () => go("attach") },
                { text: "Send", variant: "primary", disabled: !canGo, onClick: () => go("send") },
            ]}
        >
            <div className={cl("body")}>
                <video
                    ref={videoRef}
                    className={cl("preview")}
                    src={blobUrl}
                    preload="auto"
                    onClick={() => { const v = videoRef.current; if (v) v.paused ? v.play().catch(() => { }) : v.pause(); }}
                    onError={() => setVideoError(true)}
                />
                {previewReady && <audio ref={audioRef} src={previewReady.url} preload="auto" />}
                {videoError && <div className={cl("muted")}>Discord can't play this format ({probe?.videoCodec || "unknown codec"}), so there's no live preview. Compression still works.</div>}

                {phase.kind === "loading" && <Progress label={`${phase.text}…`} value={phase.progress} />}
                {phase.kind === "error" && <div className={cl("error")}>{phase.message}</div>}

                {probe && (
                    <>
                        <Timeline
                            duration={probe.duration}
                            fps={probe.fps}
                            start={start}
                            end={end}
                            onChange={(s, e) => { setStart(s); setEnd(e); }}
                            videoRef={videoRef}
                            thumbnails={thumbs}
                        />

                        <input
                            className={cl("input", "caption")}
                            placeholder="Add a message (optional)"
                            value={caption}
                            maxLength={2000}
                            onChange={e => setCaption(e.currentTarget.value)}
                            onKeyDown={e => {
                                e.stopPropagation();
                                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go("send"); }
                            }}
                        />

                        <div className={cl("summary-row")}>
                            {plan && (plan.feasible
                                ? <span className={cl("summary")}>
                                    → <b>~{formatBytes(plan.estimateBytes)}</b> · {plan.outputShortSide}p{plan.fps ?? srcFps} · {((plan.videoKbps + plan.audioKbps) / 1000).toFixed(1)} Mbps
                                    {audioLabel && ` · ${audioLabel}`}
                                    {plan.videoKbps < 500 && <span className={cl("warn")}> · low quality, try a shorter clip</span>}
                                </span>
                                : <span className={cl("summary", "estimate-bad")}>Too long for {formatBytes(limit.bytes)}. Trim to under <b>{formatTime(plan.maxDuration)}</b>.</span>)}
                            <button className={cl("link")} onClick={() => setShowOptions(o => !o)}>{showOptions ? "Hide options" : "Options"}</button>
                        </div>

                        {showOptions && (
                            <div className={cl("options")}>
                                <div className={cl("option")}>
                                    <span className={cl("option-label")}>Size</span>
                                    <div className={cl("chips")}>
                                        {sizeChoices.map(mb => (
                                            <Chip key={mb} on={targetMb === mb} title={mb * MB === detected.bytes ? `Your limit (${detected.label})` : undefined} onClick={() => setTargetMb(mb)}>
                                                {formatBytes(mb * MB)}{mb * MB === detected.bytes ? " ★" : ""}
                                            </Chip>
                                        ))}
                                        <input
                                            className={cl("chip-input", isCustom && "chip-on")}
                                            placeholder="Custom MB"
                                            value={isCustom ? customMb : ""}
                                            onChange={e => {
                                                setCustomMb(e.currentTarget.value);
                                                const n = Number(e.currentTarget.value);
                                                if (n > 0) setTargetMb(n);
                                            }}
                                        />
                                    </div>
                                </div>
                                <div className={cl("option")}>
                                    <span className={cl("option-label")}>Resolution</span>
                                    <div className={cl("chips")}>
                                        <Chip on={resolution === "source"} onClick={() => setResolution("source")}>{srcShort}p</Chip>
                                        {RESOLUTIONS.filter(r => r < srcShort && r >= 360).map(r => <Chip key={r} on={resolution === r} onClick={() => setResolution(r)}>{r}p</Chip>)}
                                    </div>
                                </div>
                                <div className={cl("option")}>
                                    <span className={cl("option-label")}>Frame rate</span>
                                    <div className={cl("chips")}>
                                        <Chip on={frameRate === "source"} onClick={() => setFrameRate("source")}>{srcFps}</Chip>
                                        {FRAME_RATES.filter(f => f < probe.fps - 0.5).map(f => <Chip key={f} on={frameRate === f} onClick={() => setFrameRate(f)}>{f}</Chip>)}
                                    </div>
                                </div>
                                {probe.audioTracks.length > 0 && (
                                    <div className={cl("option")}>
                                        <span className={cl("option-label")}>Audio</span>
                                        <div className={cl("option-body")}>
                                            <div className={cl("chips")}>
                                                <Chip on={!muted} onClick={() => setMuted(false)}>On</Chip>
                                                <Chip on={muted} onClick={() => setMuted(true)}>Off</Chip>
                                            </div>
                                            {!muted && probe.audioTracks.length > 1 && <AudioTracks tracks={probe.audioTracks} state={tracks} setState={setTracks} disabled={false} />}
                                            {!muted && needsPreview && !previewReady && mix.length > 0 && (
                                                <button className={cl("link")} disabled={!!preview && "rendering" in preview} onClick={renderPreview}>
                                                    {preview && "rendering" in preview && preview.key === mixKey ? "Preparing preview…" : "Hear this mix in the preview"}
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                )}
                                {limit.learned && <div className={cl("muted", "option-wide")}>Discord rejected {formatBytes(limit.bytes + 1)} at this limit before, so this aims under that.</div>}
                            </div>
                        )}
                    </>
                )}
            </div>
        </Modal>
    );
}

function Chip({ on, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { on: boolean; }) {
    return <button type="button" className={cl("chip", on && "chip-on")} {...props}>{children}</button>;
}

function Progress({ label, value }: { label: string; value: number; }) {
    return (
        <div className={cl("progress")}>
            <div className={cl("muted")}>{label}</div>
            <div className={cl("bar")}><div className={cl("bar-fill")} style={{ width: `${Math.round(value * 100)}%` }} /></div>
        </div>
    );
}

export function openCompressModal(file: File, channel: Channel) {
    openModal(props => <CompressModal modalProps={props} file={file} channel={channel} />);
}
