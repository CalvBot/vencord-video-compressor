/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { RefObject } from "react";
import { useEffect, useRef, useState } from "@webpack/common";

import { formatTime } from "./limits";

const cl = classNameFactory("vc-vidcomp-");
const MIN_CLIP = 0.1;

type Drag = { kind: "start" | "end" | "seek"; } | { kind: "range"; grabOffset: number; length: number; };

interface TimelineProps {
    duration: number;
    fps: number;
    start: number;
    end: number;
    onChange(start: number, end: number): void;
    videoRef: RefObject<HTMLVideoElement | null>;
    thumbnails: (string | null)[] | null;
    disabled?: boolean;
}

function Btn({ primary, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean; }) {
    return <button type="button" className={cl("btn", primary && "btn-primary") + (className ? " " + className : "")} {...props} />;
}

export function Timeline({ duration, fps, start, end, onChange, videoRef, thumbnails, disabled }: TimelineProps) {
    const trackRef = useRef<HTMLDivElement>(null);
    const [current, setCurrent] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [loop, setLoop] = useState(true);
    const drag = useRef<Drag | null>(null);
    // Latest values for event handlers registered once
    const live = useRef({ start, end, loop });
    live.current = { start, end, loop };

    const frame = 1 / (fps > 0 ? fps : 30);
    const pct = (t: number) => `${(t / duration) * 100}%`;
    const clamp = (t: number) => Math.min(duration, Math.max(0, t));

    function seek(t: number) {
        const v = videoRef.current;
        t = clamp(t);
        if (v) v.currentTime = t;
        setCurrent(t);
    }

    // Track the video's playhead; keep playback inside the selection
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        let raf = 0;
        const tick = () => {
            const { start, end, loop } = live.current;
            if (!v.paused && v.currentTime >= end) {
                if (loop) v.currentTime = start;
                else { v.pause(); v.currentTime = end; }
            }
            setCurrent(v.currentTime);
            if (!v.paused) raf = requestAnimationFrame(tick);
        };
        const onPlay = () => { setPlaying(true); raf = requestAnimationFrame(tick); };
        const onPause = () => { setPlaying(false); cancelAnimationFrame(raf); setCurrent(v.currentTime); };
        const onSeeked = () => setCurrent(v.currentTime);
        v.addEventListener("play", onPlay);
        v.addEventListener("pause", onPause);
        v.addEventListener("seeked", onSeeked);
        return () => {
            cancelAnimationFrame(raf);
            v.removeEventListener("play", onPlay);
            v.removeEventListener("pause", onPause);
            v.removeEventListener("seeked", onSeeked);
        };
    }, [videoRef.current]);

    function togglePlay() {
        const v = videoRef.current;
        if (!v) return;
        if (!v.paused) return v.pause();
        if (v.currentTime < start || v.currentTime >= end - 0.05) v.currentTime = start;
        v.play().catch(() => { });
    }

    const setStart = (t: number) => onChange(Math.min(clamp(t), end - MIN_CLIP), end);
    const setEnd = (t: number) => onChange(start, Math.max(clamp(t), start + MIN_CLIP));

    function timeAt(clientX: number) {
        const r = trackRef.current!.getBoundingClientRect();
        return clamp((clientX - r.left) / r.width * duration);
    }

    function onPointerDown(e: React.PointerEvent, kind: "start" | "end" | "range" | "seek") {
        if (disabled) return;
        e.preventDefault();
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        videoRef.current?.pause();
        const t = timeAt(e.clientX);
        if (kind === "range") drag.current = { kind, grabOffset: t - start, length: end - start };
        else drag.current = { kind };
        if (kind === "seek") seek(t);
    }

    function onPointerMove(e: React.PointerEvent) {
        const d = drag.current;
        if (!d) return;
        const t = timeAt(e.clientX);
        if (d.kind === "start") { setStart(t); seek(Math.min(t, end - MIN_CLIP)); }
        else if (d.kind === "end") { setEnd(t); seek(Math.max(t, start + MIN_CLIP)); }
        else if (d.kind === "range") {
            const s = Math.min(Math.max(0, t - d.grabOffset), duration - d.length);
            onChange(s, s + d.length);
            seek(s);
        } else seek(t);
    }

    const onPointerUp = () => { drag.current = null; };

    function onKeyDown(e: React.KeyboardEvent) {
        if (disabled || (e.target as HTMLElement).tagName === "INPUT") return;
        const v = videoRef.current;
        const now = v?.currentTime ?? current;
        const step = e.shiftKey ? 1 : frame;
        const handled = (() => {
            switch (e.key) {
                case " ": case "k": togglePlay(); return true;
                case "i": case "I": setStart(now); return true;
                case "o": case "O": setEnd(now); return true;
                case "ArrowLeft": v?.pause(); seek(now - step); return true;
                case "ArrowRight": v?.pause(); seek(now + step); return true;
                case "Home": seek(start); return true;
                case "End": seek(end); return true;
                case "l": case "L": setLoop(l => !l); return true;
            }
            return false;
        })();
        if (handled) { e.preventDefault(); e.stopPropagation(); }
    }

    return (
        <div className={cl("timeline", disabled && "disabled")} tabIndex={0} onKeyDown={onKeyDown}>
            <div
                ref={trackRef}
                className={cl("track")}
                onPointerDown={e => onPointerDown(e, "seek")}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
            >
                <div className={cl("thumbs")}>
                    {(thumbnails ?? Array.from({ length: 12 }, () => null)).map((src, i) =>
                        src ? <img key={i} src={src} draggable={false} /> : <div key={i} className={cl("thumb-empty")} />
                    )}
                </div>
                <div className={cl("dim")} style={{ left: 0, width: pct(start) }} />
                <div className={cl("dim")} style={{ left: pct(end), right: 0 }} />
                <div
                    className={cl("selection")}
                    style={{ left: pct(start), width: pct(end - start) }}
                    onPointerDown={e => onPointerDown(e, "range")}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                >
                    <div className={cl("handle", "handle-start")} onPointerDown={e => onPointerDown(e, "start")} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
                    <div className={cl("handle", "handle-end")} onPointerDown={e => onPointerDown(e, "end")} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />
                </div>
                <div className={cl("playhead")} style={{ left: pct(current) }} />
            </div>

            <div className={cl("controls")} title="Space play · I / O set start / end · ← → step a frame (Shift: 1 s) · L loop">
                <Btn primary className={cl("play")} onClick={togglePlay}>{playing ? "❚❚" : "▶︎"}</Btn>
                <span className={cl("clock")}>{formatTime(current)}</span>
                <div className={cl("spacer")} />
                <span className={cl("clip-range")}>
                    {formatTime(start)} – {formatTime(end)}
                    <b> {formatTime(end - start)}</b>
                </span>
                {(start > 0.05 || end < duration - 0.05) && <Btn title="Use the whole video" onClick={() => onChange(0, duration)}>Reset</Btn>}
            </div>
        </div>
    );
}
