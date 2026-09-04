# PushPals Expo Routes

This directory contains the Expo Router entry points. `index.tsx` is the
mission-control dashboard, not a standalone chat demo.

The dashboard:

- joins the configured Server session through `usePushPalsSession`;
- sends chat directly to `POST /sessions/:id/message`;
- consumes cursor-framed Server events over SSE on web or WebSocket on native;
- polls request, job, completion, worker, autonomy, question, configuration,
  and system-health snapshots;
- presents Coordination, Chat, Requests, Jobs & Traces, System, and Config
  views.

`_layout.tsx` owns Expo navigation setup. `modal.tsx` is retained from the Expo
route scaffold and is not part of the PushPals control-plane workflow.

From the repository root, use `bun run client` to build the protocol package
and start Expo, or `bun run start` for the preflighted full stack. Runtime URL
and session selection are documented in the parent
[`README.md`](../README.md).
