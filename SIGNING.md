# Signing releases

Windows SmartScreen and macOS Gatekeeper warn about an app that is not code
signed, and a Mac only installs updates that are signed like the app it
replaces. The release workflow (`.github/workflows/release.yml`, step
*Package*) signs by itself as soon as the certificates below are stored in
the repository; without them it builds unsigned, as it always has.

A certificate is proof of who publishes the app, so it has to be applied for
by the person or company that does — it cannot be generated here, and a
self-signed certificate makes the warnings worse, not better. Store every
value under **Settings → Secrets and variables → Actions** of the GitHub
repository; nothing is ever written into the repository or shown in a log.

## macOS: Developer ID and notarization

Needs a membership of the Apple Developer Program.

1. In the Apple Developer account, create a **Developer ID Application**
   certificate and export it with its private key from Keychain Access as a
   `.p12` file with a password.
2. Create an app-specific password for the Apple ID at appleid.apple.com, and
   note the Team ID from the developer account.
3. Add these repository **secrets**:

   | Secret | Value |
   |---|---|
   | `MAC_CERTIFICATE` | the `.p12` file, base64-encoded (`base64 -i cert.p12`) |
   | `MAC_CERTIFICATE_PASSWORD` | the `.p12` file's password |
   | `APPLE_ID` | the Apple ID that notarizes |
   | `APPLE_APP_SPECIFIC_PASSWORD` | its app-specific password |
   | `APPLE_TEAM_ID` | the Team ID |

The Mac build is then signed with the hardened runtime and notarized by
Apple, opens without a warning, and — because a signed build may install
updates signed the same way — updates itself like the Windows installer and
the AppImage do.

## Windows: a code signing certificate or Azure Trusted Signing

Either of two ways; if both are set, Azure Trusted Signing is used.

**Azure Trusted Signing** (Microsoft's signing service, billed monthly; who
may apply depends on Microsoft's current eligibility rules). Create a Trusted
Signing account and a certificate profile in Azure, and an app registration
allowed to sign with it. Then add:

| Kind | Name | Value |
|---|---|---|
| secret | `AZURE_TENANT_ID` | the directory (tenant) id |
| secret | `AZURE_CLIENT_ID` | the app registration's client id |
| secret | `AZURE_CLIENT_SECRET` | a client secret of that registration |
| variable | `AZURE_SIGNING_ENDPOINT` | the account's endpoint, e.g. `https://weu.codesigning.azure.net` |
| variable | `AZURE_SIGNING_ACCOUNT` | the Trusted Signing account name |
| variable | `AZURE_SIGNING_PROFILE` | the certificate profile name |
| variable | `AZURE_SIGNING_PUBLISHER` | the publisher name on the certificate |

**A code signing certificate file** from a certificate authority, exported as
a `.pfx` with its private key (many authorities now keep new keys on a
hardware token or in their own cloud instead; then use their signing service
or Azure Trusted Signing). Add:

| Secret | Value |
|---|---|
| `WINDOWS_CERTIFICATE` | the `.pfx` file, base64-encoded |
| `WINDOWS_CERTIFICATE_PASSWORD` | its password |

SmartScreen judges a signed app by the reputation of its publisher: the
"unrecognized app" notice can still appear for a while after the first
signed release, until enough people have installed it.

## After adding them

Run *Actions → Release → Run workflow*. The *Package* step says for each
platform whether it signed ("Signing for macOS; notarizing: yes", "Signing for
Windows with …") or built unsigned. Linux packages are not signed; nothing on
Linux warns about that.
