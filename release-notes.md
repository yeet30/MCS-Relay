## MCS-Relay 1.1.2

### New
- **Minimizing goes to the taskbar** now. To hide MCS-Relay in the tray instead, as before, turn on **Minimize to the tray** in Preferences.

### Fixes
- **The taskbar icon** changes the moment someone starts or stops hosting, instead of only after the window was hidden and shown again.
- **The whitelist stays off**: Minecraft 26.x turns the whitelist on for a new server when server.properties does not mention it, so nobody could join. Servers downloaded in MCS-Relay now start with the whitelist off, and saving server.properties writes the settings exactly as the tab shows them.
- **PvP and the Nether** are game rules in Minecraft 26.x, no longer server.properties settings, so their switches only show for servers whose server.properties still has them.
