// The Discord side: a bot that talks to exactly one person, the owner, in a
// direct message. Messages from anyone else, and anything outside that DM,
// are ignored. Buttons carry one-time ids from ActionBook; a click from
// anyone but the owner is refused.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from 'discord.js';
import { buttonLabel } from './actions.mjs';
import { chunk } from './schedule.mjs';

function buttonStyle(action) {
  if (action === 'container.stop') return ButtonStyle.Danger;
  if (action.startsWith('watch.')) return ButtonStyle.Success;
  return ButtonStyle.Primary;
}

export function buttonRows(offers) {
  if (!offers.length) return [];
  const row = new ActionRowBuilder();
  for (const o of offers) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`fix:${o.id}`)
        .setLabel(buttonLabel(o))
        .setStyle(buttonStyle(o.action)),
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`skip:${offers.map((o) => o.id).join('.')}`)
      .setLabel('Not now')
      .setStyle(ButtonStyle.Secondary),
  );
  return [row];
}

// The buttons left after a click: the clicked one goes; "Not now" clears the
// row; a row with no fix buttons left is dropped with its "Not now".
export function remainingRows(rows, clickedId) {
  if (clickedId.startsWith('skip:')) return [];
  const out = [];
  for (const row of rows) {
    const comps = row.components
      .filter((c) => c.customId !== clickedId)
      .map((c) => ButtonBuilder.from(c));
    if (comps.some((c) => String(c.data.custom_id).startsWith('fix:'))) {
      out.push(new ActionRowBuilder().addComponents(...comps));
    }
  }
  return out;
}

export async function startDiscord(cfg, handlers) {
  const client = new Client({
    intents: [GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel],
  });

  let dm = null;
  async function ownerDm() {
    if (!dm) {
      const user = await client.users.fetch(cfg.owner);
      dm = await user.createDM();
    }
    return dm;
  }

  async function send(text, offers = []) {
    const channel = await ownerDm();
    const parts = chunk(text || '(empty)');
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      await channel.send({ content: parts[i], components: last ? buttonRows(offers) : [], allowedMentions: { parse: [] } });
    }
  }

  async function typing() {
    try {
      const channel = await ownerDm();
      await channel.sendTyping();
    } catch {
      // Cosmetic only.
    }
  }

  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot || msg.author.id !== cfg.owner) return;
    if (msg.channel.type !== ChannelType.DM) return;
    try {
      await handlers.onText(msg.content ?? '');
    } catch (err) {
      console.error(`unraid-watch: message handler failed: ${err.stack ?? err}`);
      await send(`Something went wrong on my side: ${String(err.message ?? err).slice(0, 300)}`).catch(() => {});
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    if (interaction.user.id !== cfg.owner) {
      await interaction.reply({ content: 'Not authorized.', ephemeral: true }).catch(() => {});
      return;
    }
    const [kind, payload = ''] = interaction.customId.split(':');
    // Remove the clicked button (or, for "Not now", all of them) right away,
    // so nothing can be clicked twice while the command runs.
    await interaction.update({ components: remainingRows(interaction.message.components, interaction.customId) }).catch(() => {});
    try {
      if (kind === 'fix') {
        const result = await handlers.onFix(payload, interaction.user.tag);
        await interaction.followUp({ content: `${result.ok ? '✅' : '⚠️'} ${result.message}` });
      } else if (kind === 'skip') {
        handlers.onSkip(payload.split('.'));
        await interaction.followUp({ content: 'OK, leaving it. Nothing was changed.' });
      }
    } catch (err) {
      console.error(`unraid-watch: button handler failed: ${err.stack ?? err}`);
      await interaction.followUp({ content: `Something went wrong: ${String(err.message ?? err).slice(0, 300)}` }).catch(() => {});
    }
  });

  client.on(Events.Error, (err) => console.error(`unraid-watch: discord error: ${err.message ?? err}`));

  const ready = new Promise((resolve) => client.once(Events.ClientReady, resolve));
  await client.login(cfg.token);
  await ready;
  console.log(`unraid-watch: connected to Discord as ${client.user.tag}`);
  return { send, typing, client };
}
