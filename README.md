# VideoCompressor

A Vencord plugin. When a video is too big for Discord, it opens a window where you trim and
compress it to fit, then sends it.

## Install

1. Install [ffmpeg](https://ffmpeg.org/), for example with `winget install Gyan.FFmpeg`.
2. Get the plugin with the
   [Vencord Plugin Installer](https://github.com/CalvBot/vencord-plugin-installer/releases/latest).

## What it does

- Catches videos over your upload limit, however you add them: drag and drop, paste, the + button
  or a shared Clip.
- Knows your limit from your Nitro tier and the server's boosts.
- Lets you trim the video, pick which audio tracks to keep and set their volume.
- Compresses in the background while you keep using Discord, then uploads the result.
- Uses your NVIDIA card if you have one, otherwise the CPU.
