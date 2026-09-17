// One-time Google OAuth: opens a browser, stores a refresh token in google-token.json.
import http from 'node:http';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { oauthClient, SCOPES } from '../src/google.js';
import { config } from '../src/config.js';

const client = oauthClient();
if (!client) throw new Error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first');

const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1:53682');
  if (u.pathname !== '/oauth2callback') return res.end();
  const code = u.searchParams.get('code');
  try {
    const { tokens } = await client.getToken(code);
    fs.writeFileSync(config.google.tokenPath, JSON.stringify(tokens, null, 2));
    res.end('Authorized! You can close this tab.');
    console.log('Saved token to', config.google.tokenPath);
  } catch (err) {
    res.end('Failed: ' + err.message);
    console.error(err);
  } finally {
    server.close();
  }
});
server.listen(53682, '127.0.0.1', () => {
  console.log('Opening browser for Google sign-in…\nIf it does not open, visit:\n' + url);
  execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => {});
});
