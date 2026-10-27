## MCS-Relay 1.1.0

### New
- **playit.gg built in**: press **Link playit.gg** (Settings > Server settings, or the last step of creating a server) and sign in to playit.gg, or create a free account, in your browser. MCS-Relay downloads playit.gg, makes your Minecraft tunnel, starts it with the server and tells you when everything is set. No separate install, no tunnel to set up by hand. Phone hotspots often block playit.gg; use a normal internet connection to host with it.
- **The right Java, downloaded for you**: when a server needs a newer Java than your PC has, MCS-Relay can download it (Eclipse Temurin, from Adoptium) and use it for that server. This works when creating a server, and when a start stops because Java is too old ("Get Java 21 and try again").
- **Server settings**: the Scripts menu is now **Server settings**, with three tabs:
  - **Hosting**: playit.gg, Java and memory, and the automatic backup.
  - **server.properties**: the settings people change most as switches and boxes (players, game mode, difficulty, view distance, port, ...), and every other line of the file too.
  - **Whitelist** (shown while the whitelist is on): add and remove players by name. While you host, changes apply at once.
- A start that failed has a **Try again** button, and **Open playit.gg** when the fix is on playit.gg's site.

### Fixes
- Clearer messages when playit.gg cannot run (too many agents on the account, an unverified email, a deleted agent), and a playit.gg program that was uninstalled is no longer looked for.
