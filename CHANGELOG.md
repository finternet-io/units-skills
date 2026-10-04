# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- Branding: Finternet is presented as a mission of Networks for Humanity (NFH). Copyright holder is now Networks for Humanity (NFH) and contributors. Plugin author and marketplace owner updated.

### Added
- Official NFH and Finternet logos in `assets/brand/` (light/dark variants) with usage notes and the Finternet palette. README header shows both logos.

## [1.0.0] - 2026-10-04

First public release. Knowledge snapshot: 2026-10-03.

### Added
- `units` Claude skill: `SKILL.md` with the mental model, 10 integration rules, environments and a question router.
- 15 reference files:
  - portals and access
  - concepts and glossary
  - architecture
  - auth and onboarding
  - API reference
  - token classes
  - token programs
  - integration playbook
  - worked examples
  - authoring token programs
  - workflows and services
  - local development
  - troubleshooting
  - known gaps
  - FAQ
- Examples:
  - dependency-free TypeScript client
  - Python client
  - curl quickstart
  - seven ready-made token class and config payloads
- Claude Code plugin and marketplace manifests (`units@finternet-units`).
- `scripts/package.sh` (Claude.ai / API zip) and `scripts/lint.sh` (CI checks).
- Open-source files: MIT license, contributing guide, code of conduct, security policy, support guide, issue and PR templates, CI workflow.
