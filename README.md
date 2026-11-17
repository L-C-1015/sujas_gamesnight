# Games Night Coins 🪙

A live coin-tracking web app for society games nights. Every player starts with the same number of coins. They spend and win coins at game stations around the room, and whoever has the most at the end wins.

It was built for the University of Southampton Japanese Society (SUJAS) games night, but hosts can set up any games they like.

| Players' phones | Station host | Game setup | Projector |
|---|---|---|---|
| ![Leaderboard](docs/board.png) | ![Host panel](docs/host.png) | ![Setup](docs/setup.png) | ![TV mode](docs/tv.png) |

## Features

- **No login for players.** Anyone with the link sees a live leaderboard and can pin their own name to follow their coins and recent games.
- **Host panel.** Hosts log in and run their station from their phone: pick the players, enter the result, then confirm.
- **Configurable games.** Hosts can add, edit, reorder and remove games without touching code. There are three game types:
  - **Winner takes the pot:** everyone pays the entry fee and one winner takes everything (e.g. Indian Poker).
  - **Placings & prizes:** an entry fee plus prizes by finishing place (e.g. Mario Kart: 15 to play, 50/30/20/10/5/5). The setup screen checks whether a full table's fees match its prizes.
  - **Chips:** buy in and cash out at 1 coin = 1 chip (e.g. Poker). It also tracks how many chips are on the table.
- **Atomic results.** Each game result is a single multi-path update, so coins can't go half-recorded if a phone drops connection.
- **Full log with undo.** Every coin move is logged, and any entry can be reversed.
- **Projector mode** (`#tv`): a big leaderboard, a QR code to join, and a feed of the latest results.
- **End game.** Freezes every station and reveals a winner podium on every screen.
- **Rule for players who run out of coins.** The host chooses whether to warn, block or allow silently.
- English and Japanese UI labels.

## Tech

- Vanilla JavaScript (ES modules), with no build step or framework.
- Firebase Realtime Database for live sync, and Firebase Auth (email/password) for hosts.
- Security rules make the data public to read, while only signed-in hosts can write.
- Hosted as a static site on GitHub Pages.
- Runs in **demo mode** (localStorage, synced across tabs) when no Firebase config is set, so you can try it with zero setup.

```
index.html            page shell
style.css             styles
app.js                views, game logic, actions
store.js              data layer: Firebase or local demo store, same interface
firebase-config.js    Firebase web config (null = demo mode)
database.rules.json   Realtime Database security rules
```

### Data model

```
players/{id}   { name, coins, created }
log/{id}       { ts, station, stationName, label, deltas: { playerId: ±coins }, by, undone? }
config         { title, subtitle, startCoins, brokePolicy, games: [...] }
settings       { ended }
```

## Run your own

1. Create a Firebase project (Analytics not needed).
2. **Realtime Database:** create it, then paste `database.rules.json` into the Rules tab and click Publish.
3. **Authentication:** enable Email/Password and add a host user.
4. Register a web app and paste its config into `firebase-config.js`.
5. Deploy the folder to GitHub Pages (or any static host), then add the domain under **Authentication → Settings → Authorized domains**.

To try it locally without Firebase, set `FIREBASE_CONFIG = null` and run `python3 -m http.server`. ES modules don't load from `file://`.

## On the night

- Open `…/#tv` on the projector.
- Hosts open `…/#host` on their phones and log in.
- Add players at the door in the **Players** tab, or paste a list in beforehand.
- After a test run, use **End game → Wipe players & history**. Your games and settings are kept.
