# 🎲 Call of Cthulhu Bot + OBS Overlay

A Discord bot that reads investigators' character sheets straight from a Google Sheets spreadsheet, rolls d100 tests applying the Call of Cthulhu 7th edition rules, and shows the result on your stream in real time, with animation and sound.

🌐 This project is also available in [Portuguese BR](https://github.com/henriquecoelhome-source/CoC_Bot.git)

> **Never touched programming before?** No problem. This guide is written for you to follow from scratch, in order, without skipping steps. It takes about 30 to 40 minutes the first time.

---

## 📑 Table of contents

- [What it looks like on stream](#-what-it-looks-like-on-streamrecording)
- [How it works](#-how-it-works)
- [What the bot does](#-what-the-bot-does)
- [Before you start](#-before-you-start)
- [Step 1 — Install Node.js](#step-1--install-nodejs)
- [Step 2 — Download the project](#step-2--download-the-project)
- [Step 3 — Create the bot on Discord](#step-3--create-the-bot-on-discord)
- [Step 4 — Create the Google Service Account](#step-4--create-the-google-service-account)
- [Step 5 — Prepare the character-sheet spreadsheet](#step-5--prepare-the-character-sheet-spreadsheet)
- [Step 6 — Create the .env file](#step-6--create-the-env-file)
- [Step 7 — Install and start the bot](#step-7--install-and-start-the-bot)
- [Step 8 — Add the overlay to OBS](#step-8--add-the-overlay-to-obs)
- [Using it at the table](#-using-it-at-the-table)
- [Customizing the look and the sounds](#-customizing-the-look-and-the-sounds)
- [Keeping the bot online 24/7](#-keeping-the-bot-online-247-optional)
- [Common problems](#-common-problems)
- [File structure](#-file-structure)
- [Credits](#-credits)
- [License](#-license)

---
## 📸 What it looks like on stream/recording

Below you can see what the overlay looks like in OBS. Cards appear on screen in real time, along with sound effects.

**Rolls made natively by the bot:**
Automatically calculates the success level (Extreme, Hard, Regular, Failure or Fumble) and applies colors matching the Call of Cthulhu 7th edition results, including support for Advantage and Disadvantage.

![Example of rolls made with the bot](assets/preview1.png)

**How rolls show up on Discord:**

![Example of a roll on Discord](assets/preview2.png)

**Integration with the Rollem bot:**
If your table uses the Rollem bot for damage rolls or generic dice (like `1d20` or `3d6`), the overlay also captures and displays those results.

![Example of rolls with Rollem](assets/preview3.png)

**Example in a full stream layout:**

![Example in a full layout](assets/preview4.png)

---
## 🔄 How it works

```
  Google Sheets       ◄──reads sheets, reads/writes registrations──►   ┌─────────────┐
                                                                       │             │
  Discord (/roll, /register) ─────────────────────────────────────────►│   index.js  │
                                                                       │  (the bot)  │
  Rollem bot (loose rolls) ──────────────────────────────────────────► │             │
                                                                       └──────┬──────┘
                                                                              │ WebSocket (port 8080)
                                                                              ▼
                                              overlayOBS.html  ──►  your OBS stream
```

`index.js` runs on your computer (or a server). It talks to Discord and to Google (reading investigators' character sheets, and also reading/writing `/register` links to the Registrations tab), and relays every roll to `overlayOBS.html`, which you add to OBS as a browser source. **If `index.js` is off, the overlay stays empty.**

---

## ✨ What the bot does

| Feature | Description |
|---|---|
| **Character sheets in Google Sheets** | Reads attributes (STR, DEX, INT, CON, APP, POW, SIZ, EDU), Luck, Sanity, and every skill straight from the spreadsheet. |
| **`/register`** | Links the Discord player to their character sheet tab. The link is saved in the spreadsheet itself and survives restarts and deploys. |
| **`/roll`** | Rolls the skill with autocomplete and already calculates the success level. |
| **CoC 7e rules** | Critical Success (01), Extreme Success (⅕), Hard (½), Regular, Failure and Fumble. |
| **Advantage / Disadvantage** | Rolls an extra tens die and uses the best (or worst) result. |
| **OBS overlay** | Animated card on screen, colored according to the result. |
| **Automatic sounds** | Dice sound on every roll, plus a special sound on a critical success and on a fumble. |
| **Rollem support** | Rolls made by the Rollem bot also show up on the overlay. |
| **Roll history** | Keeps the last ~1,000 rolls (`/roll` and Rollem) in a **Rolls** tab of the spreadsheet, with date, player, skill, target and result. |

---

## ✅ Before you start

You'll need:

- [ ] A computer running Windows, macOS or Linux
- [ ] A Discord server **where you're an administrator**
- [ ] A Google account
- [ ] OBS Studio installed (only for the overlay part)
- [ ] About 40 minutes

Along the way you'll write down **four secret values**. Keep a notepad open to paste each of them:

```
DISCORD_TOKEN = ...
GOOGLE_SERVICE_ACCOUNT_EMAIL = ...
GOOGLE_PRIVATE_KEY = ...
SPREADSHEET_ID = ...
```

> ⚠️ **Never post these values anywhere** — not in stream chat, not in screenshots, not on GitHub. Whoever has the Discord token or the Service Account's private key gets full control of your bot (and your spreadsheet).

---

## Step 1 — Install Node.js

Node.js is the program that runs the bot.

1. Go to **<https://nodejs.org/>**.
2. Download the version marked **LTS** (the recommended one, on the left).
3. Install it by clicking *Next* through to the end, without changing anything.
4. To check it worked, open a terminal:
   - **Windows:** press `Windows`, type `cmd`, open *Command Prompt*.
   - **macOS:** `Cmd + Space`, type `Terminal`.
5. Type the command below and press Enter:

```bash
node -v
```

If something like `v22.11.0` shows up, you're good. If it says "command not recognized," restart your computer and try again.

---

## Step 2 — Download the project

**Easy way (no Git):**

1. On the project's GitHub page, click the green **Code** button → **Download ZIP**.
2. Extract the ZIP into a folder you'll easily find, e.g. `C:\coc-bot` or `Documents/coc-bot`.

**With Git (if you already have Git installed):**

```bash
git clone https://github.com/YOUR-USERNAME/YOUR-REPO.git
cd YOUR-REPO
```

When it's done, your folder should contain:

```
index.js  overlayOBS.html  package.json  README.md  LICENSE
crit.mp3  falhacrit.mp3  diceroll1.mp3  diceroll2.mp3  diceroll3.mp3
Ficha_CoC_en.xlsx
```

> 💡 The sound file names (`falhacrit.mp3`, etc.) are kept exactly as they are in the source project — don't rename them, the code refers to them by these exact names (see [Customizing the look and the sounds](#-customizing-the-look-and-the-sounds)). The character-sheet template, `Ficha_CoC_en.xlsx`, is a fully English translation of the original — feel free to rename it once it's in your Google Drive, since the bot only reads what's written inside each tab, not the file's name.

---

## Step 3 — Create the bot on Discord

### 3.1 Create the application

1. Go to **<https://discord.com/developers/applications>** and log in.
2. Click **New Application**, give it a name (e.g. `Keeper`) and confirm.

### 3.2 Get the token

1. In the sidebar, click **Bot**.
2. Click **Reset Token** → **Yes, do it!** (confirm with your password if asked).
3. Click **Copy** and paste it into your notepad under `DISCORD_TOKEN`.

> The token is shown **only once**. If you lose it, just reset it again.

### 3.3 Turn on message-reading permission ⚠️

Still on the **Bot** tab, scroll to **Privileged Gateway Intents** and **enable**:

- [x] **MESSAGE CONTENT INTENT**
- [x] **SERVER MEMBERS INTENT**

Click **Save Changes**.

> Without *Message Content Intent* the bot **won't even start** — it exits with an error right at boot. This is the #1 error for first-time installers.

### 3.4 Invite the bot to your server

1. Sidebar → **OAuth2** → **URL Generator**.
2. Under **Scopes**, check: `bot` and `applications.commands`.
3. Under **Bot Permissions**, check: `Send Messages`, `Read Message History`, `Embed Links` and `View Channels`.
4. Copy the generated link at the bottom, paste it into your browser, pick your server and authorize.

---

## Step 4 — Create the Google Service Account

To read the spreadsheet and also write `/register` links back into it, the bot needs a Google **Service Account** (a kind of "robot account" with its own credentials).

1. Go to **<https://console.cloud.google.com/>** and log in.
2. At the top, click the project selector → **New Project** → give it a name → **Create**.
3. With the project selected, use the search bar at the top to find **Google Sheets API** and click **Enable**.
4. In the sidebar, go to **APIs & Services** → **Credentials**.
5. Click **Create Credentials** → **Service Account**.
6. Give it a name (e.g. `coc-bot`) and click **Done**. You can skip the role and user-access screens — they're not needed here.
7. In the list of service accounts, click the one you just created.
8. Go to the **Keys** tab → **Add Key** → **Create New Key** → format **JSON** → **Create**.
9. A `.json` file downloads automatically to your computer. Open it in a text editor (Notepad works) — inside it you'll find the two values you need:

```json
{
  "client_email": "coc-bot@your-project.iam.gserviceaccount.com",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----\n"
}
```

10. Copy the `client_email` value into your notepad under `GOOGLE_SERVICE_ACCOUNT_EMAIL`.
11. Copy the `private_key` value (quotes and `\n` included, exactly as written) into `GOOGLE_PRIVATE_KEY`.

> ⚠️ **Keep that `.json` file safe** — it grants read/write access to your spreadsheet, just like a password. Once you've copied both values into your `.env` (Step 6), you don't need to keep the file inside the project folder anymore — you can move it somewhere outside the repository. It should **never** go to GitHub (see the warning in Step 6 about `.gitignore`).

---

## Step 5 — Prepare the character-sheet spreadsheet

> 💡 **A ready-made character sheet template is included in this repository** (`Ficha_CoC_en.xlsx`), based on the one created by **Alan** 🏊‍♂️ and fully translated to English. It's **fully automatic**: Hit Points, Sanity, attributes and skills already come with the calculations built in — just duplicate it and fill in your investigator's data and the rest adjusts itself. Download the file, upload it to your Google Drive, open it with Google Sheets (right-click → *Open with* → *Google Sheets*) and follow from step 5.1 below to grant access.
>
> In some cases a minor visual glitch can show up on the attributes — a black line appearing on some cells for some reason — but it's purely cosmetic and doesn't affect the calculations or how the bot reads the sheet.

### 5.1 Grant access

**Don't use "Publish to web"** — that's a different thing.

1. Open your character-sheet spreadsheet in Google Sheets.
2. Click **Share** (top-right corner).
3. Under "General access", switch to **Anyone with the link** → permission **Editor**, since players need to edit their own character sheets (on different tabs of the same spreadsheet).
4. Click **Done**.

> 💡 This is already enough for the bot too: a Service Account is a Google account like any other, so the "anyone with the link → Editor" link also covers it — you don't need to share it again with its `client_email`. The exception is if your Google account is part of a Workspace (company/school) that blocks that kind of link sharing; in that case, also share it directly with the Service Account's email (the `client_email` from Step 4), with **Editor** permission.

### 5.2 Get the spreadsheet ID

Look at the spreadsheet's URL:

```
https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz123456/edit?usp=sharing
                                      └───────── this is the ID ───────┘
```

Copy **just the part between `/d/` and `/edit`** and paste it into your notepad under `SPREADSHEET_ID`.

### 5.3 How the spreadsheet needs to be organized (skip if using the provided one)

The bot doesn't use fixed cell positions (with one exception): it looks for text patterns within the range **A1 to P100** of each tab. Build your character sheets like this:

| What | How the bot finds it | Example |
|---|---|---|
| **One character sheet per tab** | Each spreadsheet tab = one investigator. The tab name is what shows up in `/register`. | tab `Character Sheet 1 (Arthur)` |
| **Character name** | A cell reading exactly `Name:` with the value up to 3 columns to the right. | `B3 = Name:` · `D3 = Arthur Wallace` |
| **Skills** | Text with the percentage in parentheses. The value sits 2 columns to the right (or 1, if the 2nd is empty). | `B12 = Psychology (10%)` · `D12 = 45` |
| **Attributes** | A cell with exactly `STR`, `DEX`, `INT`, `CON`, `APP`, `POW`, `SIZ` or `EDU`, value 1 column to the right. | `B5 = STR` · `C5 = 60` |
| **Luck** | A cell with exactly `Luck`, value 1 or 2 columns to the right. | `B9 = Luck` · `C9 = 55` |
| **Sanity** | Read from cell **M8**. If there's no number there, the bot looks for a `Current` label within the 3 rows below the word `Sanity`. | `M8 = 65` |

Things to watch out for:

- The **value** needs to be a real number, not text. `45` works; `45%` doesn't.
- The skill name is whatever's left after removing the parentheses — `Fighting (Brawl) (25%)` becomes **`Fighting (Brawl)`** in autocomplete.
- Nothing past column **P** or row **100** is read.
- The sheet is read **once**, on `/register`. Changed the spreadsheet? Just run `/register` again.

---

## Step 6 — Create the .env file

Inside the project folder (the same one as `index.js`), create a text file called **`.env`** — with the dot in front and **no** `.txt` at the end.

> **On Windows:** open Notepad, paste the content, click *Save As*, change "Save as type" to **All Files**, and type the name `.env`.

Content:

```env
DISCORD_TOKEN=paste_the_discord_token_here
GOOGLE_SERVICE_ACCOUNT_EMAIL=paste_the_service_account_client_email_here
GOOGLE_PRIVATE_KEY="paste_the_service_account_private_key_here"
SPREADSHEET_ID=paste_the_spreadsheet_id_here
```

No spaces around the `=`. The only one that takes quotes is `GOOGLE_PRIVATE_KEY` — it comes out of the `.json` (Step 4) split across multiple lines, but in `.env` it needs to be on **a single line**, in quotes, with the `\n` exactly as they appear in the original file (don't swap them for real line breaks). It should look like this:

```env
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----\n"
```

> If you're pushing the project to GitHub, make sure there's a `.gitignore` file containing the lines `.env` and `node_modules`. If you kept the Service Account's `.json` (Step 4) inside the project folder for convenience, add its name to `.gitignore` too — or better yet, move it outside the folder as soon as you've copied both values into `.env`.

---

## Step 7 — Install and start the bot

Open a terminal **inside the project folder**:

- **Windows:** open the folder in File Explorer, click the address bar, type `cmd` and press Enter.
- **macOS:** right-click the folder → *Services* → *New Terminal at Folder*.
- **Linux:** you're the one who doesn't need me to explain this

Then run:

```bash
npm install
```

This downloads the libraries (`discord.js`, `ws`, `google-spreadsheet`, `google-auth-library`, `dotenv`) and creates the `node_modules` folder. It takes a minute or two.

> If you get an error saying it couldn't find `package.json`, install manually:
> `npm install discord.js ws google-spreadsheet google-auth-library dotenv`

Now start the bot by typing:

```bash
node index.js
```

If everything's right, you'll see something like:

```
WebSocket server started — listening for overlay connections on port 8080.
Bot logged in as YourBot#1234!
Spreadsheet "CoC Sheets" loaded successfully!
Registrations loaded from the spreadsheet: 0 user → character link(s).
```

The very first time, the bot creates a **Registrations** tab in the spreadsheet on its own (with the `UserID` and `CharacterSheet` columns) to store `/register` links — you don't need to create that tab by hand. On later startups, you'll also see one line per already-registered character, like `Character sheet "Character Sheet 1 (Arthur)" re-synced.`, confirming players won't need to run `/register` again.

🎉 **The bot is running.** Leave this terminal window open — closing the terminal shuts the bot down.

If you only want the roll bot, you're all set. Check out [Using it at the table](#-using-it-at-the-table), how to [keep the bot online 24/7](#-keeping-the-bot-online-247-optional), or the [Common problems](#-common-problems) section if you ran into an issue.


## Step 8 — Add the overlay to OBS

### 8.1 Point the overlay at the right bot ⚠️

`overlayOBS.html` ships configured for a cloud server. Since you're running the bot on your own computer, you need to change that.

1. Open `overlayOBS.html` in Notepad (right-click → *Open with*).
2. Near the end of the file, find this line:

```javascript
const ws = new WebSocket('wss://coc-bot-nj88.onrender.com');
```

3. Replace it with:

```javascript
const ws = new WebSocket('ws://localhost:8080');
```

4. Save.

> Note: `ws://` (local, no "s") vs. `wss://` (cloud, with an "s"). Mixing these up is the most common cause of "the overlay isn't showing anything."

### 8.2 Add it in OBS

1. In OBS, under **Sources**, click **+** → **Browser**.
2. Give it a name (e.g. `CoC Rolls`) and click OK.
3. Check the **Local file** box.
4. Under **Local file**, click *Browse* and select `overlayOBS.html`.
5. Set **Width: 420** and **Height: 600** (adjust later to taste — the layout adapts).
6. Leave **Shutdown source when not visible** unchecked.
7. Check **Control audio via OBS** so the dice sounds go into the stream.
8. Click **OK** and position the overlay in your scene.

> The `.mp3` files need to be **in the same folder** as `overlayOBS.html`. Don't move the HTML file on its own to another location.

### 8.3 Test it

With the bot running, use `/roll` on Discord. The card should appear in OBS in under a second.

If nothing shows up: right-click the source → **Interact**, then **Refresh cache of current page**.

---

## 🎮 Using it at the table

### `/register`

Each player runs this once, at the start:

```
/register character: Character Sheet 1 (Arthur)
```

The field autocompletes with the spreadsheet's tab names. The reply is private (only the player sees it).

> The link is saved in a **Registrations** tab (columns `UserID` and `CharacterSheet`) that the bot creates in the spreadsheet by itself, if it doesn't exist yet. Because it lives in the spreadsheet (not on the bot's disk), the link survives restarts, crashes, and even a new deploy — nobody needs to run `/register` again after that. Avoid deleting or renaming that tab by hand; if that happens, the bot creates a new blank one and players will need to register again.

### `/roll`

```
/roll skill: Psychology
/roll skill: Dodge  advantage: Advantage (Bonus)
```

The `skill` field suggests everything the bot read from that player's sheet — skills, attributes, Luck and Sanity.

### Results table

| Roll result | Status | Overlay color |
|---|---|---|
| Exactly **01** | Critical Success | 🟢 green + special sound |
| ≤ ⅕ of the skill value | Extreme Success | 🟠 default |
| ≤ ½ of the value | Hard Success | 🟠 default |
| ≤ skill value | Regular Success | 🟠 default |
| Above the value | Failure | 🟠 default |
| **100**, or 96–99 with a skill below 50 | Fumble | 🔴 red + special sound |

**Advantage** rolls an extra tens die and keeps the lower total. **Disadvantage** keeps the higher one.

### 📜 Roll history (the "Rolls" tab)

Every roll — from both `/roll` and Rollem — gets logged to a **Rolls** tab that the bot creates by itself in the spreadsheet on the first roll (same as with the Registrations tab). Columns: `Date`, `Player`, `Skill`, `Target`, `Result`, `Status`.

The bot only keeps the **last ~1,000 rows**: once the tab passes that limit, the oldest rows are deleted automatically in batches (to avoid spending an extra spreadsheet write on every single roll just to keep the count exact — see the comments above `ROLL_HISTORY_MAX` in `index.js` if you want to tune this). You don't need to do anything — just don't delete or rename the tab by hand (if you do, the bot creates a new blank one and the previous history is lost).

> The write happens in parallel, without delaying the `/roll` reply on Discord or the send to the overlay. If something goes wrong while writing (e.g. the spreadsheet lost its permission), it only shows up in the bot's log — it never breaks the roll or the stream.

### Rolls via Rollem

If the **Rollem** bot is in your server, any roll it makes (`2d6+3`, `1d100`, etc.) also shows up on the overlay, in a simpler format. The name shown is the server nickname of whoever asked for the roll.

> This works because the bot looks for messages from a user whose username is exactly `rollem`. If you use a different dice bot, you'll need to edit that line in `index.js`.

---

## 🎨 Customizing the look and the sounds

Everything lives in `overlayOBS.html`, near the top of the file:

```css
:root {
    --color-normal: #ffb648;   /* regular roll */
    --color-crit:   #2ee673;   /* critical success */
    --color-fail:   #ff4d5e;   /* fumble */
    --color-text:   #f2f2f2;
    --color-bg:     rgba(20, 20, 22, 0.92);  /* last number = transparency */
}
```

How many cards stay on screen at once (default: 6):

```javascript
const maxMessages = 6;
```

**Swapping the sounds:** replace the `.mp3` files while keeping the exact same names (`diceroll1.mp3`, `diceroll2.mp3`, `diceroll3.mp3`, `crit.mp3`, `falhacrit.mp3`). Volume is set in `playSound(rollSound, 0.8)` — swap `0.8` for a value between `0` and `1`.

---

## ☁️ Keeping the bot online 24/7 (optional)

Running on your PC, the bot dies along with your computer. To keep it always on, use a hosting service like [Render](https://render.com/).

**Before deploying, edit `index.js`.** Right now the port is hardcoded:

```javascript
const wss = new WebSocket.Server({ port: 8080 });
```

Cloud services require the program to use whatever port **they** assign. Replace it with:

```javascript
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });
```

That way it still uses 8080 on your machine and the right port in the cloud.

Then:

1. Push the project to a GitHub repository (**without `.env`**).
2. On Render, create a **Web Service** connected to that repository.
3. Under *Build Command* use `npm install`, and under *Start Command* use `node index.js`.
4. Under **Environment**, add `DISCORD_TOKEN`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY` and `SPREADSHEET_ID` as variables (paste `GOOGLE_PRIVATE_KEY` with the literal `\n`s, same as in `.env`).
5. After deploying, Render gives you an address. In `overlayOBS.html`, use that address with `wss://`:

```javascript
const ws = new WebSocket('wss://your-app.onrender.com');
```

> On Render's free tier, the service sleeps after a period of inactivity and takes a few seconds to wake up on the first roll.

---

## 🔧 Common problems

| Symptom | Likely cause | Fix |
|---|---|---|
| `Used disallowed intents` on startup | Privileged intents are off | Go back to [Step 3.3](#33-turn-on-message-reading-permission-) and enable *Message Content* and *Server Members*. |
| `An invalid token was provided` | Wrong token or extra whitespace | Reset the token in the Developer Portal and paste it into `.env` again. |
| The bot starts, but `/roll` doesn't show up on Discord | Commands still propagating | Wait a few minutes and restart the Discord app (`Ctrl + R`). |
| `The caller does not have permission` | The spreadsheet isn't shared with the Service Account | Step 5.1: link set to **Editor**, or share directly with the Service Account's `client_email`. |
| `Google Sheets API has not been used...` or similar | Sheets API not enabled on the right Google Cloud project | Step 4, item 3. |
| `error:...DECODER routines` or `Invalid PEM formatted message` on startup | `GOOGLE_PRIVATE_KEY` pasted incorrectly into `.env` | Review Step 6: the key needs to be in quotes, on a single line, with literal `\n`s (not swapped for real line breaks). |
| `Couldn't find a tab containing "..."` | Typed name ≠ tab name | Use `/register`'s autocomplete instead of typing it out. |
| A player who's already registered needs to run `/register` again | The **Registrations** tab was deleted/renamed, or the spreadsheet lost Editor permission for the Service Account | Check that the "Registrations" tab still exists and that sharing (Step 5.1) is still set to Editor. |
| Registered, but no skills show up in `/roll` | Spreadsheet not in the expected format | Review [Step 5.3](#53-how-the-spreadsheet-needs-to-be-organized-skip-if-using-the-provided-one). Values need to be numbers. |
| Overlay is blank in OBS | Wrong WebSocket address, or the bot is off | Step 8.1 (`ws://localhost:8080`) and check the terminal is still running. |
| Cards show up, but no sound | Audio isn't routed | Check *Control audio via OBS* and, in *Mixer → Advanced Audio Properties*, that monitoring is on. |
| `EADDRINUSE: port 8080` | A bot is already running | Close the other terminal window. |
| `Error: No key or keyFile set.` (bot crashes, `Exited with status 1`) | `GOOGLE_PRIVATE_KEY` missing, empty, or misnamed in the cloud service's Environment Variables | Check the variables on the right service (not an empty Env Group) and re-add both `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_PRIVATE_KEY` — it's common to be missing just one of the two. |
| `Service account key creation is disabled` / `iam.disableServiceAccountKeyCreation` on Google Cloud | Google's default security policy blocking Service Account keys | Disable the policy under **IAM & Admin → Organization Policies** (see the same section above) and try generating the key again. |
| Can't find "Environment Variables" in Render's menu | Projects layout changed, or it's not in the side menu | Go directly to `https://dashboard.render.com/web/YOUR_SERVICE_ID/env` (the Service ID is at the top of the service's page). |

**Seeing the overlay's error console:** right-click the browser source → **Interact** → the `F12` key opens the console with the error messages.

---

## 📁 File structure

```
├── index.js           # the bot: Discord, Google Sheets (read and write), and the WebSocket server
├── overlayOBS.html    # the overlay that goes in OBS (HTML, CSS and JS in a single file)
├── Ficha_CoC_en.xlsx  # automatic character-sheet template (English version, based on Alan's original) — HP, Sanity and skills calculate themselves
├── package.json       # dependency list
├── .env               # your secret keys (you create this, never push it to GitHub)
├── crit.mp3           # critical-success sound
├── falhacrit.mp3      # fumble sound
└── diceroll1-3.mp3    # roll sounds (randomly picked each time)
```

🆘 Need help?
---

Got stuck during setup, the bot won't start, or a weird error showed up in the terminal? Don't worry, this project was built to be accessible and I'm here to help!

You can report an issue in two ways:

Open an Issue (recommended): Go to the Issues tab at the top of this GitHub repo, click the green New Issue button, and describe what went wrong. If you can, paste the error message from your terminal or attach a screenshot.

Direct contact: If you'd rather, you can reach out to me directly on social media, or say hi at [Narrativa RPG](https://linktr.ee/NarrativaRPG).

Feel free to ask — the whole point of this tool is to make life easier for everyone at the table (even if it makes the install a bit harder)!



---

## 🏊‍♂️ Credits

- **Alan** — created the original investigator sheet template used by this project (translated to English here as `Ficha_CoC_en.xlsx`). It's fully automatic: it fills in Hit Points, Sanity, attributes and skills on its own from the character's basic data, with no formulas to touch.

---

## 📜 License

Distributed under **AGPL-3.0** (GNU Affero General Public License v3.0). Anyone can use, copy, modify and redistribute the code freely, including commercially, as long as:

- any modified version continues to be distributed as open source, under the same license;
- if the code (or a modified version) is used to offer a service accessible over a network — such as running this bot on a server for other people to use — the corresponding source code is also made available to the users of that service.

In other words: you can't take the project, modify it, and close it off — not even by just running it as a service. The full text is in the [`LICENSE`](LICENSE) file.
