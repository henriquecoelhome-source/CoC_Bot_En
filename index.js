require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const WebSocket = require('ws');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// ---------------------------------------------------------------------
// WebSocket server — the event channel for the OBS overlay.
// Every roll detected (via /roll or by watching the "rollem" bot) is
// relayed in real time to whatever clients are connected on this port.
// ---------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });
console.log(`WebSocket server started — listening for overlay connections on port ${PORT}.`);

// ---------------------------------------------------------------------
// Event history — a small buffer of the last rolls that were broadcast.
// Without this, an event only ever reaches whoever was already connected
// at the exact moment of the broadcast: if the overlay drops and
// reconnects (network hiccup, OBS browser-source reload, etc.), anything
// that happened in between is lost, because the server never kept
// anything around, it just relayed. On connect, the overlay now gets
// this backlog sent to it all at once.
// ---------------------------------------------------------------------
const HISTORY_BUFFER_MAX = 6; // same value as maxMessages in the overlay
let eventHistoryBuffer = [];

function broadcastEvent(event) {
    eventHistoryBuffer.push(event);
    if (eventHistoryBuffer.length > HISTORY_BUFFER_MAX) eventHistoryBuffer.shift();

    wss.clients.forEach(wsClient => {
        if (wsClient.readyState === WebSocket.OPEN) {
            wsClient.send(JSON.stringify(event));
        }
    });

    // Writes to the persistent spreadsheet history (the "Rolls" sheet) in
    // parallel. No `await` here on purpose: this is a synchronous function
    // called from places where we don't want to delay either the overlay
    // broadcast or the Discord command reply — the write runs in the
    // background, and any error just goes to the log (see the function).
    recordRollInHistory(event);
}

