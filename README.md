<p align="center">
  <img src="website/logo.svg" alt="" width="96" height="96">
</p>

<h1 align="center">MCS-Relay</h1>

<p align="center">
  Host your Minecraft server together, from a shared Google Drive.<br>
  Whoever wants to play hosts it; the world is saved for the next one.
</p>

<p align="center">
  <a href="https://github.com/yeet30/MCS-Relay/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/yeet30/MCS-Relay?label=download"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/yeet30/MCS-Relay"></a>
  <img alt="Windows 10 and 11" src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-blue">
</p>

<p align="center">
  <a href="https://mcs-relay.com/">Website</a> ·
  <a href="https://github.com/yeet30/MCS-Relay/releases/latest">Download</a> ·
  <a href="https://mcs-relay.com/privacy.html">Privacy policy</a> ·
  <a href="https://mcs-relay.com/terms.html">Terms of use</a>
</p>

<p align="center">
  <img src="website/screenshot.png" alt="The MCS-Relay window while hosting a server" width="49%">
  <img src="website/screenshot-console.png" alt="The server console in the same window" width="49%">
</p>

## Why

A group of friends with one Minecraft world usually needs one of two things: a rented server, or the one friend
whose PC runs the server being online whenever anyone wants to play. MCS-Relay removes both. The world lives in a
Google Drive folder that you all share, and whoever wants to play hosts it on their own PC:

1. **Start**: MCS-Relay reserves the server for you, downloads what changed since you last played, and starts the
   Minecraft server (and playit.gg, if you use it, so friends can join from anywhere).
2. **Play**: your friends join with the address MCS-Relay shows you.
3. **Stop**: the world is uploaded, only the files that changed, and the server is free for the next person.

## Features

- **Take turns hosting**: anyone in the group can host; the world always continues from where the last host stopped.
- **One host at a time**: a server is reserved while someone uses it, so two people never run it at once and
  overwrite each other's world.
- **Only changes are transferred**: after the first upload, a session moves just the files that changed, several
  at a time.
- **Safe uploads**: an upload becomes the new version only when every file has arrived. You can pause it, continue it
  later (also after a crash or a closed laptop), or cancel it.
- **Conflicts are shown, never guessed**: if your copy and the cloud both changed, you choose which one to keep.
- **playit.gg built in**: link your playit.gg account once, on playit.gg's own page in your browser; MCS-Relay
  then downloads playit's agent, makes your Minecraft Java tunnel and starts it with the server, and everyone in the
  group sees the address. A playit.gg program you set up yourself still works, with all of its tunnels (Bedrock,
  Simple Voice Chat, web maps) shown with what they are for.
- **Server management**: invite and remove members, choose which files are left out of the sync, sync without
  playing, and repair a server whose upload was interrupted.
- **Download a server**: pick vanilla, Paper or Fabric and a version; the app downloads it from the official source
  (Mojang, PaperMC, FabricMC), checks it, and tells you which Java it needs.
- **Server settings**: edit `server.properties` with plain switches and boxes, and the whitelist by player name.
- **The right Java**: when a server needs a newer Java than your PC has, MCS-Relay downloads it for that server
  (Eclipse Temurin, from Adoptium), also when hosting a friend's server shows that your Java is too old.
- **World backups**: name a backup, keep it on your PC or put it in the cloud for everyone, and restore any of them;
  the current world is backed up first. While you host, one automatic backup is kept up to date every 5 to 30
  minutes, copying only what changed.
- **Lives in the tray**: notifications and a sound when a start or stop finishes or fails, Light / Mint / Dark themes,
  and automatic updates.
- **Problem reports**: Settings → Report a problem sends your description and the app's log to the developer
  through your own Google Drive, or saves them as a file.

<p align="center">
  <img src="website/feature-create.png" alt="Creating a server: start a new one or use your own folder, then pick vanilla, Paper or Fabric and a version" width="32%">
  <img src="website/feature-playit.png" alt="Server settings, Hosting tab: playit.gg linked, with the address friends join with" width="32%">
  <img src="website/feature-settings.png" alt="Server settings, server.properties tab: common settings as switches and boxes" width="32%">
</p>

## Getting started

