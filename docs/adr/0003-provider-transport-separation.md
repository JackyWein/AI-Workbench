# 3. Provider identity is separate from transport

Date: 2026-09-21
Status: Accepted

## Context

The same provider can be reachable in several ways: a local CLI, an HTTP API,
an OpenAI-compatible endpoint, or a local model server. If a provider were
coupled to one connection method, supporting a second one would mean a second
adapter and duplicated logic.

## Decision

Model provider identity (`AIProviderAdapter`, `ProviderMetadata`) and transport
(`ProviderTransportType`, and later reusable transports) as separate
abstractions. Metadata declares which transports a provider supports; a
`ProviderConfig` selects one.

## Consequences

- A CLI transport can be written once and reused by several adapters
- A provider can gain an API path without a rewrite
- `ProviderConfig` already carries the fields an API or custom provider needs
  (`baseUrl`, `credentialReference`, `executablePath`, `arguments`), so the
  custom-provider UI in G8 does not require a schema change
- Slightly more indirection than a single adapter class per integration

## Alternatives considered

- **One adapter per provider-and-transport pair**: simpler at first, but
  duplicates lifecycle, cancellation and parsing logic per combination
