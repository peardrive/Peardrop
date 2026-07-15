# 🍐 Peardrop

**The file sharing app that actually works the way you expect it to.**

No accounts. No limits. No bullshit. Just drop a file, get a link, send it to
whoever needs it. They click it, they get the file. Done.

True peer-to-peer, built on [hyperdrive](https://github.com/holepunchto/hyperdrive) /
[hyperswarm](https://github.com/holepunchto/hyperswarm) — files go directly
between you and them. No servers in the middle, nothing stored in a cloud,
no tracking.

## This repo

This is the umbrella repo for all Peardrop clients. They share one unified
file-sharing engine underneath; each app is a thin native shell on top of it.

| Directory | What it is |
|---|---|
| [`apps/desktop/`](apps/desktop/) | Desktop app (Electron) — Mac, Linux, Windows |
| [`apps/mobile/`](apps/mobile/) | Mobile app (Expo / React Native + bare) — Android, iOS |

Each app is self-contained for now: `cd` into it, `npm install`, and go. See
each app's README for details.

## Downloads

Grab builds from the [Releases page](../../releases):

- **Android APK** — download, sideload, share pears. You'll need to allow
  installs from unknown sources.
- **Desktop** — run from source for now: `cd apps/desktop && npm install && npm start`

iOS (TestFlight) and the app stores come later. Right now this repo is the
place for the curious to see how it works and for early testers to kick the
tires — bug reports and transfer war stories welcome in
[Issues](../../issues).

## Status

Early but real: verified cross-machine transfers (Mac → Linux → Android),
shares survive restarts, pause/resume works, QR-code retrieve on both
platforms. Interface and GUI layout are still evolving on top of the engine.

## History

Peardrop grew out of the PearDrive project. Earlier iterations lived in
`peardrive/peardrop-legacy` (original prototype) and
`Prototype-Drive/peardrop-mobile` (pre-unified mobile client); both are
archived. This repo is the single home going forward.
