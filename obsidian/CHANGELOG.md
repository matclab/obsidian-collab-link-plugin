# Changelog

Notable changes to Collab Link, the Obsidian plugin, as its users see them, including what changes in the view it shares with the web page. The whole project's changes: [CHANGELOG.md](../CHANGELOG.md).

Form: [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/). Versions: [SemVer](https://semver.org/), the project's. Each release on GitHub takes its section as notes.

## [Unreleased]

## [0.8.4] - 2026-11-24

No change in the plugin itself: released with the project.

## [0.8.3] - 2026-11-24

### Added

- Licensed under Apache 2.0.
- This changelog; each GitHub release takes its section as notes.

## [0.8.2] - 2026-11-24

### Fixed

- Images: nothing is made nor sent once the view is closed.
- Annotations: a click on a widget makes its annotation active.

## [0.8.1] - 2026-11-22

### Changed

- The choice of view (Formatted, Source, Reading, Side by side) keeps one place: on a wide view, in the header right after the modes; it no longer moves from one view to another.

## [0.8.0] - 2026-11-22

### Added

- Alerts of what awaits your reply (a reply to your comment, a rejected suggestion), in the view and in *My documents*; the plugin reads the server's push key from its `/config.json`.
- A readable outline on a long document: its width set by a handle and kept, its branches folded one by one or by depth, its hierarchy marked.
- Callout types in the `/` menu, searched by family, inserted with a translated title.
- A first visit's banner, per role, and the first hints (markup, diagrams).
- Who wrote: a dotted underline per person.

### Changed

- The preview is called Reading; the views are one control, side by side an option of Source.
- The document menu is a named button, not three dots.

### Fixed

- A double or triple click selects the word or line under the pointer, also where the first press reveals the line's markup; a click on an annotation's mark makes it active at once.
- Footnotes: a reference link whose label is a link's definition stays a link.

## [0.7.0] - 2026-11-19

### Added

- Who wrote: each author's tint in the editor, a bar per block in Reading, a switch and its legend.

### Fixed

- Another's text comes in as they wrote it, never touched by a filter.

## Earlier versions

See the project's history.
