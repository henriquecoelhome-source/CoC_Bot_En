require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const WebSocket = require('ws');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// WebSocket server for the OBS overlay. Every roll (/roll or picked up
// from the "rollem" bot) gets relayed here in real time.
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });
console.log(`WebSocket server started — listening for overlay connections on port ${PORT}.`);

// Small in-memory buffer so a reconnecting overlay (browser source reload,
// network hiccup, etc.) doesn't miss whatever happened while it was down.
const HISTORY_BUFFER_MAX = 6; // matches maxMessages on the overlay side
let eventHistoryBuffer = [];

function broadcastEvent(event) {
    eventHistoryBuffer.push(event);
    if (eventHistoryBuffer.length > HISTORY_BUFFER_MAX) eventHistoryBuffer.shift();

    wss.clients.forEach(wsClient => {
        if (wsClient.readyState === WebSocket.OPEN) {
            wsClient.send(JSON.stringify(event));
        }
    });

    // Fire-and-forget write to the spreadsheet history. No await — don't
    // want a slow Sheets call blocking the overlay broadcast or the
    // Discord reply. Errors just get logged.
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

// Sheets auth uses a Service Account (not just an API key) since we need
// write access now for registrations. Creds come from env vars — see
// README for how to generate them and share the sheet with the account.
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);

const userCharacters = {};     // Discord user ID -> linked character sheet tab
const characterCache = {};     // attributes/skills already read from each sheet
const characterNameCache = {}; // character name pulled from the sheet itself

// --- Registration persistence (/register) ---------------------------
// userCharacters used to be RAM-only, so every restart/redeploy wiped it
// (Render's disk is ephemeral too). Now it's backed by a "Registrations"
// tab so it survives crashes and redeploys.
//
// Heads up: this build uses its own tab/column names, separate from the
// Portuguese production build ("Registros" / "Rolagens"). If pointing
// this at a spreadsheet that build already wrote to, switch
// REGISTRATIONS_SHEET_TITLE / ROLL_HISTORY_SHEET_TITLE back to those
// names first, or you'll just create new empty tabs.
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

// --- Persistent roll history ("Rolls" tab) ---------------------------
// Different thing from eventHistoryBuffer above — that's just 6 items
// for overlay reconnects and dies on restart. This is the full history,
// one row per roll, so it survives restarts/crashes/redeploys.
//
// We only keep the last ROLL_HISTORY_MAX rows, cleaned up in batches of
// ROLL_HISTORY_CLEANUP_BATCH instead of trimming on every single roll —
// Sheets has a requests/min quota and that adds up fast at a busy table.
// The tab can sit a bit above the limit between cleanups, which is fine.
const ROLL_HISTORY_SHEET_TITLE = 'Rolls';
const ROLL_HISTORY_MAX = 1000; // lower this if the spreadsheet gets too heavy
const ROLL_HISTORY_CLEANUP_BATCH = 50;

let rollHistoryRowCount = 0; // kept in memory so we don't re-read the sheet every roll

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

// Reads the row count once at startup, then it's just tracked in memory
// from there (incremented on write, decremented on cleanup).
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

// Deletes the oldest overflow in one batch once we're past MAX + BATCH.
// Oldest rows are always at the top, right below the header. Deletes
// back-to-front within the batch so row indices don't shift under us
// mid-loop.
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

// Writes one row per event — handles both /roll (skill/target/status as
// separate fields) and raw Rollem captures (just the original text).
// Called without await from broadcastEvent, so failures here never block
// a roll, just get logged.
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

