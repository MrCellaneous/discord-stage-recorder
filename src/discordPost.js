// Posts the results (links + transcript + summary) to the Discord text channel.
import fs from 'node:fs';
import path from 'node:path';
import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { config } from './config.js';
import { log } from './log.js';

const DISCORD_ATTACH_LIMIT = 10 * 1024 * 1024; // safe default for non-boosted servers

export async function postResults(client, {
  title, dateStr, durationStr, youtubeUrl, drive, videoPath, transcriptPath, summaryPath, summaryText, speakers,
}) {
  const channel = await client.channels.fetch(config.discord.postChannelId);
  const embed = new EmbedBuilder()
    .setTitle(`🎙️ ${title}`)
    .setDescription(`Recording and notes from the Stage on ${dateStr} (${durationStr}).`)
    .setColor(0x5865f2)
    .setTimestamp(new Date());

  if (youtubeUrl) embed.addFields({ name: 'YouTube', value: youtubeUrl, inline: false });
  if (drive?.folderUrl) embed.addFields({ name: 'Google Drive', value: `[Session folder](${drive.folderUrl})`, inline: false });
  if (drive?.links) {
    const docLink = Object.entries(drive.links).find(([n]) => /summary/i.test(n))?.[1];
    if (docLink) embed.addFields({ name: 'Summary (Google Doc)', value: docLink, inline: false });
  }
  if (speakers?.length) embed.addFields({ name: 'Speakers', value: speakers.join(', ').slice(0, 1024), inline: false });

  const files = [];
  for (const p of [summaryPath, transcriptPath]) {
    if (p && fs.existsSync(p) && fs.statSync(p).size <= DISCORD_ATTACH_LIMIT) files.push(new AttachmentBuilder(p));
  }
  if (videoPath && fs.existsSync(videoPath) && fs.statSync(videoPath).size <= DISCORD_ATTACH_LIMIT) {
    files.push(new AttachmentBuilder(videoPath));
  } else if (videoPath && !youtubeUrl && !drive?.folderUrl) {
    embed.addFields({ name: 'Video', value: `Too large for Discord; saved locally at \`${path.basename(videoPath)}\`` });
  }

  const msg = await channel.send({ embeds: [embed], files });

  // Post the TL;DR inline so people don't have to open the file.
  if (summaryText) {
    const tldr = summaryText.match(/## TL;DR\s*([\s\S]*?)(?=\n## |$)/)?.[1]?.trim();
    if (tldr) {
      await channel.send({ content: `**TL;DR**\n${tldr}`.slice(0, 2000), reply: { messageReference: msg.id } });
    }
  }
  log.info('Posted results to Discord');
  return msg;
}

export async function postStatus(client, text) {
  try {
    const channel = await client.channels.fetch(config.discord.postChannelId);
    await channel.send({ content: text });
  } catch (err) {
    log.warn('Could not post status:', err.message);
  }
}