You need Windows 10 or 11 and a Google account. MCS-Relay can download the Java your Minecraft server needs, or you
can use your own [Java](https://adoptium.net/).

1. Download `MCS-Relay-Setup-<version>.exe` from the [latest release](https://github.com/yeet30/MCS-Relay/releases/latest)
   and run it. Windows may say it "protected your PC", because the installer is not signed yet: choose
   **More info → Run anyway**.
2. Sign in with Google. MCS-Relay asks for access to your Google Drive, because it has to read the world files your
   friends upload; it only works in its own server folders (see [Your data](#your-data)). Then read and agree to
   the [terms of use](#play-with-people-you-trust).
3. **Create a server**: name it, then either let MCS-Relay download a new one (vanilla, Paper or Fabric) or point it
   to a server folder you already have (Forge and NeoForge too: the folder their installer set up with "Install
   server"). New server folders go to `MCS-Relay Servers` in your user folder, or wherever you choose. MCS-Relay
   finds what starts the server by itself; it does not need a `run.bat`.
4. **Invite your friends** from Settings → Servers. Google Drive emails them a link; they paste it into
   **Join a server** in their own MCS-Relay.
5. Press the power button.

To let friends join from anywhere without port forwarding, press **Link playit.gg** in Settings → Server settings (or in the
last step of creating a server) and sign in to [playit.gg](https://playit.gg), or create a free account, in your
browser. MCS-Relay downloads playit.gg, makes your Minecraft tunnel and tells you when everything is set. Each Link
adds an agent to your playit.gg account; delete the ones you no longer use on playit.gg. Phone hotspots often block
playit.gg: friends then time out while joining, so host from a normal internet connection.

## Your data

MCS-Relay has no servers of its own. It talks to Google Drive straight from your PC, keeps your sign-in encrypted on
it, and works only inside the "Minecraft Shared Servers" folder it creates and the servers you join (and a "MCS-Relay
problem reports" folder, when you send a report). If you link playit.gg, it also talks to playit.gg and keeps this
PC's playit.gg key encrypted. Nothing is sold, shared for advertising or collected for statistics. The [privacy policy](https://mcs-relay.com/privacy.html)
lists exactly what is used and stored, and how to remove it.

If Google shows **"Google hasn't verified this app"** when you sign in, the app has not finished Google's review for
apps with full Drive access yet. Choose **Advanced → Go to MCS-Relay** to continue.

## Play with people you trust

When you host, the server's files run on your PC: the server `.jar`, its mods and its plugins are programs, with the
same access to your PC as anything else you run. Every member who can play can change those files, and MCS-Relay does
not scan them. Someone with bad intentions, or whose Google account was taken over, could hide harmful software in a
server, and it would run on the PC of whoever hosts next.

- Create, join and invite only with people you trust. "Can view" members cannot change files.
- Keep your antivirus on.
- If mods, plugins or programs appear that nobody mentioned, ask before you host.

The app asks every Google account to agree to this, in the [terms of use](https://mcs-relay.com/terms.html), before it
can be used.

## Building from source

You need [Node.js](https://nodejs.org/) 22 and a Google Cloud project of your own:

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project, enable the **Google Drive
   API**, and set up the **Google Auth Platform** (External) with the scopes `openid`,
   `.../auth/userinfo.email`, `.../auth/userinfo.profile` and `.../auth/drive`. While it is in Testing, add your
   Google account as a test user.
2. Create an **OAuth client ID** of type **Desktop app**, download its JSON and save it as `config/client_secret.json`
   (the `config` folder is not committed). The build puts it into the app; a build without it cannot sign in.
3. Then:

```bash
npm ci
```

```bash
npm run dev
```

| Command | What it does |
|---|---|
| `npm run dev` | Runs the app with hot reload. |
| `npm test` | Runs the tests (Vitest; Google Drive is faked, nothing touches a real account). |
| `npm run lint` / `npm run typecheck` | ESLint and TypeScript checks. |
| `npm run build` | Builds the Windows installer into `release/` without publishing it. |

### How the code is organised

| Folder | What is in it |
|---|---|
| `electron/` | The main process: Google sign-in, the Drive client, the server reservation (`lock/`), syncing and transfers, the Minecraft and playit.gg processes and the playit.gg link (`playit/`), the server and Java downloads (`installer/`), the session that ties them together, and app updates. |
| `src/` | The window: React components and zustand stores. |
| `shared/` | Types and the IPC contract between the two. |
| `website/` | The website, published to GitHub Pages. |
| `docs/` | Design notes, among them [the specification of the rewrite](docs/rewrite/SPEC.md). |

### Releasing

Set the new `version` in `package.json`, write what changed in `release-notes.md` (it starts with
`## MCS-Relay <version>`), commit both, then push a matching tag:

```bash
git tag v1.0.1
```

```bash
git push origin v1.0.1
```

GitHub Actions checks, tests and builds the installer and publishes it as a release, with the notes as its text;
installed apps update themselves from it. The workflow needs one repository secret, `GOOGLE_CLIENT_SECRET_JSON`, holding the contents of
`config/client_secret.json`.

## License

[MIT](LICENSE). Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft. Google
Drive is a trademark of Google LLC.
