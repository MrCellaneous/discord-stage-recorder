// Registers the /record slash command on your server. Run once: npm run register
import { REST, Routes, SlashCommandBuilder, ChannelType } from 'discord.js';
import { config } from '../src/config.js';

if (!config.discord.clientId) throw new Error('Set DISCORD_CLIENT_ID in .env');

const cmd = new SlashCommandBuilder()
  .setName('record')
  .setDescription('Manually control Stage recording')
  .addSubcommand((s) => s.setName('start').setDescription('Start recording')
    .addStringOption((o) => o.setName('topic').setDescription('Session title'))
    .addChannelOption((o) => o.setName('channel').setDescription('Stage/voice channel').addChannelTypes(ChannelType.GuildStageVoice, ChannelType.GuildVoice)))
  .addSubcommand((s) => s.setName('stop').setDescription('Stop recording and publish')
    .addChannelOption((o) => o.setName('channel').setDescription('Stage/voice channel').addChannelTypes(ChannelType.GuildStageVoice, ChannelType.GuildVoice)))
  .addSubcommand((s) => s.setName('status').setDescription('Show what is recording'));

const rest = new REST().setToken(config.discord.token);
await rest.put(Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId), { body: [cmd.toJSON()] });
console.log('Registered /record on guild', config.discord.guildId);
