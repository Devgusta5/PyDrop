# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primarily non-technical people moving a file between two devices they own — most often
phone ↔ computer. They arrive with a single job in mind and no intention of creating an
account. The interface must never expose WebRTC, WebSocket, or backend infrastructure
concepts to them.

Mobile is a first-class case, not a shrunken desktop: one of the two devices in a typical
transfer is a phone, and it is usually the device scanning the QR code.

## Product Purpose

Transfer files directly between two devices through a temporary room, with no account and
no permanent storage. Success is a file arriving on the other device in as few steps as
possible, with the user confident about what happened and where the file went.

## Positioning

The file bytes never touch the backend. A room is a temporary meeting point for two
devices; the transfer itself is browser-to-browser over a WebRTC DataChannel. The backend
only relays signaling (offer, answer, ICE) and small events.

The product has two complementary modes, both first-class:

1. **Standard mode** — the fastest, clearest path to a transfer.
2. **Immersive mode** — an optional 3D experience where the environment *is* the
   interface, entered through an action called "Enter immersive mode".

In standard mode the interface explains the connection; in immersive mode the environment
makes the user feel it.

## Operating Context

- A user opens PyDrop on a computer, creates a room, and gets an 8-character code plus a
  QR code.
- The second device joins by typing the code or scanning the QR (which opens
  `?room=CODE`).
- Rooms expire after 1 hour and hold at most 2 devices.
- The backend (Render, free tier) may be asleep; the app health-checks and retries with a
  visible "starting server" state before opening the WebSocket.
- Camera/QR scanning requires HTTPS in production.

## Capabilities and Constraints

- Vue 3 + TypeScript + Vite frontend; FastAPI backend; Three.js for the 3D scenes.
- Transfer over `RTCDataChannel`; signaling over WebSocket; no file persistence anywhere.
- 500 MiB per-file limit. The receiver buffers the whole file in memory before download.
- Room codes are 8 uppercase alphanumeric characters.
- Two devices maximum per room; a third is rejected with close code 1008.
- The DataChannel is bidirectional and symmetric: both devices can send and receive
  simultaneously. Send/Receive mode communicates *intent* between two cooperating people;
  it is not a transport-level lock.
- Portuguese (`pt`) is the initial language; English is also available. All user-facing
  copy must exist in both.
- Must degrade gracefully: WebGL unavailable, reduced motion, and low-performance devices
  all need working paths.

## Brand Commitments

Binding, from "PyDrop — Especificação final de branding e interface":

- **Name:** always `PyDrop`, with capital P and D. The Python reference stays subtle.
- **Concept:** a portal connecting two points — two interlocking forms with a central
  passage and a flow implied by negative space. The shipped symbol is two interlocked
  lime/coral rounded shapes with a white arrow cut from the negative space.
- **Palette:** Deep Space `#0B0F12`, Graphite `#12181C`, Slate Charcoal `#1A2328`,
  Lime Flow `#B7F34A`, Coral Signal `#FF6B5E`, Soft White `#F4F7F2`,
  Muted Gray `#9AA6A8`, Quiet Border `#273238`, Transfer Green `#8EE36B`,
  Error Red `#FF5964`.
- **Color meaning:** lime = this device, origin, energy, the primary action.
  Coral = the other device, destination, remote presence. Coral is *not* the error color.
- **Type:** Space Grotesk for brand and headings, Inter for interface text, JetBrains Mono
  only for room codes and short copyable identifiers. No serif headings.
- **Base surface** is `#0B0F12`, never pure black. No blue as the primary action color, no
  excess purple, no exaggerated neon gradients, no "AI product" look.
- **Assets** must not be given shadow, rotation, distortion, or gradients.

Explicit anti-references from the spec: corporate SaaS dashboards, generic cloud storage,
card-grid dashboards, transfer counters on the home screen, the old "Move files simply."
headline, the label "ENABLE 3D", and treating Three.js as a decorative canvas behind
conventional HTML.

## Evidence on Hand

- `PyDrop_—_Especificação_final_de_branding_e_interface.pdf` — the binding design and
  product specification.
- `frontend/pydrop-logo-final-symbol*.png`, `pydrop-icon-192.png`,
  `pydrop-icon-light-512.png`, `pydrop-icon-monochrome-512.png`, `pydrop-favicon-64.png`
  — shipped brand assets.
- `frontend/pydrop-standard.png`, `pydrop-immersive.png`, `pydrop-mobile.png` —
  screenshots of the *previous* implementation. Evidence of the incumbent, not target
  comps; the immersive and mobile ones show defects the specification explicitly rejects.
- `README_CLAUDE_TEMPORARY.md` — architecture notes; partially stale.

## Open Decisions

- The spec lists `pydrop-logo-lockup.svg` and `pydrop-icon-512.png` as brand assets, but
  neither exists in the repository. The horizontal lockup is currently composed in markup
  from the symbol plus live text.
- TURN servers are not yet provisioned; only STUN is configured, so transfers behind
  symmetric NAT may fail to connect.

## Attribution

Created by Gustavo Rodrigues — https://github.com/Devgusta5 — surfaced discreetly in the
interface as a product credit.
