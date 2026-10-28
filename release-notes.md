## MCS-Relay 1.2.0

### New
- **Modpacks**: create a server from a modpack. Pick one from Modrinth's list of packs that run on a server (Fabric, Forge or NeoForge) or search it, choose its version, and MCS-Relay installs its mod loader, the mods a server needs and the pack's settings.
- **CurseForge server packs**: a pack that is only on CurseForge works too. **Search CurseForge** opens the pack on CurseForge's site; download its **Server Files** there and use that zip. MCS-Relay unpacks it and installs the Forge or NeoForge it needs.
- **Forge and NeoForge servers**: next to Vanilla, Paper and Fabric, MCS-Relay now downloads the official Forge and NeoForge installers and sets the server up for you.
- **Your friends see the modpack**: the main page shows which pack (and version) the server runs, with a link to it on Modrinth, so everyone can install the same one in their launcher.
- **A new server creation wizard**: start from a new server, a modpack or your own server folder. If a step fails, **Try again** continues from that step.

### Fixes
- **Old Forge servers** (Minecraft before 1.17) get Java 8, the only Java they run on, even when your PC has a newer one.
- **The CurseForge zip for players** (the one its big Download button gives) is recognised, and MCS-Relay tells you to get the pack's Server Files instead, rather than failing later with "No server .jar file was found".
