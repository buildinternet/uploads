# VHS CLI demos

Use [Charm VHS](https://github.com/charmbracelet/vhs) when the README or a docs
page needs a terminal recording of a real `uploads` command. Host the gif and
the mp4. Embed the `embed.uploads.sh` URL. Leave the binary out of git.

Use `.context/` for social scratch: captions, one-off posts, and drafts that
stay on your machine. That folder is gitignored. A README embed and a docs
page read the hosted URL.

`scripts/demos` is a separate Remotion package. It renders square social loops.

## Install

```bash
brew install vhs
```

VHS records through `ttyd` and encodes with `ffmpeg`. Homebrew installs both.

## Style

Put every `Set` line at the top of the tape. VHS ignores a setting that appears
after the first command.

| Setting     | Value            |
| ----------- | ---------------- |
| Theme       | Catppuccin Mocha |
| Width       | 1200             |
| Height      | 620–700          |
| FontSize    | 18–22            |
| TypingSpeed | 40–55ms          |
| Padding     | 24               |
| Framerate   | 50 (VHS default) |

`Set Theme "Catppuccin Mocha"` is the theme line. The example tape uses height
`650`, font size `20`, and typing speed `50ms`. Stay inside the ranges above.

## Example tape

This tape records `uploads feed create --repo buildinternet/uploads`.

```tape
Output feed-create.gif
Output feed-create.mp4

Set Shell "bash"
Set Theme "Catppuccin Mocha"
Set Width 1200
Set Height 650
Set FontSize 20
Set TypingSpeed 50ms
Set Padding 24

Hide
Type "export UPLOADS_API_URL=https://api.uploads.sh"
Enter
Show

Type "uploads feed create --repo buildinternet/uploads"
Enter
Sleep 3s
```

Run `vhs` from the directory that should receive the files. `Output` paths are
relative to that directory.

```bash
export UPLOADS_API_URL=https://api.uploads.sh
vhs feed-create.tape
```

## Gotchas

**Relative `Output` paths only.** Write `Output feed-create.gif`. An absolute
path fails. The path is relative to the working directory where you run `vhs`,
not to the tape file.

**Point the CLI at the hosted API.** A local shell often sets
`UPLOADS_API_URL` to `http://localhost:8787`. Export the hosted API before you
record:

```bash
export UPLOADS_API_URL=https://api.uploads.sh
```

The example tape exports it again behind `Hide`. A shell startup file then
cannot point the recording at your laptop, and the export stays off screen.

**When VHS does not write the gif or the mp4,** keep the frames and encode
them yourself.

1. Replace the gif and mp4 lines with `Output frames/`.
2. Run `vhs` again. VHS writes `frames/frame-text-00001.png` and
   `frames/frame-cursor-00001.png`. The number is five digits.
3. Overlay the text frames and the cursor frames at 50 fps.
4. Build a palette GIF from that overlay.

```bash
ffmpeg -y \
  -framerate 50 -start_number 1 -i frames/frame-text-%05d.png \
  -framerate 50 -start_number 1 -i frames/frame-cursor-%05d.png \
  -filter_complex "[0][1]overlay=format=auto,split[plt_a][plt_b];[plt_a]palettegen=max_colors=256[plt];[plt_b][plt]paletteuse[v]" \
  -map "[v]" \
  feed-create.gif
```

The same overlay writes an mp4. Drop the palette steps and set the codec:

```bash
ffmpeg -y \
  -framerate 50 -start_number 1 -i frames/frame-text-%05d.png \
  -framerate 50 -start_number 1 -i frames/frame-cursor-%05d.png \
  -filter_complex "[0][1]overlay=format=auto" \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart \
  feed-create.mp4
```

Match `-framerate` to `Set Framerate` when you change it. Raw frames omit the
padding VHS applies during its own encode. This fallback gif is the terminal
canvas only.

You must set `Output frames/` to keep the png files. Without that line, VHS
stores frames in a temp directory and deletes them after the encode step.

## Host

Upload with an explicit key and `--replace`. The key is hash-free, so the URL
stays stable and every embed updates in place.

```bash
uploads put ./feed-create.gif --key f/docs/vhs-cli/feed-create.gif --replace
uploads put ./feed-create.mp4 --key f/docs/vhs-cli/feed-create.mp4 --replace
uploads put ./feed-create-preview.png --key f/docs/vhs-cli/feed-create-preview.png --replace
```

Paste the `embedUrl` from the response. That host is
`https://embed.uploads.sh/...`. GitHub's image proxy revalidates it, so a
replaced gif shows up in the README.

Do not commit the gif or the mp4. The stills in `docs/assets/readme-*.png`
stay in git. Those files are static product screenshots.

A `Screenshot feed-create-preview.png` line in the tape writes the preview
still. Publish it at `f/docs/vhs-cli/<name>-preview.png`.

## Hosted demos

These four recordings are already on the `default` workspace. Replace one with
the `uploads put` command above. Use the same key.

| Name           | Command                                                      | GIF                                                                | MP4                                                                | Preview                                                                    |
| -------------- | ------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| feed-create    | `uploads feed create --repo buildinternet/uploads`           | https://embed.uploads.sh/default/f/docs/vhs-cli/feed-create.gif    | https://embed.uploads.sh/default/f/docs/vhs-cli/feed-create.mp4    | https://embed.uploads.sh/default/f/docs/vhs-cli/feed-create-preview.png    |
| feed-create-pr | `uploads feed create --repo buildinternet/uploads --pr 1015` | https://embed.uploads.sh/default/f/docs/vhs-cli/feed-create-pr.gif | https://embed.uploads.sh/default/f/docs/vhs-cli/feed-create-pr.mp4 | https://embed.uploads.sh/default/f/docs/vhs-cli/feed-create-pr-preview.png |
| changelog      | `uploads changelog --limit 5`                                | https://embed.uploads.sh/default/f/docs/vhs-cli/changelog.gif      | https://embed.uploads.sh/default/f/docs/vhs-cli/changelog.mp4      | https://embed.uploads.sh/default/f/docs/vhs-cli/changelog-preview.png      |
| docs-feeds     | `uploads docs change feed`                                   | https://embed.uploads.sh/default/f/docs/vhs-cli/docs-feeds.gif     | https://embed.uploads.sh/default/f/docs/vhs-cli/docs-feeds.mp4     | https://embed.uploads.sh/default/f/docs/vhs-cli/docs-feeds-preview.png     |
