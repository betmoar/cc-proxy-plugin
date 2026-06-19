---
name: ask
description: Ask GLM-5.2 (1M context, routed through cc-proxy) a one-shot question without switching your session model. Use for cheap or large-context queries while keeping the main thread on Claude.
argument-hint: <your question or task for GLM-5.2>
model: glm-5.2[1m]
disable-model-invocation: true
---

This turn is pinned to `glm-5.2[1m]`, so it runs on GLM-5.2 via the local cc-proxy. The session returns to your previous model on the next prompt.

Answer the following directly and concisely. If it requires reading files, do so before answering.

$ARGUMENTS
