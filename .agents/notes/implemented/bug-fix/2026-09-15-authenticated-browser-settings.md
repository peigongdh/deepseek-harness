# Agent Note: Settings access for authenticated browsers

Status: implemented

English | [中文](2026-09-15-authenticated-browser-settings.zh.md)

## Problem

An authenticated browser on a non-loopback address can reach the Host API, but a page-hostname check suppresses its settings reads and writes. The Models page cannot load its provider directory without the settings document and reports `settings are unavailable in this browser`.

## Decision

The settings plugin uses Host persistence for every browser connected through Remote. Connection owns request authentication and Host/Origin validation, as specified by [browser launch-token authentication](../architecture/2026-08-24-browser-token-authentication.md). Browser hostname classification does not grant or remove settings authority. Explicit memory-only scope consumers remain available without Host writes.

This decision supersedes only the non-loopback persistence restriction in [Host-backed Web preferences](2026-08-06-host-backed-web-preferences.md). That note retains the shared mirror, revision, invalidation, and disposal rules.

## Alternatives considered

**Configure models only from loopback.** This leaves authenticated network users unable to manage settings even though the same browser credential authorizes the complete Host API.

**Mark trusted network addresses as loopback.** Hostname classification also drives other browser behavior. Changing the settings consumer preserves that distinction and keeps authentication at Connection.

## Consequences

Authenticated browsers can read and save shared Host settings regardless of their page hostname. The change adds no listener, trusted authority, authentication bypass, or transport encryption. A deployment still owns its network exposure and transport security.

The plugin unit test covers both loopback states. The keyless Models browser scenario runs through loopback and a trusted non-loopback hostname with authority-specific UI snapshots, including settings and credential writes. Remote pages omit the native configuration-file action. Neither test invokes a model provider.
