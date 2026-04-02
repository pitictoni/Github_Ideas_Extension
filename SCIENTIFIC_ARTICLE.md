# A Chrome Extension for Integrated GitHub Issue, Gist, and Project Management with Anonymous Usage Benchmarking

## Abstract
This repository implements `GitHub Management Extension`, a Chrome extension designed to streamline GitHub workflows by integrating authentication, gist management, GitHub Project v2 handling, and quick note capture. The extension also collects anonymized interaction data for academic research. Key implementation details are present in `manifest.json`, `background.js`, `popup.html`, `js/auth.js`, `js/api.js`, and `js/benchmark.js`.

## 1. Introduction
Modern software development relies heavily on GitHub issue tracking, gist sharing, and project boards. The repository `GitHub_Ideas_Extension` demonstrates a browser-based productivity tool that:
- authenticates users with GitHub OAuth,
- manages personal gists,
- manipulates GitHub Project v2 items,
- captures quick ideas,
- and logs anonymous usage data.

This work is relevant to research in developer productivity, browser extension design, and secure third-party integration.

## 2. System Architecture

### 2.1 Extension Manifest
`manifest.json` defines a Manifest V3 Chrome extension with:
- permissions: `identity`, `storage`
- host permissions: `https://api.github.com/*`, `https://github-oauth-worker.iopy.workers.dev/*`
- background service worker: `background.js`
- popup UI: `popup.html`

This file establishes the extension’s security boundary and required GitHub API access.

### 2.2 Background Worker
`background.js` creates a stable anonymous `participantId` on install or startup, stored in `chrome.storage.local`. This identifier supports the repository’s claim of anonymous benchmark tracking without personal data retention.

### 2.3 Popup Interface
`popup.html` provides a dual-tab UI for:
- `Issues / Projects`
- `Gists`

It includes a quick-capture widget and buttons for login, popout mode, gist creation, project selection, and project/issue controls.

### 2.4 Main Application Logic
`js/popup.js` wires UI events to core features:
- login and logout
- quick capture interactions
- project and gist actions
- modal controls
- data refresh flows

It also coordinates state management and benchmark initiation for user actions.

## 3. Authentication and Security

### 3.1 OAuth Flow
`js/auth.js` handles GitHub OAuth via `chrome.identity.launchWebAuthFlow`. It requests scopes:
- `repo`
- `gist`
- `project`
- `read:user`

### 3.2 Token Storage
The extension encrypts tokens using Web Crypto before storing them in `chrome.storage.local`. This improves security by avoiding plaintext storage of GitHub credentials.

### 3.3 Logout and State Clearing
`js/auth.js` also provides `clearStoredToken()` to remove stored authentication state and related cached data, preserving user control over sensitive information.

## 4. GitHub API Integration

### 4.1 REST and GraphQL
`js/api.js` implements:
- REST endpoints for user info, repositories, and gists
- GraphQL queries for GitHub Project v2 and project items

Functions include:
- `fetchGitHubUser()`
- `fetchUserRepositories()`
- `fetchGists()`, `createGist()`, `updateGist()`, `deleteGist()`
- `fetchProjects()`, `fetchProjectItems()`
- `createProject()`, `addDraftIssue()`

This hybrid API design enables both standard gist workflows and advanced project board operations.

### 4.2 ProjectV2 Support
`js/api.js` contains GraphQL queries that fetch `projectsV2`, project fields, and item field values. This positions the extension to work with GitHub’s newer project model rather than legacy project boards.

## 5. Productivity Features

### 5.1 Quick Capture
`popup.html` and `js/quickcapture.js` implement a “quick capture” feature for note-taking. The UI supports:
- a textarea for instant capture
- keyboard shortcut submission (`Ctrl/Cmd + Enter`)
- inbox project selection

This feature targets the common need to record ideas before they are forgotten.

### 5.2 Gist Workflow
The extension supports gist operations with modal editors and preview flows. `js/gists.js` and `js/api.js` provide:
- gist selection
- gist preview display
- creating and editing files within gists
- renaming and deleting gists

### 5.3 Project and Issue Management
The issue/project tab enables:
- creating new projects
- loading issues and drafts
- moving items between projects
- renaming and editing projects

This integration is useful for developers who want to manage GitHub work items without leaving the browser popup.

## 6. Benchmarking and Research Data

### 6.1 Anonymous Metrics
`js/benchmark.js` defines benchmarking utilities:
- local log storage under `benchmarkLogs`
- interaction tracking for click, input, and task progress
- automatic task start/cancel/complete semantics

### 6.2 Research Intent
`popup.html` explicitly notes anonymous usage statistics collection for academic research. The design emphasizes non-identifiable data and participant anonymity, complementing the `participantId` generation in `background.js`.

## 7. Discussion

### 7.1 Contributions
This repository demonstrates:
- a practical Chrome extension architecture using Manifest V3
- secure token handling for OAuth-based GitHub integration
- combined REST and GraphQL use in a single client
- a lightweight productivity UI with task and gist management
- anonymous benchmarking design for research purposes

### 7.2 Limitations
Potential limitations include:
- dependence on external OAuth backend (`CONFIG.BACKEND_URL`) in `js/auth.js`
- complex GitHub GraphQL data shapes that may require additional error handling
- popup UI constraints for advanced project workflows

## 8. Conclusions
`GitHub_Ideas_Extension` is a promising prototype for browser-based GitHub workflow enhancement. It offers strong evidence that extensions can support rich GitHub interactions while preserving user privacy and enabling research-grade usage tracking. Future work may extend this system with richer analytics dashboards, multi-user collaboration, and offline-first capture.

## References
- `manifest.json`
- `background.js`
- `popup.html`
- `js/popup.js`
- `js/auth.js`
- `js/api.js`
- `js/benchmark.js`
- `js/gists.js`
- `js/projects.js`
- `js/quickcapture.js`
