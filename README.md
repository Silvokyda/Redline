# Redline

Redline is a Chrome extension for reviewing and improving live web pages. Swarm Rebuild's animated cursor engine recreates the page on a canvas, then Redline can audit and redesign the live page with Claude or OpenAI.

## Install locally

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and select this folder.
3. Open a regular website and click the Redline toolbar icon.
4. Keep **Auto-scroll** enabled to follow the cursor scan down the page, or turn it off to scan the current screen. If you turn it off during a full-page scan, Redline pauses there; turn it back on to restart the full scan.
5. Choose **Redesign** to open the live-page editor. Quick fixes work locally; AI redesigns need a provider key in **Options**.

## Product design features

- Audit contrast, body text, line lengths, heading structure, image descriptions, and tap targets.
- Ask for page-level and section-level changes to hierarchy, layout, type, spacing, colors, and short copy.
- Pick a built-in or installed design skill. Skill instructions are passed as provider-neutral prompt text, so the same skills work with Anthropic and OpenAI.
- Generate responsive layout rules and use **Preview phone** to inspect a static copy at several common phone CSS viewport sizes.
- Rescan after the redesign and report text that appears clipped before marking the run complete.
- Compare before and after, undo the edits, export CSS, or copy an implementation prompt.
- Turn on soft scan sounds after the scan begins; audio starts only from that click.

## Privacy

Quick fixes and page scanning stay in the browser. For an AI redesign, Redline sends the screenshot, selected page details, prompt direction, and chosen design-skill instructions to the provider configured in Options. The provider key is stored in this browser's extension storage and sent to that provider for requests.

## Source layout

- `swarm-engine.js` is the locally integrated Swarm Rebuild visual engine. It is based on Dhvanil Patel's Swarm Rebuild and uses cursor motion design by Joel Califa, with Joel's permission. The HUD credits both contributors.
- The toolbar action starts the Swarm animation; **Redesign with AI** closes the canvas and opens Redline's live-page editor.
- `content.js` provides the live design audit, editor, mobile preview, and CSS export.
- `redline-background.js` connects the selected AI provider and manages local settings.

This working copy is for local use. Keep the Swarm attribution visible in the extension UI.
