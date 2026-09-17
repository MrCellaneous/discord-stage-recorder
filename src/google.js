// YouTube + Google Drive uploads using one OAuth2 desktop-app client.
// Run `npm run google-auth` once to create google-token.json.
import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import { config } from './config.js';
import { log } from './log.js';

export const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/drive.file',
];

export function oauthClient() {
  const { clientId, clientSecret } = config.google;
  if (!clientId || !clientSecret) return null;
  return new google.auth.OAuth2(clientId, clientSecret, 'http://127.0.0.1:53682/oauth2callback');
}

function authedClient() {
  const client = oauthClient();
  if (!client || !fs.existsSync(config.google.tokenPath)) {
    log.warn('Google not configured (missing client id/secret or token). Skipping Google uploads.');
    return null;
  }
  client.setCredentials(JSON.parse(fs.readFileSync(config.google.tokenPath, 'utf8')));
  client.on('tokens', (t) => {
    if (t.refresh_token) {
      fs.writeFileSync(config.google.tokenPath, JSON.stringify({ ...client.credentials, ...t }, null, 2));
    }
  });
  return client;
}

/** Uploads a video to YouTube; returns the watch URL or null. */
export async function uploadToYouTube({ videoPath, title, description }) {
  const auth = authedClient();
  if (!auth || !videoPath) return null;
  const yt = google.youtube({ version: 'v3', auth });
  const size = fs.statSync(videoPath).size;
  log.info(`Uploading to YouTube (${(size / 1e6).toFixed(0)} MB)...`);
  const res = await yt.videos.insert(
    {
      part: ['snippet', 'status'],
      requestBody: {
        snippet: { title: title.slice(0, 100), description: description.slice(0, 5000), categoryId: '17' /* Sports */ },
        status: { privacyStatus: config.google.youtubePrivacy, selfDeclaredMadeForKids: false },
      },
      media: { body: fs.createReadStream(videoPath) },
    },
    { maxContentLength: Infinity, maxBodyLength: Infinity },
  );
  const url = `https://youtu.be/${res.data.id}`;
  log.info('YouTube upload done:', url);
  return url;
}

/**
 * Uploads files to Drive. `files` = [{ path, name, mimeType, convertToDoc }].
 * Returns { folderUrl, links: { name: url } }.
 */
export async function uploadToDrive({ folderName, files }) {
  const auth = authedClient();
  if (!auth) return null;
  const drive = google.drive({ version: 'v3', auth });

  const folder = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: config.google.driveFolderId ? [config.google.driveFolderId] : undefined,
    },
    fields: 'id, webViewLink',
  });
  const folderId = folder.data.id;
  const links = {};

  for (const f of files) {
    if (!f.path || !fs.existsSync(f.path)) continue;
    log.info(`Uploading ${path.basename(f.path)} to Drive...`);
    const res = await drive.files.create(
      {
        requestBody: {
          name: f.name || path.basename(f.path),
          parents: [folderId],
          // Markdown/plain text can be converted to a native Google Doc on upload.
          mimeType: f.convertToDoc ? 'application/vnd.google-apps.document' : undefined,
        },
        media: { mimeType: f.mimeType || 'application/octet-stream', body: fs.createReadStream(f.path) },
        fields: 'id, webViewLink',
      },
      { maxContentLength: Infinity, maxBodyLength: Infinity },
    );
    links[f.name || path.basename(f.path)] = res.data.webViewLink;
  }
  log.info('Drive upload done:', folder.data.webViewLink);
  return { folderUrl: folder.data.webViewLink, links };
}
