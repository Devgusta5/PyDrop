# Design

<!-- impeccable:design-schema 1 -->

## Visual world

**Pinned, not chosen.** PRODUCT.md records the palette, typography, symbol and composition
as binding brand commitments from "PyDrop — Especificação final de branding e interface".
No concept round was run: a brief-pinned direction beats the roll.

The world is **instrument panel in deep space**. Not cyberpunk neon, not corporate SaaS.
The reference points are the flight-instrument and observatory tradition: a very dark
ground, precise thin rules, monospace for machine-readable values, and exactly two
signal colors that always mean the same thing.

**The one rule that carries the identity:** lime is *this* device, coral is *the other*
device. Every screen, every state, both modes. A user who learns it once on the home
screen reads the 3D scene without being told.

## Mode

**Operate.** The visitor came to move a file. Immersive mode is Experience nested inside
Operate — it may never cost the user the task.

## Color

Strategy: **restrained**, two signal colors on a near-black ground. Not decoration —
lime and coral are the product's vocabulary for origin and destination.

| Token | Value | Role |
|---|---|---|
| `--deep-space` | `#0B0F12` | Base surface. Never pure black. |
| `--graphite` | `#12181C` | Cards and raised surfaces. |
| `--slate-charcoal` | `#1A2328` | Elevated surface. |
| `--lime-flow` | `#B7F34A` | This device, origin, primary action. |
| `--coral-signal` | `#FF6B5E` | The other device, destination, remote presence. |
| `--soft-white` | `#F4F7F2` | Primary text. |
| `--muted-gray` | `#9AA6A8` | Secondary text. |
| `--quiet-border` | `#273238` | Borders and dividers. |
| `--transfer-green` | `#8EE36B` | Positive state. |
| `--error-red` | `#FF5964` | Errors only. **Coral is never an error color.** |

Dark is not a category default here: the scene is a dim room, a phone held at night, a
laptop beside it. The 3D environment must be the darkest thing on screen.

## Type

- **Space Grotesk** — wordmark, headings, brand moments.
- **Inter** — interface, labels, state messages, forms.
- **JetBrains Mono** — room codes, device identifiers, percentages, byte counts.

Mono is used for machine-readable values only, never as a "technical" costume. Display
headline clamps to 6rem; tracking floor -0.04em.

## Composition

Standard mode is **two fields, not a centered column**: language and action on the left,
the connection visualization on the right. On mobile they stack, and the visualization
becomes a compact horizontal band rather than a shrunken square.

The spec's prohibitions are load-bearing: no card grids, no dashboards, no transfer
counter on the home screen, no eyebrow labels above headings, no serif display.

## Motion

One authored moment: **the traversal**. The camera physically flies through the portal
from deep space into the physical room (1.5–3s, exponential ease-out). Everything else
is support — idle drift so the scene never freezes, mouse parallax, the file object
travelling the portal during transfer.

Under `prefers-reduced-motion` or the Reduce motion control, the traversal becomes an
immediate state change. The user still reaches every state; they lose the spectacle,
never the product.

## Components

Built in `App.vue` plus focused child components. Shared primitives live in `base.css`
as tokens; component styles stay scoped.

- `PortalMark` — the 2D brand portal, used in the header and connection visual.
- `ConnectionField` — the abstract two-device visualization with its state vocabulary.
- `TransferDock` — file selection, direction mode, progress, send action.
- `NoticeBar` — one shared `role="alert"` line; replaced all `window.alert` calls.

## State vocabulary

The app state machine drives both the DOM and the 3D scene; the scene reacts to state
and never owns transfer logic.

`initial · creating-room · waiting · connected · entering-room · inside-room ·
selecting-file · file-ready · transferring · completed · error`

## Accessibility floor

Real HTML controls for every action, including inside immersive mode: create room, join
by code, copy code, select file, send file, exit immersive, language, reduce motion,
quality, errors, transfer status. Keyboard reachable, visible focus, `aria-live` on
state changes, WebGL and reduced-motion fallbacks.
