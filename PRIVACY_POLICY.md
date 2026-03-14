# Privacy Policy for GitHub Management Extension

**Last Updated: March 14, 2026**

GitHub Management Extension is a Chrome browser extension that allows users to manage GitHub Issues and Gists directly from their browser.

## 1. Information We Collect

This extension uses GitHub OAuth 2.0 authentication to access your GitHub account with your permission.

With your permission, we may access:
- Your GitHub username and avatar
- Your public and private repositories
- Your projects
- Your issues
- Your gists
- OAuth 2.0 access token provided by GitHub

We do not collect passwords.

## 2. How Information Is Used

The accessed information is used solely to:
- Display your GitHub data inside the extension
- Allow you to manage your issues, projects and gists

## 3. Data Storage and Infrastructure

OAuth 2.0 access tokens are stored locally in your browser storage.
Cached GitHub data may be temporarily stored in your browser to improve performance.

We do not store your GitHub data on external servers.

GitHub Management Extension uses backend infrastructure hosted on Cloudflare through Cloudflare Workers to facilitate the GitHub OAuth 2.0 authentication process.
When a user signs in with GitHub, the extension sends a temporary authorization code to this service, which exchanges it with GitHub for an access token.
The backend service does not store GitHub data, user accounts, or OAuth 2.0 access tokens.

Cloudflare may automatically generate and temporarily retain request logs as part of operating its infrastructure and security services. These logs may include limited technical information such as IP addresses, request timestamps, and request paths. According to Cloudflare's infrastructure policies, such logs may be retained for a limited period (up to approximately 7 days) before being automatically deleted.

GitHub Management Extension does not access, analyze, or use these logs to track users.

## 4. Data Sharing

We do not:
- Sell user data
- Share personal information with third parties
- Use data for advertising purposes

## 5. Data Security

Authentication is handled securely using GitHub's official OAuth 2.0 flow.

All API communications with GitHub are made over HTTPS.

Your GitHub access token is stored securely in your browser's local storage.

## 6. User Control

You may revoke access at any time by performing both of these actions:
- Removing the extension
- Revoking access from your GitHub account settings

## 7. Changes to This Privacy Policy

We may update this Privacy Policy from time to time. We will notify users of any material changes by updating the "Last Updated".

## 8. Contact

If you have questions, contact us on exttools.dev@gmail.com.

## 9. Compliance

This extension complies with GitHub's API terms of service and Chrome Web Store policies.

## 10. GDPR Compliance

This extension complies with the General Data Protection Regulation (GDPR). EU users have the right to access, rectify, or delete their data. Since all data is stored locally in your browser, uninstalling the extension removes it.