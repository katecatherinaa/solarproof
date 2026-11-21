# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- Enabled Dependabot security-only auto-merge for security advisories (PRs labelled `security_advisory`).
  - Auto-merge only proceeds when **all** CI checks pass.
  - **Critical** severity CVE patches are merged immediately after CI passes.
  - **High** severity patches are merged within 24 hours.
  - Each auto-merged security PR is logged in this section with its advisory ID, affected package, and severity.

<!-- Auto-merged security updates are appended below by the Dependabot auto-merge workflow. -->
<!-- Format: - [<advisory-id>] <package> (<severity>) - merged <timestamp> -->