wss.on('connection', (ws) => {
    if (eventHistoryBuffer.length > 0) {
        ws.send(JSON.stringify({ type: 'history', events: eventHistoryBuffer }));
    }
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// ---------------------------------------------------------------------
// Google Sheets integration — the data source for character sheets, and
// now also where user → character links get saved.
//
// Authentication used to be just an API key, which is read-only. To
// write data back to the spreadsheet (the registration persistence,
// right below) the bot needs a Google Service Account with edit
// permission — the credentials come from environment variables, never
// hardcoded here. See the README for the step-by-step on generating
// those credentials and sharing the spreadsheet with the Service
// Account.
// ---------------------------------------------------------------------
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

// userCharacters:      maps a Discord user ID to their linked character sheet (tab).
// characterCache:      cache of the attributes/skills already read from each sheet.
// characterNameCache:  cache of the character's name, extracted from the sheet itself.
const userCharacters = {};
const characterCache = {};
const characterNameCache = {};

// ---------------------------------------------------------------------
// Persistence of user → character links (the /register command).
//
// userCharacters used to live only in memory (the process's RAM): any
// restart of the Node process wiped it out without a trace — including
// every new deploy on Render, since local disk there is ephemeral (it
// disappears on every redeploy, not just when the service sleeps). So
// these links now live in their own sheet tab ("Registrations"), which
// is external to the server: it survives any redeploy, crash, or sleep
// cycle, because it doesn't depend on the bot's disk.
//
// NOTE ON COMPATIBILITY: this English build uses its own sheet-tab
// names and column headers (see the constants below), separate from
// the Portuguese production build ('Registros' / 'Rolagens'). If you
// point this file at a spreadsheet that a Portuguese build already
// wrote to, change REGISTRATIONS_SHEET_TITLE and ROLL_HISTORY_SHEET_TITLE
// back to the original Portuguese names first — otherwise this build
// will create new, empty tabs instead of reusing the existing data.
// ---------------------------------------------------------------------
const REGISTRATIONS_SHEET_TITLE = 'Registrations';

async function getOrCreateRegistrationsSheet() {
    let sheet = doc.sheetsByTitle[REGISTRATIONS_SHEET_TITLE];
    if (!sheet) {
        sheet = await doc.addSheet({ title: REGISTRATIONS_SHEET_TITLE, headerValues: ['UserID', 'CharacterSheet'] });
        console.log(`Sheet "${REGISTRATIONS_SHEET_TITLE}" created in the spreadsheet.`);
    }
    return sheet;
}

async function loadRegistrations() {
    try {
        const sheet = await getOrCreateRegistrationsSheet();
        const rows = await sheet.getRows();
        for (const row of rows) {
            const userId = row.get('UserID');
            const characterSheet = row.get('CharacterSheet');
            if (userId && characterSheet) userCharacters[userId] = characterSheet;
        }
        console.log(`Registrations loaded from the spreadsheet: ${Object.keys(userCharacters).length} user → character link(s).`);
    } catch (e) {
        console.error('Error loading registrations from the spreadsheet:', e);
    }
}

async function saveRegistration(userId, characterSheet) {
    try {
        const sheet = await getOrCreateRegistrationsSheet();
        const rows = await sheet.getRows();
        const existing = rows.find(r => r.get('UserID') === userId);
        if (existing) {
            existing.set('CharacterSheet', characterSheet);
            await existing.save();
        } else {
            await sheet.addRow({ UserID: userId, CharacterSheet: characterSheet });
        }
    } catch (e) {
        console.error('Error saving registration to the spreadsheet:', e);
    }
}

// ---------------------------------------------------------------------
// Persistent roll history (the "Rolls" sheet).
//
// `eventHistoryBuffer` above is a different thing: a small buffer (6
// items) just to resend the latest rolls to whoever just connected to
// the overlay, and it's lost on every bot restart because it only lives
// in RAM. This section is the real history — every roll (/roll and
// Rollem) is written to its own sheet tab, the same way the
// "Registrations" tab works, so it survives restarts, crashes, and
// redeploys.
//
// To keep the tab from growing forever, the bot only keeps the last
// ROLL_HISTORY_MAX rows. Cleanup runs in batches of
// ROLL_HISTORY_CLEANUP_BATCH instead of deleting one row every single
// roll — that avoids spending an extra API call on every /roll just to
// keep the total exactly round (the Google Sheets API has a
// requests-per-minute quota, and that adds up fast at a lively table).
// In practice the tab can sit a little above the limit for a moment (up
// to +ROLL_HISTORY_CLEANUP_BATCH rows) between one cleanup and the
// next — which makes no practical difference for a roll history.
// ---------------------------------------------------------------------
const ROLL_HISTORY_SHEET_TITLE = 'Rolls';
const ROLL_HISTORY_MAX = 1000; // lower this if the spreadsheet gets too heavy
const ROLL_HISTORY_CLEANUP_BATCH = 50; // deleted in blocks, not row by row

let rollHistoryRowCount = 0; // in-memory count — avoids re-reading the whole sheet on every roll

async function getOrCreateRollHistorySheet() {
    let sheet = doc.sheetsByTitle[ROLL_HISTORY_SHEET_TITLE];
    if (!sheet) {
        sheet = await doc.addSheet({
            title: ROLL_HISTORY_SHEET_TITLE,
            headerValues: ['Date', 'Player', 'Skill', 'Target', 'Result', 'Status'],
        });
        console.log(`Sheet "${ROLL_HISTORY_SHEET_TITLE}" created in the spreadsheet.`);
    }
    return sheet;
}

/**
 * Reads the history sheet exactly once, at bot startup, just to find out
 * how many rows already exist. After that the count is kept purely in
 * memory (incremented on every write, decremented on every cleanup), so
 * the bot never has to re-read the whole sheet again just to know its
 * size — that's what lets it decide "do I need to clean up?" without
 * spending a read call on every single roll.
 */
async function initRollHistoryRowCount() {
    try {
        const sheet = await getOrCreateRollHistorySheet();
        const rows = await sheet.getRows();
        rollHistoryRowCount = rows.length;
        console.log(`Roll history loaded: ${rollHistoryRowCount} row(s) in the "${ROLL_HISTORY_SHEET_TITLE}" sheet.`);
    } catch (e) {
        console.error('Error initializing the roll history:', e);
    }
}

/**
 * Deletes the oldest overflow in one batch, once the sheet goes past
 * ROLL_HISTORY_MAX + ROLL_HISTORY_CLEANUP_BATCH rows. The oldest rows
 * are always the ones at the top of the sheet (right below the header),
 * so we just grab the first `overflow` rows.
 *
 * Deletes back-to-front within the batch (from the last fetched row to
 * the first): deleting a row shifts up only the rows below it in the
 * sheet, so deleting from the "lowest" row to the "highest" avoids the
 * row numbers of the rows we already fetched going stale partway
 * through.
 */
async function trimRollHistoryIfNeeded(sheet) {
    const overflow = rollHistoryRowCount - ROLL_HISTORY_MAX;
    if (overflow < ROLL_HISTORY_CLEANUP_BATCH) return;

    try {
        const oldRows = await sheet.getRows({ offset: 0, limit: overflow });
        for (let i = oldRows.length - 1; i >= 0; i--) {
            await oldRows[i].delete();
            rollHistoryRowCount--;
        }
        console.log(`Roll history: removed ${oldRows.length} old row(s) (limit: ${ROLL_HISTORY_MAX}).`);
    } catch (e) {
        console.error('Error cleaning up old roll history:', e);
    }
}

/**
 * Writes one row for the received event into the history sheet. Works
 * both for structured /roll events ("command", with skill, target and
 * status as separate fields) and for raw rolls captured from the Rollem
 * bot (which have no skill/target/status — just the original text).
 *
 * Called from `broadcastEvent` without `await` on purpose (see the
 * comment there) — errors here should never take down a roll, so they
 * only go to the log.
 */
async function recordRollInHistory(event) {
    try {
        const sheet = await getOrCreateRollHistorySheet();

        const rowData = {
            Date: new Date().toLocaleString('en-US'),
            Player: event.player || '',
            Skill: event.skill || '',
            Target: event.target !== undefined ? event.target : '',
            Result: event.type === 'command' ? event.value : (event.result || ''),
            Status: event.status || (event.event === 'crit' ? 'Critical' : event.event === 'fail' ? 'Fumble' : ''),
        };

        await sheet.addRow(rowData);
        rollHistoryRowCount++;
        await trimRollHistoryIfNeeded(sheet);
    } catch (e) {
        console.error('Error writing the roll to the spreadsheet history:', e);
    }
}

/**
 * Rebuilds, from a row in the "Rolls" sheet, the same event shape that
 * `broadcastEvent` normally receives — used to repopulate
 * `eventHistoryBuffer` (the in-RAM buffer) from what's already saved in
 * the spreadsheet as soon as the bot starts up. Without this, a process
 * restart (redeploy, crash, sleep cycle on Render) resets the in-memory
 * buffer, and the overlay only sees history again once new rolls start
 * happening — even though the spreadsheet already has it all stored.
 *
 * The "command" (/roll) vs "rollem" (third-party bot) distinction is
 * made by the presence of the Skill column, which only /roll rolls fill in.
 */
function eventFromHistoryRow(row) {
    const player = row.get('Player') || '';
    const skill = row.get('Skill') || '';
    const target = row.get('Target');
    const result = row.get('Result') || '';
    const status = row.get('Status') || '';

    if (skill) {
        // Structured /roll event: the Status column holds the raw result
        // text ("CRITICAL SUCCESS (01)", "FUMBLE", "...SUCCESS"), not
        // 'crit'/'fail' directly (see recordRollInHistory) — so the event
        // type is inferred from that text.
        let event = 'normal';
        if (/critical/i.test(status)) event = 'crit';
        else if (/fumble/i.test(status)) event = 'fail';

        return {
            type: 'command',
            player,
            skill,
            target,
            value: result,
            status,
            advantage: '',
            event,
        };
    }

    // Raw roll from the "rollem" bot: here the Status column already
    // holds 'Critical' / 'Fumble' / '' directly.
    let event = 'normal';
    if (status === 'Critical') event = 'crit';
    else if (status === 'Fumble') event = 'fail';

    return { type: 'rollem', player, result, event };
}

/**
 * Repopulates `eventHistoryBuffer` with the last HISTORY_BUFFER_MAX rolls
 * already saved in the "Rolls" sheet, read directly from the spreadsheet
 * (offset by the total row count already counted in
 * initRollHistoryRowCount, so there's no need to re-read the whole
 * sheet). Called once, at bot startup — after that the buffer is
 * maintained normally by `broadcastEvent` on every new roll.
 */
async function loadRecentHistoryFromSheet() {
    try {
        const sheet = await getOrCreateRollHistorySheet();
        const offset = Math.max(0, rollHistoryRowCount - HISTORY_BUFFER_MAX);
        const rows = await sheet.getRows({ offset, limit: HISTORY_BUFFER_MAX });
        eventHistoryBuffer = rows.map(eventFromHistoryRow);
        console.log(`Overlay history buffer repopulated with ${eventHistoryBuffer.length} roll(s) from the spreadsheet.`);
    } catch (e) {
        console.error('Error repopulating the overlay history from the spreadsheet:', e);
    }
}

/**
 * Reads the `sheetTitle` tab and extracts attributes, skills, Luck,
 * Sanity and the character's name, populating characterCache /
 * characterNameCache.
 *
 * Extraction is done by recognizing text patterns (labels and markers
 * like "%"), not by fixed cell position — this makes reading resilient
 * to small layout differences between character sheets.
 *
 * @param {string} sheetTitle - Title of the tab for this character sheet.
 * @returns {Promise<boolean>} true if the sync completed successfully.
 */
async function syncCharacter(sheetTitle) {
    try {
        const sheet = doc.sheetsByTitle[sheetTitle];
        if (!sheet) return false;

        await sheet.loadCells('A1:R100');
        const stats = {};

        // "Current Sanity" has a fixed position on this sheet (cell M8).
        const sanityCell = sheet.getCell(7, 12); // row 8, column M (0-indexed)
        if (typeof sanityCell.value === 'number') {
            stats['Sanity'] = sanityCell.value;
        }

        // Skills follow the pattern "Name (xx%)" — e.g. "Fighting (Brawl) (25%)",
        // "Psychology (10%)", "Dodge (half DEX%)". We identify the cell by
        // this text pattern (rather than by position/column), since
        // attributes (STR, DEX...) and other fields don't follow this
        // notation.
        const skillPatternTest = /\([^()]*%[^()]*\)/;
        const skillPatternStrip = /\([^()]*%[^()]*\)/g;

        // Attributes: a cell whose value matches exactly one of these
        // abbreviations — STR/DEX/INT/CON/APP/POW/SIZ/EDU — matching what's
        // printed on this build's English character sheet template
        // (Ficha_CoC_en.xlsx). Change this pattern if your own sheet
        // template uses different abbreviations.
        const attributePattern = /^(STR|DEX|INT|CON|APP|POW|SIZ|EDU)$/i;

        for (let r = 0; r < 100; r++) {
            for (let c = 0; c < 16; c++) {
                const cell = sheet.getCell(r, c);
                if (typeof cell.value !== 'string') continue;

                const cellText = cell.value.replace(/\n/g, ' ').trim();
                if (!cellText) continue;

                // Character name: the label "Name:" occupies one cell and
                // the value (in a merged cell, e.g. D3:F3) sits offset to
                // the right. We try a few offsets until we find a
                // non-empty string.
                if (/^name:?$/i.test(cellText)) {
                    for (const offset of [1, 2, 3]) {
                        const valueCell = sheet.getCell(r, c + offset);
                        if (valueCell && typeof valueCell.value === 'string' && valueCell.value.trim()) {
                            characterNameCache[sheetTitle] = valueCell.value.trim();
                            break;
                        }
                    }
                    continue;
                }

                // Skills
                if (skillPatternTest.test(cellText)) {
                    const statName = cellText
                        .replace(skillPatternStrip, '')
                        .replace(/\s+/g, ' ')
                        .trim();

                    if (statName) {
                        // The skill's value is usually 2 columns to the right
                        // of the name (the in-between cell is empty due to
                        // merging). If not found, try 1 column to the right
                        // as a fallback.
                        let value;
                        for (const offset of [2, 1]) {
                            const valueCell = sheet.getCell(r, c + offset);
                            if (valueCell && typeof valueCell.value === 'number') {
                                value = valueCell.value;
                                break;
                            }
                        }
                        if (value !== undefined) stats[statName] = value;
                    }
                    continue;
                }

                // Attributes (STR, DEX, INT, CON, APP, POW, SIZ, EDU)
                if (attributePattern.test(cellText)) {
                    const valueCell = sheet.getCell(r, c + 1);
                    if (valueCell && typeof valueCell.value === 'number') {
                        stats[cellText.toUpperCase()] = valueCell.value;
                    }
                    continue;
                }

                // Luck
                if (/^luck$/i.test(cellText)) {
                    for (const offset of [1, 2]) {
                        const valueCell = sheet.getCell(r, c + offset);
                        if (valueCell && typeof valueCell.value === 'number') {
                            stats['Luck'] = valueCell.value;
                            break;
                        }
                    }
                    continue;
                }

                // Sanity: "Sanity" is just the section title; the
                // "Current" value sits on one of the rows right below it
                // (the same "Current" label also appears in the Hit
                // Points and Magic Points sections, which is why the
                // search is restricted to the immediate neighborhood of
                // the title).
                if (/^sanity$/i.test(cellText) && !stats['Sanity']) {
                    for (let r2 = r + 1; r2 <= r + 3 && r2 < 100 && !stats['Sanity']; r2++) {
                        for (let c2 = 0; c2 < 16; c2++) {
                            const labelCell = sheet.getCell(r2, c2);
                            if (typeof labelCell.value === 'string' && /^current$/i.test(labelCell.value.trim())) {
                                const valueCell = sheet.getCell(r2, c2 + 1);
                                if (valueCell && typeof valueCell.value === 'number') {
                                    stats['Sanity'] = valueCell.value;
                                    break;
                                }
                            }
                        }
                    }
                    continue;
                }
            }
        }
        characterCache[sheetTitle] = stats;
        return true;
    } catch (e) {
        console.error("Error syncing character sheet:", e);
        return false;
    }
}

client.once('ready', async () => {
    console.log(`Bot logged in as ${client.user.tag}!`);
    await doc.loadInfo();
    console.log(`Spreadsheet "${doc.title}" loaded successfully!`);

    // Restores the user → character links saved in the spreadsheet and
    // re-syncs the cache for each character sheet involved, so /roll
    // already works without anyone needing to run /register again after
    // a restart.
    await loadRegistrations();
    const sheetsToResync = new Set(Object.values(userCharacters));
    for (const sheetTitle of sheetsToResync) {
        const ok = await syncCharacter(sheetTitle);
        console.log(ok ? `Character sheet "${sheetTitle}" re-synced.` : `Failed to re-sync "${sheetTitle}".`);
    }

    // Finds out how many rows already exist in the "Rolls" sheet
    // (creating the sheet if it doesn't exist yet), so batch cleanup
    // already knows whether it needs to run as soon as new rolls start
    // coming in.
    await initRollHistoryRowCount();

    // Repopulates the in-RAM buffer (eventHistoryBuffer) with what was
    // already saved in the spreadsheet, so that an overlay connecting
    // right after a bot restart already gets the recent history — not
    // just rolls that happen after the process comes back up.
    await loadRecentHistoryFromSheet();

    const commands = [
        new SlashCommandBuilder()
            .setName('register')
            .setDescription('Links your account to a character sheet.')
            .addStringOption(opt => opt.setName('character').setDescription('Character name').setRequired(true).setAutocomplete(true)),
        new SlashCommandBuilder()
            .setName('roll')
            .setDescription('Rolls a skill or attribute (Automatic)')
            .addStringOption(opt => opt.setName('skill').setDescription('What to roll?').setRequired(true).setAutocomplete(true))
            .addStringOption(opt => opt.setName('advantage').setDescription('Bonus or Penalty?').setRequired(false)
                .addChoices({ name: 'Advantage (Bonus)', value: 'ADV' }, { name: 'Disadvantage (Penalty)', value: 'DIS' }))
    ];

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
});

// =====================================================================
// SOURCE 1 — Watching rolls from the "rollem" bot
//
// The bot listens to that third-party bot's messages in the channel,
// parses the roll text (1d100, multiple rolls, bracket notation) and
// classifies the result as critical, fumble, or normal before relaying
// the event to the overlay.
// =====================================================================
client.on('messageCreate', async (message) => {
  // "rollem" is the actual Discord username of the third-party dice bot
  // being observed — keep this literal string as-is; it's not something
  // to translate, it has to match that bot's real username.
  if (message.author.username !== 'rollem') return;

  let player = "Investigator";
  if (message.reference && message.reference.messageId) {
    try {
      const originalMessage = await message.channel.messages.fetch(message.reference.messageId);
      let member = originalMessage.member;

      // The fetched message doesn't always come with the member embedded
      // (e.g. a stale cache). In that case, fetch the member directly from
      // the guild to show the server nickname instead of the global
      // Discord username.
      if (!member && message.guild) {
        try {
          member = await message.guild.members.fetch(originalMessage.author.id);
        } catch (memberError) {
          console.error("Member not found in the guild — falling back to the Discord username.");
        }
      }

      player = member ? member.displayName : originalMessage.author.displayName;
    } catch (error) {
      console.error("Failed to fetch the original message for the author of the roll.");
    }
  }

  const originalText = message.content;
  const cleanText = originalText.replace(/[*_~`]/g, '');
  let eventType = 'normal';
  const diceMatch = cleanText.match(/(?:(\d+)\s*#\s*)?(\d*)\s*d(\d+)/i);

  if (diceMatch) {
    const diceCount = parseInt(diceMatch[2] || "1");
    const faces = parseInt(diceMatch[3]);

    if (faces === 100) {
      let rolledValues = [];
      const bracketMatch = cleanText.match(/\[([\d,\s]+)\]/);

      if (bracketMatch) {
        rolledValues = bracketMatch[1].split(',').map(n => parseInt(n.trim()));
      } else {
        const afterEquals = cleanText.includes('=') ? cleanText.split('=').pop() : cleanText;
        const numbers = afterEquals.replace(/[^0-9,]/g, '').split(',').filter(Boolean);
        rolledValues = numbers.map(n => parseInt(n.trim()));
      }

      if (rolledValues.length > 0 && diceCount === 1) {
        const finalValue = Math.max(...rolledValues);
        if (finalValue === 1) eventType = 'crit';
        if (finalValue === 100) eventType = 'fail';
      }
    }
  }

  broadcastEvent({ type: 'rollem', player: player, result: originalText, event: eventType });
});

// =====================================================================
// SOURCE 2 — Slash commands (/register and /roll)
// =====================================================================
client.on('interactionCreate', async interaction => {
    if (interaction.isAutocomplete() && interaction.commandName === 'roll') {
        const userId = interaction.user.id;
        const characterSheet = userCharacters[userId];
        if (!characterSheet || !characterCache[characterSheet]) return await interaction.respond([]);

        const focused = interaction.options.getFocused();
        const skills = Object.keys(characterCache[characterSheet]);
        const filtered = skills.filter(s => s.toLowerCase().includes(focused.toLowerCase())).slice(0, 25);
        await interaction.respond(filtered.map(s => ({ name: s, value: s })));
    }

    if (interaction.isAutocomplete() && interaction.commandName === 'register') {
        const focused = interaction.options.getFocused().toLowerCase();
        const characterSheets = doc.sheetsByIndex.map(s => s.title);
        const filtered = characterSheets
            .filter(t => t.toLowerCase().includes(focused))
            .slice(0, 25);
        await interaction.respond(filtered.map(t => ({ name: t, value: t })));
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'register') {
        await interaction.deferReply({ ephemeral: true });
        const search = interaction.options.getString('character').toLowerCase();
        const sheet = doc.sheetsByIndex.find(s => s.title.toLowerCase().includes(search));

        if (!sheet) return interaction.editReply(`Couldn't find a tab containing "${search}".`);

        const success = await syncCharacter(sheet.title);
        if (success) {
            userCharacters[interaction.user.id] = sheet.title;
            await saveRegistration(interaction.user.id, sheet.title);
            interaction.editReply(`Account successfully linked to **${sheet.title}**!`);
        } else {
            interaction.editReply(`Error reading character sheet **${sheet.title}**.`);
        }
    }

    if (interaction.commandName === 'roll') {
        const userId = interaction.user.id;
        const characterSheet = userCharacters[userId];

        if (!characterSheet) return interaction.reply({ content: 'Use `/register [name]` first.', ephemeral: true });

        const skillName = interaction.options.getString('skill');
        const advantage = interaction.options.getString('advantage');
        const baseValue = characterCache[characterSheet][skillName];

        if (baseValue === undefined) return interaction.reply({ content: `Skill **${skillName}** not found.`, ephemeral: true });

        const onesDigit = Math.floor(Math.random() * 10);
        const tensDiceCount = (advantage === 'ADV' || advantage === 'DIS') ? 2 : 1;
        const tensRolls = [];
        for (let i = 0; i < tensDiceCount; i++) tensRolls.push(Math.floor(Math.random() * 10));

        const possibleTotals = tensRolls.map(tens => {
            let t = (tens * 10) + onesDigit;
            if (t === 0) return 100;
            return t;
        });

        let finalTotal;
        if (advantage === 'ADV') finalTotal = Math.min(...possibleTotals);
        else if (advantage === 'DIS') finalTotal = Math.max(...possibleTotals);
        else finalTotal = possibleTotals[0];

        const goodValue = Math.floor(baseValue / 2);
        const extremeValue = Math.floor(baseValue / 5);
        const isFumble = (finalTotal >= 96 && baseValue < 50) || finalTotal === 100;

        let resultText = '';
        let obsEvent = 'normal';
        let embedColor = 0x228B22;

        if (finalTotal === 1) {
            resultText = '**CRITICAL SUCCESS (01)**';
            embedColor = 0xFFD700;
            obsEvent = 'crit';
        } else if (isFumble) {
            resultText = '**FUMBLE**';
            embedColor = 0x8B0000;
            obsEvent = 'fail';
        } else if (finalTotal <= extremeValue) {
            resultText = '**EXTREME SUCCESS**';
            embedColor = 0x00BFFF;
        } else if (finalTotal <= goodValue) {
            resultText = '**HARD SUCCESS**';
            embedColor = 0x32CD32;
        } else if (finalTotal <= baseValue) {
            resultText = '**REGULAR SUCCESS**';
        } else {
            resultText = '**FAILURE**';
            embedColor = 0xFF0000;
        }

        const nameForOBS = characterNameCache[characterSheet] || characterSheet.replace(/Character Sheet \d+ \(/, '').replace(/\)/, '');
        const cleanStatus = resultText.replace(/[*_~`]/g, '');
        const advantagePlainLabel = advantage === 'ADV' ? 'Advantage' : (advantage === 'DIS' ? 'Disadvantage' : '');
        const obsText = `Rolled ${finalTotal} on ${skillName} (Target: ${baseValue}) ➔ ${cleanStatus}`;

        broadcastEvent({
            type: 'command',
            player: nameForOBS,
            skill: skillName,
            target: baseValue,
            value: finalTotal,
            status: cleanStatus,
            advantage: advantagePlainLabel,
            result: obsText,
            event: obsEvent
        });

        const advantageLabel = advantage === 'ADV' ? ' *(Advantage)*' : (advantage === 'DIS' ? ' *(Disadvantage)*' : '');
        const embed = new EmbedBuilder()
            .setTitle(`${nameForOBS} rolled ${skillName}`)
            .setDescription(`**Target:** ${baseValue}  |  Hard: ${goodValue}  |  Extreme: ${extremeValue}`)
            .addFields(
                { name: `Roll${advantageLabel}`, value: `Tens digit(s): [${tensRolls.map(d => d + '0').join(', ')}] \nOnes digit: [${onesDigit}] \n**Result: ${finalTotal}**` },
                { name: 'Status', value: resultText }
            )
            .setColor(embedColor);

        await interaction.reply({ embeds: [embed] });
    }
});

client.login(process.env.DISCORD_TOKEN);
