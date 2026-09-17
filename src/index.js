import { Client, GatewayIntentBits, Events, ChannelType } from 'discord.js';
import { config } from './config.js';
import { log } from './log.js';
import { Session } from './pipeline.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
});

/** channelId -> Session (one live session per Stage channel) */
const sessions = new Map();

function watched(channel) {
  if (!channel || channel.guildId !== config.discord.guildId) return false;
  if (config.discord.stageChannelId && channel.id !== config.discord.stageChannelId) return false;
  return true;
}

async function startSession(channel, topic) {
  if (sessions.has(channel.id)) return sessions.get(channel.id);
  const session = new Session(client, channel, topic);
  sessions.set(channel.id, session);
  try {
    await session.start();
  } catch (err) {
    log.error('Session start failed:', err.message);
    sessions.delete(channel.id);
  }
  return session;
}

async function endSession(channelId) {
  const session = sessions.get(channelId);
  if (!session) return null;
  sessions.delete(channelId);
  try {
    return await session.stop();
  } catch (err) {
    log.error('Session processing failed:', err.message);
    return null;
  }
}

// --- Automatic: a Stage is started / ended in Discord ---------------------------
client.on(Events.StageInstanceCreate, async (stage) => {
  const channel = stage.channel ?? (await client.channels.fetch(stage.channelId));
  if (!watched(channel)) return;
  await startSession(channel, stage.topic);
});

client.on(Events.StageInstanceDelete, async (stage) => {
  if (stage.guildId !== config.discord.guildId) return;
  await endSession(stage.channelId);
});

// --- Manual: /record start|stop|status ------------------------------------------
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== 'record') return;
  const sub = i.options.getSubcommand();

  if (sub === 'status') {
    const live = [...sessions.values()].map((s) => `• ${s.topic} (since ${s.startedAt.toLocaleTimeString()})`);
    return i.reply({ content: live.length ? `Recording:\n${live.join('\n')}` : 'Not recording.', ephemeral: true });
  }

  const channel = i.options.getChannel('channel') ?? i.member?.voice?.channel;
  if (!channel || ![ChannelType.GuildStageVoice, ChannelType.GuildVoice].includes(channel.type)) {
    return i.reply({ content: 'Join a Stage/voice channel first, or pass one with the `channel` option.', ephemeral: true });
  }

  if (sub === 'start') {
    await i.reply({ content: `Starting recording in **${channel.name}**…`, ephemeral: true });
    await startSession(channel, i.options.getString('topic') ?? channel.name);
  } else if (sub === 'stop') {
    if (!sessions.has(channel.id)) return i.reply({ content: 'Nothing is recording there.', ephemeral: true });
    await i.reply({ content: 'Stopping and processing…', ephemeral: true });
    await endSession(channel.id);
  }
});

client.once(Events.ClientReady, (c) => {
  log.info(`Logged in as ${c.user.tag}. Watching for Stages in guild ${config.discord.guildId}.`);
});

// Stop cleanly on Ctrl+C so OBS isn't left recording.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log.info(`${sig} received; stopping ${sessions.size} session(s)…`);
    await Promise.all([...sessions.keys()].map(endSession));
    client.destroy();
    process.exit(0);
  });
}

client.login(config.discord.token);
