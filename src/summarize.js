// Turns the labeled transcript into a Q&A summary document (Markdown) with Claude.
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { log } from './log.js';

const SYSTEM = `You write clear, useful session recaps for a climbing/bouldering coaching community.
You are given a timestamped, speaker-labeled transcript of a live Q&A held on Discord.
The coach is ${config.coachName}; other speakers are community members/clients.
Write in plain, friendly language. Keep the coach's actual advice faithful — do not invent claims.
If a question had no clear answer, say so. Use the speakers' display names as given.`;

function prompt({ title, dateStr, transcriptText }) {
  return `Session: ${title}
Date: ${dateStr}

Produce a Markdown document with exactly these sections:

# ${title}
_${dateStr}_

## TL;DR
3–5 bullets with the most important takeaways.

## Questions & Answers
One subsection per distinct question, in the order asked:
### Q: <the question, cleaned up>
**Asked by:** <name> · **At:** <mm:ss timestamp>
**Answer:** <2–6 sentence faithful summary of the coach's answer, including specific cues, numbers, drills or protocols mentioned>

## Key Takeaways & Drills
Bullet list of concrete, actionable advice (drills, cues, programming rules of thumb) mentioned anywhere in the session.

## Follow-ups
Anything the coach promised to share/do later, or open questions. Write "None" if there are none.

Transcript:
<transcript>
${transcriptText}
</transcript>`;
}

export async function summarize({ title, dateStr, transcriptText }) {
  if (!config.anthropic.apiKey) {
    log.warn('ANTHROPIC_API_KEY not set; skipping summary');
    return null;
  }
  const client = new Anthropic({ apiKey: config.anthropic.apiKey });
  log.info('Summarizing transcript with', config.anthropic.model);
  const res = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt({ title, dateStr, transcriptText }) }],
  });
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}