// Rebuilds an event object from a "Rolls" row, used to repopulate
// eventHistoryBuffer on startup so the overlay isn't blank right after a
// restart. Skill column present = it was a /roll; empty = Rollem capture.
function eventFromHistoryRow(row) {
    const player = row.get('Player') || '';
    const skill = row.get('Skill') || '';
    const target = row.get('Target');
    const result = row.get('Result') || '';
    const status = row.get('Status') || '';

    if (skill) {
        // For /roll rows, Status holds the raw text ("CRITICAL SUCCESS (01)",
        // "FUMBLE", "...SUCCESS") rather than crit/fail directly, so we
        // infer the event type from it.
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

    // Rollem rows store Status as 'Critical' / 'Fumble' / '' directly.
    let event = 'normal';
    if (status === 'Critical') event = 'crit';
    else if (status === 'Fumble') event = 'fail';

    return { type: 'rollem', player, result, event };
}

// Pulls the last HISTORY_BUFFER_MAX rolls straight from the sheet at
// startup (using the row count we already have, so no full re-read).
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
 * Reads a character sheet tab and pulls attributes, skills, Luck, Sanity
 * and the character's name into characterCache / characterNameCache.
 * Matches by text pattern (labels, "%") instead of fixed cell position,
 * so it tolerates small layout differences between sheets.
 */
async function syncCharacter(sheetTitle) {
    try {
        const sheet = doc.sheetsByTitle[sheetTitle];
        if (!sheet) return false;

        await sheet.loadCells('A1:R100');
        const stats = {};

        // "Current Sanity" lives at a fixed cell on this template (M8).
        const sanityCell = sheet.getCell(7, 12);
        if (typeof sanityCell.value === 'number') {
            stats['Sanity'] = sanityCell.value;
        }

        // Skills look like "Name (xx%)" — "Fighting (Brawl) (25%)",
        // "Psychology (10%)", "Dodge (half DEX%)".
        const skillPatternTest = /\([^()]*%[^()]*\)/;
        const skillPatternStrip = /\([^()]*%[^()]*\)/g;

        // Attributes: exact match on STR/DEX/INT/CON/APP/POW/SIZ/EDU, per
        // this template (Ficha_CoC_en.xlsx). Adjust if your sheet uses
        // different abbreviations.
        const attributePattern = /^(STR|DEX|INT|CON|APP|POW|SIZ|EDU)$/i;

        for (let r = 0; r < 100; r++) {
            for (let c = 0; c < 16; c++) {
                const cell = sheet.getCell(r, c);
                if (typeof cell.value !== 'string') continue;

                const cellText = cell.value.replace(/\n/g, ' ').trim();
                if (!cellText) continue;

                // "Name:" label with the value in a merged cell to the
                // right — try a few offsets until something's there.
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
                        // Value's usually 2 cols right (merged cell in
                        // between); fall back to 1 col if not found.
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

                // Attributes
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

                // Sanity: "Sanity" is just the section title, the actual
                // value is under a "Current" label a couple rows below.
                // "Current" also shows up under HP/MP, hence the narrow
                // search radius.
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

    // Restore user -> character links and re-sync each sheet involved, so
    // /roll works right away without anyone re-running /register.
    await loadRegistrations();
    const sheetsToResync = new Set(Object.values(userCharacters));
    for (const sheetTitle of sheetsToResync) {
        const ok = await syncCharacter(sheetTitle);
        console.log(ok ? `Character sheet "${sheetTitle}" re-synced.` : `Failed to re-sync "${sheetTitle}".`);
    }

    await initRollHistoryRowCount();
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

// --- Source 1: watching rolls from the "rollem" bot -------------------
client.on('messageCreate', async (message) => {
  // 'rollem' is that bot's actual Discord username — don't translate it,
  // it has to match literally.
  if (message.author.username !== 'rollem') return;

  let player = "Investigator";
  if (message.reference && message.reference.messageId) {
    try {
      const originalMessage = await message.channel.messages.fetch(message.reference.messageId);
      let member = originalMessage.member;

      // Cached message might not have the member attached — fetch it
      // from the guild directly so we get the server nickname instead of
      // falling back to the raw username.
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

// --- Source 2: slash commands (/register and /roll) -------------------
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
