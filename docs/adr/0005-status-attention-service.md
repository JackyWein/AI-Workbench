# 5. Attention priority lives in a service, not in the Island UI

Date: 2026-09-21
Status: Accepted (design fixed before implementation)

## Context

Many subsystems can demand attention: a provider fails, an agent is blocked, a
team run finishes, usage runs low. If each of them talked to the Status Island
directly, priority rules would end up scattered across UI conditions and no
subsystem could be reasoned about on its own.

## Decision

Subsystems publish domain events to the event bus. A single
`StatusAttentionService` consumes them, applies the documented priority scale,
maintains the attention queue and the widget registry, and exposes the island
state. The Status Island window only renders that state.

## Consequences

- Priority is testable in isolation, without a window
- The island can be disabled, and nothing else changes behaviour
- New sources of attention do not touch UI code
- The service becomes a central component that must stay small and rule-driven

## Alternatives considered

- **Direct subsystem-to-island calls**: fastest to write, impossible to keep
  coherent once more than a handful of sources exist
